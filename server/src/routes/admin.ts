// Admin dashboard API (web, /admin/). Admin accounts are separate from workers.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { HttpError, normalizePhone, parse, sha256 } from '../http.js';
import { issueInvite } from '../invites.js';
import { adminBearer, checkPassword, createAdminSession, hashPassword, requireAdmin, requireEditor, requireOwner } from '../admin-auth.js';
import { appendTimeline, createAlert, RULE_DEFAULTS, siteRules, type AlertStatus, type AlertType } from '../alerts.js';
import { DAY, dateLabel, hm, shortDate, siteWorkers } from '../admin-data.js';
import { buckets, dayStart, exposurePercent, levelOf, localParts, WEEKDAYS, zoneDurations, type Sample } from '../exposure.js';
import { samples, tz } from '../queries.js';
import { pushToWorkers } from '../notify.js';

const STATUS_LABEL: Record<AlertStatus, string> = { open: '대기', acked: '확인됨', resolved: '처리 완료', auto: '자동 해결', info: '정보' };
const TYPE_LABEL: Record<AlertType, string> = { caution: '주의', danger: '위험', sos: 'SOS', sensor: '센서', advice: '주의', notice: '공지' };

const idParam = z.object({ id: z.coerce.number().int().positive() });
const siteParam = z.object({ siteId: z.coerce.number().int().positive() });

async function siteOr404(siteId: number) {
  const s = await one<{ id: number; name: string; facility: string | null; address: string | null; status: string; pm25_limit: number; co_limit: number; shifts: { name: string; start: string; end: string }[] }>(
    'select id, name, facility, address, status, pm25_limit, co_limit, shifts from sites where id = $1',
    [siteId],
  );
  if (!s) throw new HttpError(404, 'not_found', '현장을 찾을 수 없어요.');
  return s;
}

async function workerSite(workerId: number) {
  const w = await one<{ site_id: number }>('select site_id from workers where id = $1', [workerId]);
  if (!w) throw new HttpError(404, 'not_found', '작업자를 찾을 수 없어요.');
  return w.site_id;
}

const pgDup = (e: unknown, what: string) => {
  if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'duplicate', `이미 등록된 ${what}예요.`);
  throw e;
};

export async function adminRoutes(app: FastifyInstance) {
  // ---- auth ---------------------------------------------------------------------
  app.post(
    '/api/admin/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes', hook: 'preHandler', keyGenerator: (req) => `admin-login:${req.ip}` } } },
    async (req) => {
      const { username, password, remember } = parse(
        z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(200), remember: z.boolean().default(true) }),
        req.body,
      );
      const a = await checkPassword(username, password);
      if (!a) throw new HttpError(400, 'invalid_login', '아이디 또는 비밀번호가 맞지 않아요.');
      const token = await createAdminSession(a.id, remember);
      return { token, admin: { id: a.id, name: a.name, title: a.title, role: a.role, mustChangePassword: a.must_change_password } };
    },
  );

  app.register(async (r) => {
    r.addHook('preHandler', requireAdmin);

    r.post('/api/admin/auth/logout', async (req, reply) => {
      await q('delete from admin_sessions where token_hash = $1', [sha256(adminBearer(req))]);
      return reply.code(204).send();
    });

    r.get('/api/admin/me', async (req) => {
      const a = (await one<{ id: number; username: string; name: string; title: string | null; role: string; must_change_password: boolean }>(
        'select id, username, name, title, role, must_change_password from admins where id = $1',
        [req.admin.id],
      ))!;
      return { id: a.id, username: a.username, name: a.name, title: a.title, role: a.role, mustChangePassword: a.must_change_password };
    });

    r.post('/api/admin/me/password', async (req, reply) => {
      const { current, next } = parse(z.object({ current: z.string().min(1), next: z.string().min(8).max(200) }), req.body);
      const me = await one<{ username: string }>('select username from admins where id = $1', [req.admin.id]);
      if (!me || !(await checkPassword(me.username, current))) throw new HttpError(400, 'invalid_password', '지금 비밀번호가 맞지 않아요.');
      await q('update admins set password_hash = $2, must_change_password = false where id = $1', [req.admin.id, await hashPassword(next)]);
      // sign out other browsers
      await q('delete from admin_sessions where admin_id = $1 and token_hash <> $2', [req.admin.id, sha256(adminBearer(req))]);
      return reply.code(204).send();
    });

    // ---- sites ---------------------------------------------------------------------
    r.get('/api/admin/sites', async () => {
      const sites = await q<{ id: number; name: string; facility: string | null; status: string; zones: string | null }>(
        `select s.id, s.name, s.facility, s.status,
                (select string_agg(z.name, ' · ' order by z.id) from zones z where z.site_id = s.id and not z.is_rest) as zones
           from sites s order by s.status, s.id`,
      );
      const out = [];
      for (const s of sites) {
        const ws = s.status === 'active' ? await siteWorkers(s.id) : [];
        const working = ws.filter((w) => w.pm10 != null);
        const withSensor = ws.filter((w) => w.sensorId && w.readToday);
        out.push({
          id: s.id,
          name: s.name,
          facility: s.facility,
          zones: s.zones,
          status: s.status,
          working: working.length,
          sensorsOnline: withSensor.filter((w) => w.pm10 != null).length,
          sensorsTotal: withSensor.length,
          caution: ws.filter((w) => w.state === 'caution').length,
          danger: ws.filter((w) => w.state === 'danger').length,
        });
      }
      return out;
    });

    // ---- overview (관제 홈) ------------------------------------------------------------
    r.get('/api/admin/sites/:siteId/overview', async (req) => {
      const { siteId } = parse(siteParam, req.params);
      const site = await siteOr404(siteId);
      const now = Date.now();
      const today = dayStart(now, tz());
      const ws = (await siteWorkers(siteId)).filter((w) => w.readToday);
      const working = ws.filter((w) => w.pm10 != null);
      const caution = ws.filter((w) => w.state === 'caution');
      const danger = ws.filter((w) => w.state === 'danger');
      const off = ws.filter((w) => w.state === 'off');
      const zones = await q<{ id: number; name: string; is_rest: boolean; lim: number }>(
        'select id, name, is_rest, pm10_limit as lim from zones where site_id = $1 order by id',
        [siteId],
      );
      const dangerToday = await one<{ n: number; open: number }>(
        `select count(*)::int as n, count(*) filter (where status in ('open', 'acked'))::int as open
           from alerts where site_id = $1 and type in ('danger', 'sos') and created_at >= $2`,
        [siteId, new Date(today)],
      );
      const shiftCount = new Map<string, number>();
      for (const w of working) if (w.shiftName) shiftCount.set(`${w.shiftName} · ${w.shiftStart}–${w.shiftEnd}`, (shiftCount.get(`${w.shiftName} · ${w.shiftStart}–${w.shiftEnd}`) ?? 0) + 1);
      const shiftLabel = [...shiftCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '근무 중인 작업자 없음';
      const zoneOf = (list: typeof ws) => [...new Set(list.map((w) => w.zone).filter(Boolean))];
      const avg = working.length ? Math.round(working.reduce((a, w) => a + (w.pm10 ?? 0), 0) / working.length) : null;
      const recent = await recentAlerts(siteId, 4);
      return {
        siteName: site.name,
        facility: site.facility,
        dateLabel: dateLabel(now),
        time: hm(now),
        kpis: {
          working: working.length,
          shiftLabel,
          caution: caution.length,
          cautionNote: caution.length ? `${zoneOf(caution).length === 1 ? `모두 ${zoneOf(caution)[0]}` : zoneOf(caution).join(' · ')} · 누적 또는 지금 80% 이상` : '없어요',
          danger: danger.length,
          dangerNote: dangerToday!.n ? `오늘 ${dangerToday!.n}건 · ${dangerToday!.open ? `${dangerToday!.open}건 처리 중` : '처리 완료'}` : '오늘 없어요',
          avgPm10: avg,
          limit: zones.find((z) => !z.is_rest)?.lim ?? 100,
          sensorsOnline: working.length,
          sensorsTotal: ws.filter((w) => w.sensorId).length,
          sensorsNote: off.length ? `${off.length}대 끊김 · ${zoneOf(off).join(' · ')}` : '모두 연결됨',
        },
        zones: zones
          .filter((z) => !z.is_rest)
          .map((z) => {
            const inZone = working.filter((w) => w.zoneId === z.id);
            const a = inZone.length ? Math.round(inZone.reduce((s, w) => s + (w.pm10 ?? 0), 0) / inZone.length) : null;
            return { id: z.id, name: z.name, avg: a, workers: inZone.length, level: a == null ? 'safe' : levelOf(a, z.lim) };
          }),
        restCount: working.filter((w) => w.zoneRest).length,
        workers: ws
          .sort((a, b) => b.cum - a.cum)
          .map((w) => ({ id: w.id, name: w.name, employeeNo: w.employeeNo, zone: w.zone, x: w.x, y: w.y, pm10: w.pm10, cum: w.cum, state: w.state, battery: w.battery })),
        alerts: recent,
      };
    });

    // ---- workers ----------------------------------------------------------------------
    r.get('/api/admin/sites/:siteId/workers', async (req) => {
      const { siteId } = parse(siteParam, req.params);
      await siteOr404(siteId);
      const ws = await siteWorkers(siteId);
      const now = Date.now();
      return ws.map((w) => {
        const conn = !w.loggedIn ? 'pending' : w.lastSeen && now - w.lastSeen < 10 * 60_000 ? 'on' : 'off';
        return {
          id: w.id,
          name: w.name,
          employeeNo: w.employeeNo,
          phone: w.phone,
          org: [w.company, w.team].filter(Boolean).join(' · '),
          zone: w.zone,
          shift: w.shiftName,
          conn,
          inviteExpiresAt: w.inviteExpiresAt,
          sensor: w.sensorId,
        };
      });
    });

    r.get('/api/admin/sites/:siteId/form-options', async (req) => {
      const { siteId } = parse(siteParam, req.params);
      const site = await siteOr404(siteId);
      const zones = await q<{ id: number; name: string }>('select id, name from zones where site_id = $1 and not is_rest order by id', [siteId]);
      const orgs = await q<{ company: string; team: string | null }>(
        `select distinct company, team from workers where site_id = $1 and company is not null order by company, team`,
        [siteId],
      );
      return { zones, orgs: orgs.map((o) => [o.company, o.team].filter(Boolean).join(' · ')), shifts: site.shifts };
    });

    r.post('/api/admin/sites/:siteId/workers', { preHandler: requireEditor }, async (req) => {
      const { siteId } = parse(siteParam, req.params);
      const site = await siteOr404(siteId);
      const b = parse(
        z.object({
          name: z.string().trim().min(1).max(40),
          employeeNo: z.string().trim().min(1).max(40),
          phone: z.string().transform(normalizePhone).pipe(z.string().regex(/^01\d{8,9}$/)),
          org: z.string().trim().max(80).optional(),
          zoneIds: z.array(z.number().int().positive()).max(10).default([]),
          shift: z.string().trim().max(40).optional(),
        }),
        req.body,
      );
      const [company, ...teamParts] = (b.org ?? '').split(' · ');
      const shift = site.shifts.find((s) => s.name === b.shift);
      const zoneRows = await q<{ id: number }>('select id from zones where site_id = $1 and id = any($2)', [siteId, b.zoneIds]);
      const zoneIds = zoneRows.map((z) => z.id);
      const id = await tx(async (c) =>
        (await c.query<{ id: number }>(
          `insert into workers (site_id, employee_no, name, phone, company, team, shift_name, shift_start, shift_end, assigned_zone_ids, current_zone_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [siteId, b.employeeNo, b.name, b.phone, company || null, teamParts.join(' · ') || null, shift?.name ?? null, shift?.start ?? null, shift?.end ?? null, zoneIds, zoneIds[0] ?? null],
        )).rows[0].id,
      ).catch((e) => pgDup(e, '사번 또는 휴대폰 번호'));
      const invite = await issueInvite(id, null);
      return { worker: { id, name: b.name, employeeNo: b.employeeNo }, invite };
    });

    r.post('/api/admin/workers/:id/invite', { preHandler: requireEditor }, async (req) => {
      const { id } = parse(idParam, req.params);
      await workerSite(id);
      return issueInvite(id, null);
    });

    r.patch('/api/admin/workers/:id', { preHandler: requireEditor }, async (req) => {
      const { id } = parse(idParam, req.params);
      await workerSite(id);
      const { active } = parse(z.object({ active: z.boolean() }), req.body);
      await q('update workers set active = $2 where id = $1', [id, active]);
      if (!active) {
        await q('delete from sessions where worker_id = $1', [id]);
        await q('update sensors set worker_id = null where worker_id = $1', [id]);
      }
      return { id, active };
    });

    r.get('/api/admin/workers/:id', async (req) => {
      const { id } = parse(idParam, req.params);
      const siteId = await workerSite(id);
      const w = (await siteWorkers(siteId, { includeInactive: true })).find((x) => x.id === id);
      if (!w) throw new HttpError(404, 'not_found', '작업자를 찾을 수 없어요.');
      const now = Date.now();
      const t = tz();
      const today = dayStart(now, t);
      const week = await samples(id, today - 6 * DAY, now);
      const todays = week.filter((s) => s.ts >= today);
      const zoneNames = new Map(
        (await q<{ id: number; name: string }>('select id, name from zones where site_id = $1', [siteId])).map((z) => [z.id, z.name]),
      );
      const firstTs = todays[0]?.ts;
      const start = firstTs ? Math.floor((firstTs - today) / 1_800_000) * 1_800_000 + today : now;
      const bars = todays.length ? buckets(todays, start, now).map((b) => ({ time: hm(b.start), avg: b.avg == null ? null : Math.round(b.avg) })) : [];
      // zone segments for the day bar
      const segs: { zone: string; from: number; to: number }[] = [];
      for (const s of todays) {
        const name = s.zoneId == null ? '–' : (zoneNames.get(s.zoneId) ?? '–');
        const last = segs.at(-1);
        if (last && last.zone === name && s.ts - last.to <= 5 * 60_000) last.to = s.ts;
        else segs.push({ zone: name, from: s.ts, to: s.ts });
      }
      const events = await q<{ ts: Date; type: string; level: string | null; title: string; detail: string | null }>(
        'select ts, type, level, title, detail from events where worker_id = $1 and ts >= $2 order by ts desc limit 50',
        [id, new Date(today)],
      );
      const days = Array.from({ length: 7 }, (_, i) => {
        const s0 = today - (6 - i) * DAY;
        const ds = week.filter((x) => x.ts >= s0 && x.ts < s0 + DAY);
        return { day: i === 6 ? '오늘' : WEEKDAYS[localParts(s0, t).weekday], percent: ds.length ? Math.round(exposurePercent(ds, Math.min(s0 + DAY, now))) : null, today: i === 6 };
      });
      const cautionDays = days.filter((d) => (d.percent ?? 0) >= 80).length;
      const measuredDays = days.filter((d) => d.percent != null).length;
      const zoneMs = [...zoneDurations(week, now)].sort((a, b) => b[1] - a[1]);
      const mainZone = zoneMs[0]?.[0] != null ? zoneNames.get(zoneMs[0][0] as number) : null;
      const sinceSeg = segs.at(-1);
      const sensor = w.sensorId
        ? await one<{ battery: number | null; calibrated_on: string | null; last_seen_at: Date | null }>('select battery, calibrated_on::text, last_seen_at from sensors where id = $1', [w.sensorId])
        : null;
      return {
        id: w.id,
        name: w.name,
        initial: w.name.slice(0, 1),
        employeeNo: w.employeeNo,
        phone: w.phone,
        org: [w.company, w.team].filter(Boolean).join(' · '),
        shift: w.shiftName ? `${w.shiftName}` : null,
        shiftTime: w.shiftStart ? `${w.shiftStart}–${w.shiftEnd}` : null,
        state: w.state,
        pm10: w.pm10,
        limit: w.limit,
        cum: w.cum,
        zone: w.zone,
        spot: w.spot,
        zoneSinceMin: sinceSeg ? Math.round((now - sinceSeg.from) / 60_000) : null,
        sensor: w.sensorId ? { id: w.sensorId, connected: w.pm10 != null, battery: sensor?.battery ?? null, lastSeen: sensor?.last_seen_at ? hm(sensor.last_seen_at) : null } : null,
        bars,
        segments: segs.map((s) => ({ zone: s.zone, from: hm(s.from), to: hm(s.to), minutes: Math.max(1, Math.round((s.to - s.from) / 60_000)) })),
        events: events.map((e) => ({ time: hm(e.ts), type: e.type, level: e.level, title: e.title, detail: e.detail })),
        week: days,
        weekNote: measuredDays ? `${measuredDays}일 중 ${cautionDays}일 주의` : '기록 없음',
        advice:
          cautionDays >= 2 || w.cum >= 80
            ? `${mainZone ?? '한 구역'}에 오래 머물러요. 노출이 낮은 구역과 오전·오후로 나눠 순환하면 누적 노출량을 낮출 수 있어요.`
            : null,
        active: true,
      };
    });

    r.post('/api/admin/workers/:id/shift-order', { preHandler: requireEditor }, async (req) => {
      const { id } = parse(idParam, req.params);
      const siteId = await workerSite(id);
      await q(`insert into events (worker_id, type, title, detail) values ($1, 'request', '교대 지시', $2)`, [id, `${req.admin.name} · 휴게 구역으로 이동해 주세요`]);
      const pushed = await pushToWorkers([id], { title: '교대 지시', body: '관리자가 교대를 지시했어요. 휴게 구역으로 이동해 주세요.', route: '#home' });
      const open = await q<{ id: number }>(
        `select id from alerts where site_id = $1 and $2 = any(worker_ids) and status in ('open', 'acked') and type in ('advice', 'caution')`,
        [siteId, id],
      );
      for (const a of open) {
        await appendTimeline(a.id, `교대 지시 · ${req.admin.name}`);
        await q(`update alerts set status = 'acked', acked_at = coalesce(acked_at, now()), acked_by = coalesce(acked_by, $2) where id = $1 and status = 'open'`, [a.id, req.admin.id]);
      }
      return { sent: true, pushed };
    });

    r.get('/api/admin/workers/:id/readings.csv', async (req, reply) => {
      const { id } = parse(idParam, req.params);
      await workerSite(id);
      const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(31).default(1) }), req.query);
      const since = dayStart(Date.now(), tz()) - (days - 1) * DAY;
      const rows = await q<{ ts: Date; zone: string | null; pm10: number; pm25: number | null; co: number | null; temp: number | null; humidity: number | null }>(
        `select r.ts, z.name as zone, r.pm10, r.pm25, r.co, r.temp, r.humidity from readings r left join zones z on z.id = r.zone_id
          where r.worker_id = $1 and r.ts >= $2 order by r.ts`,
        [id, new Date(since)],
      );
      const fmt = (d: Date) => new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Seoul' }).format(d);
      const lines = ['시각,구역,PM10,PM2.5,CO,온도,습도', ...rows.map((r) => [fmt(r.ts), r.zone ?? '', r.pm10, r.pm25 ?? '', r.co ?? '', r.temp ?? '', r.humidity ?? ''].join(','))];
      return reply.header('content-type', 'text/csv; charset=utf-8').send('﻿' + lines.join('\n'));
    });

    // ---- alerts ----------------------------------------------------------------------
    async function recentAlerts(siteId: number, limit: number, since?: number) {
      const rows = await q<{
        id: number; type: AlertType; status: AlertStatus; title: string; sub: string | null; rec: string | null;
        metrics: [string, string][]; worker_ids: number[]; timeline: [string, string][]; created_at: Date;
      }>(
        `select id, type, status, title, sub, rec, metrics, worker_ids, timeline, created_at from alerts
          where site_id = $1 ${since ? 'and created_at >= $3' : ''} order by created_at desc limit $2`,
        since ? [siteId, limit, new Date(since)] : [siteId, limit],
      );
      const ids = [...new Set(rows.flatMap((r) => r.worker_ids))];
      const names = new Map(
        ids.length ? (await q<{ id: number; name: string }>('select id, name from workers where id = any($1)', [ids])).map((w) => [w.id, w.name]) : [],
      );
      return rows.map((a) => {
        const people = a.worker_ids.map((id) => ({ id, name: names.get(id) ?? '–' }));
        const one = people.length === 1 ? people[0] : null;
        const primary =
          a.type === 'sensor'
            ? { label: '센서 보기', href: '#sensors' }
            : one
              ? { label: a.type === 'advice' ? '교대 지시' : '작업자 보기', href: `#worker-${one.id}` }
              : null;
        return {
          id: a.id,
          type: a.type,
          cat: TYPE_LABEL[a.type],
          advice: a.type === 'advice',
          status: a.status,
          statusLabel: STATUS_LABEL[a.status],
          pending: a.status === 'open' || a.status === 'acked',
          time: hm(a.created_at),
          title: a.title,
          sub: a.sub,
          rec: a.rec,
          metrics: a.metrics,
          people,
          timeline: a.timeline,
          primary,
        };
      });
    }

    r.get('/api/admin/sites/:siteId/alerts', async (req) => {
      const { siteId } = parse(siteParam, req.params);
      await siteOr404(siteId);
      const today = dayStart(Date.now(), tz());
      const list = await recentAlerts(siteId, 300, today);
      const y = await one<{ n: number; open: number }>(
        `select count(*)::int as n, count(*) filter (where status in ('open', 'acked'))::int as open
           from alerts where site_id = $1 and created_at >= $2 and created_at < $3`,
        [siteId, new Date(today - DAY), new Date(today)],
      );
      return { dateLabel: dateLabel(today), today: list, yesterday: y };
    });

    r.get('/api/admin/sites/:siteId/alerts/pending-count', async (req) => {
      const { siteId } = parse(siteParam, req.params);
      return (await one<{ n: number }>(`select count(*)::int as n from alerts where site_id = $1 and status = 'open'`, [siteId]))!;
    });

    r.post('/api/admin/alerts/:id/ack', { preHandler: requireEditor }, async (req) => {
      const { id } = parse(idParam, req.params);
      const row = await one<{ id: number }>(
        `update alerts set status = 'acked', acked_at = now(), acked_by = $2 where id = $1 and status = 'open' returning id`,
        [id, req.admin.id],
      );
      if (row) await appendTimeline(id, `${req.admin.name} 확인`);
      return { id, acked: !!row };
    });

    r.post('/api/admin/alerts/:id/resolve', { preHandler: requireEditor }, async (req) => {
      const { id } = parse(idParam, req.params);
      const row = await one<{ id: number }>(
        `update alerts set status = 'resolved', resolved_at = now(), resolved_by = $2,
                acked_at = coalesce(acked_at, now()), acked_by = coalesce(acked_by, $2)
          where id = $1 and status in ('open', 'acked') returning id`,
        [id, req.admin.id],
      );
      if (!row) throw new HttpError(404, 'not_found', '처리할 알림이 없어요.');
      await appendTimeline(id, `처리 완료 · ${req.admin.name}`);
      return { id, resolved: true };
    });

    r.post('/api/admin/sites/:siteId/notices', { preHandler: requireEditor }, async (req) => {
      const { siteId } = parse(siteParam, req.params);
      await siteOr404(siteId);
      const b = parse(z.object({ title: z.string().trim().min(1).max(80), detail: z.string().trim().max(200).optional(), hours: z.number().int().min(1).max(72).default(8) }), req.body);
      await q(`insert into notices (site_id, title, detail, starts_at, ends_at) values ($1, $2, $3, now(), now() + make_interval(hours => $4))`, [siteId, b.title, b.detail ?? null, b.hours]);
      const ws = await q<{ id: number }>(`select id from workers where site_id = $1 and active`, [siteId]);
      await createAlert({ siteId, type: 'notice', title: b.title, sub: b.detail ?? null, timeline: [`공지 작성 · ${req.admin.name}`, `작업자 앱 ${ws.length}명에게 공지`], metrics: [['받은 사람', `${ws.length}명`]] });
      void pushToWorkers(ws.map((w) => w.id), { title: '현장 공지', body: b.title, route: '#site' });
      return { ok: true };
    });

    // ---- reports ----------------------------------------------------------------------
    r.get('/api/admin/sites/:siteId/reports', async (req) => {
      const { siteId } = parse(siteParam, req.params);
      await siteOr404(siteId);
      const { period } = parse(z.object({ period: z.enum(['day', 'week', 'month']).default('week') }), req.query);
      const now = Date.now();
      const t = tz();
      const today = dayStart(now, t);
      const nDays = period === 'day' ? 1 : period === 'week' ? 7 : 28;
      const from = today - (nDays - 1) * DAY;
      const prevFrom = from - nDays * DAY;
      const rows = await q<{ worker_id: number; name: string; ts: Date; pm10: number; zone_id: number | null; lim: number | null }>(
        `select r.worker_id, w.name, r.ts, r.pm10, r.zone_id, z.pm10_limit as lim
           from readings r join workers w on w.id = r.worker_id left join zones z on z.id = r.zone_id
          where w.site_id = $1 and not w.is_demo and r.ts >= $2 order by r.ts`,
        [siteId, new Date(prevFrom)],
      );
      const zones = await q<{ id: number; name: string }>('select id, name from zones where site_id = $1 and not is_rest order by id', [siteId]);
      // per worker per day samples
      const key = (w: number, d: number) => `${w}:${d}`;
      const perDay = new Map<string, Sample[]>();
      const names = new Map<number, string>();
      for (const r0 of rows) {
        const d = dayStart(r0.ts.getTime(), t);
        names.set(r0.worker_id, r0.name);
        const k = key(r0.worker_id, d);
        const list = perDay.get(k) ?? [];
        list.push({ ts: r0.ts.getTime(), pm10: r0.pm10, zoneId: r0.zone_id, limit: r0.lim ?? 100 });
        perDay.set(k, list);
      }
      const dayPct = (list: Sample[], d: number) => exposurePercent(list, Math.min(d + DAY, now));
      const daily: { worker: number; day: number; pct: number; samples: Sample[] }[] = [];
      for (const [k, list] of perDay) {
        const [w, d] = k.split(':').map(Number);
        daily.push({ worker: w, day: d, pct: dayPct(list, d), samples: list });
      }
      const cur = daily.filter((x) => x.day >= from);
      const prev = daily.filter((x) => x.day < from);
      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      const avg = mean(cur.map((x) => x.pct));
      const prevAvg = mean(prev.map((x) => x.pct));

      const alerts = await q<{ type: AlertType; status: AlertStatus; created_at: Date; acked_at: Date | null; site_zone: string | null }>(
        `select type, status, created_at, acked_at, (metrics->2->>1) as site_zone from alerts
          where site_id = $1 and created_at >= $2 and type in ('caution', 'danger', 'sos', 'advice')`,
        [siteId, new Date(from)],
      );
      const cautions = alerts.filter((a) => a.type === 'caution' || a.type === 'advice');
      const dangers = alerts.filter((a) => a.type === 'danger' || a.type === 'sos');
      const handled = alerts.filter((a) => a.status !== 'open');
      const resp = alerts.filter((a) => a.acked_at).map((a) => a.acked_at!.getTime() - a.created_at.getTime());
      const avgResp = mean(resp);

      // columns: days (day/week) or weeks (month)
      const cols =
        period === 'month'
          ? Array.from({ length: 4 }, (_, i) => {
              const s0 = from + i * 7 * DAY;
              return { label: `${shortDate(s0)}~`, from: s0, to: s0 + 7 * DAY, today: i === 3 };
            })
          : Array.from({ length: nDays }, (_, i) => {
              const s0 = from + i * DAY;
              return { label: s0 === today ? '오늘' : WEEKDAYS[localParts(s0, t).weekday], from: s0, to: s0 + DAY, today: s0 === today };
            });
      const heat = zones.map((z) => ({
        zone: z.name,
        cells: cols.map((c) => {
          const vals = cur
            .filter((x) => x.day >= c.from && x.day < c.to)
            .map((x) => {
              const inZone = x.samples.filter((s) => s.zoneId === z.id);
              return inZone.length ? exposurePercent(inZone, Math.min(x.day + DAY, now)) : null;
            })
            .filter((v): v is number => v != null);
          const m = mean(vals);
          return m == null ? null : Math.round(m);
        }),
      }));
      const alertBars = cols.map((c) => ({
        label: c.label,
        today: c.today,
        caution: cautions.filter((a) => a.created_at.getTime() >= c.from && a.created_at.getTime() < c.to).length,
        danger: dangers.filter((a) => a.created_at.getTime() >= c.from && a.created_at.getTime() < c.to).length,
      }));
      const workerIds = [...new Set(cur.map((x) => x.worker))];
      const dangerByWorker = await q<{ id: number; n: number }>(
        `select unnest(worker_ids) as id, count(*)::int as n from alerts where site_id = $1 and created_at >= $2 and type in ('danger', 'sos') group by 1`,
        [siteId, new Date(from)],
      );
      const people = workerIds
        .map((w) => {
          const mine = cur.filter((x) => x.worker === w);
          const zd = zoneDurations(mine.flatMap((x) => x.samples), now);
          const top = [...zd].sort((a, b) => b[1] - a[1])[0]?.[0];
          const a = Math.round(mean(mine.map((x) => x.pct)) ?? 0);
          return {
            id: w,
            name: names.get(w) ?? '–',
            zone: top == null ? '–' : (zones.find((z) => z.id === top)?.name ?? '휴게'),
            avg: a,
            max: Math.round(Math.max(...mine.map((x) => x.pct))),
            cautionDays: mine.filter((x) => x.pct >= 80).length,
            danger: dangerByWorker.find((d) => d.id === w)?.n ?? 0,
            rec: a >= 80 || mine.filter((x) => x.pct >= 80).length >= 2 ? '순환 배치' : '–',
          };
        })
        .sort((a, b) => b.avg - a.avg);
      const lp = localParts(now, t);
      const range =
        period === 'day' ? `${dateLabel(now)} · 일간` : period === 'week' ? `${shortDate(from)} – ${shortDate(now)} · 주간` : `${shortDate(from)} – ${shortDate(now)} · 최근 4주`;
      void lp;
      const zoneCount = new Map<string, number>();
      for (const a of cautions) if (a.site_zone) zoneCount.set(a.site_zone, (zoneCount.get(a.site_zone) ?? 0) + 1);
      const topZone = [...zoneCount].sort((a, b) => b[1] - a[1])[0];
      return {
        range,
        summary: {
          avg: avg == null ? null : Math.round(avg),
          delta: avg != null && prevAvg != null ? Math.round(avg - prevAvg) : null,
          caution: cautions.length,
          cautionNote: topZone ? `${topZone[1]}건이 ${topZone[0]}` : cautions.length ? '' : '없어요',
          danger: dangers.length,
          dangerNote: dangers[0] ? `${hm(dangers.at(-1)!.created_at)} 가장 최근` : '없어요',
          handled: handled.length,
          total: alerts.length,
          avgResponseSec: avgResp == null ? null : Math.round(avgResp / 1000),
        },
        columns: cols.map((c) => ({ label: c.label, today: c.today })),
        heat,
        alertBars,
        people,
      };
    });

    // ---- sensors ----------------------------------------------------------------------
    r.get('/api/admin/sites/:siteId/sensors', async (req) => {
      const { siteId } = parse(siteParam, req.params);
      await siteOr404(siteId);
      const rows = await q<{ id: string; maker: string | null; model: string | null; items: string | null; battery: number | null; calibrated_on: string | null; last_seen_at: Date | null; worker: string | null; worker_id: number | null }>(
        `select s.id, s.maker, s.model, s.items, s.battery, s.calibrated_on::text, s.last_seen_at, w.name as worker, w.id as worker_id
           from sensors s left join workers w on w.id = s.worker_id
          where s.site_id = $1 and s.id not like 'IVS-DEMO-%' order by s.id`,
        [siteId],
      );
      const now = Date.now();
      const calDue = (d: string | null) => !d || now - Date.parse(d) > 60 * DAY;
      const list = rows.map((s) => {
        const seen = s.last_seen_at?.getTime() ?? null;
        const kind = !s.worker_id ? 'free' : seen && now - seen < 2 * 60_000 ? 'on' : 'off';
        return {
          id: s.id,
          maker: [s.maker, s.model].filter(Boolean).join(' · ') || '–',
          items: s.items ?? 'PM10 · PM2.5 · CO · 온습도',
          who: s.worker ?? '미배정',
          workerId: s.worker_id,
          battery: s.battery,
          last: !seen ? '–' : now - seen < 60_000 ? '방금' : hm(seen),
          calibrated: s.calibrated_on?.replace(/-/g, '.') ?? '–',
          calDue: calDue(s.calibrated_on),
          kind,
        };
      });
      return {
        counts: {
          total: list.length,
          on: list.filter((s) => s.kind === 'on').length,
          off: list.filter((s) => s.kind === 'off').length,
          free: list.filter((s) => s.kind === 'free').length,
          cal: list.filter((s) => s.calDue).length,
          low: list.filter((s) => (s.battery ?? 100) < 20).length,
        },
        sensors: list,
      };
    });

    r.post('/api/admin/sites/:siteId/sensors', { preHandler: requireEditor }, async (req) => {
      const { siteId } = parse(siteParam, req.params);
      await siteOr404(siteId);
      const b = parse(
        z.object({
          id: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9-]{4,32}$/)),
          maker: z.string().trim().max(40).optional(),
          model: z.string().trim().max(40).optional(),
          items: z.string().trim().max(80).optional(),
          calibratedOn: z.iso.date().optional(),
        }),
        req.body,
      );
      await q(
        `insert into sensors (id, site_id, maker, model, items, calibrated_on, battery) values ($1, $2, $3, $4, $5, $6, null)`,
        [b.id, siteId, b.maker ?? null, b.model ?? null, b.items ?? null, b.calibratedOn ?? null],
      ).catch((e) => pgDup(e, '센서'));
      return { id: b.id };
    });

    // ---- settings ----------------------------------------------------------------------
    r.get('/api/admin/sites/:siteId/settings', async (req) => {
      const { siteId } = parse(siteParam, req.params);
      const site = await siteOr404(siteId);
      const zc = (await one<{ zones: number; rest: number; pm10: number | null }>(
        `select count(*) filter (where not is_rest)::int as zones, count(*) filter (where is_rest)::int as rest,
                max(pm10_limit) filter (where not is_rest) as pm10 from zones where site_id = $1`,
        [siteId],
      ))!;
      const members = await q<{ id: number; username: string; name: string; title: string | null; role: string; active: boolean }>(
        'select id, username, name, title, role, active from admins order by id',
      );
      return {
        site: { name: site.name, facility: site.facility ?? '', address: site.address ?? '', shifts: site.shifts, zones: zc.zones, rest: zc.rest },
        limits: { pm10: zc.pm10 ?? 100, pm25: site.pm25_limit, co: site.co_limit, caution: 80, danger: 100 },
        rules: await siteRules(siteId),
        members: members.map((m) => ({ ...m, me: m.id === req.admin.id })),
        myRole: req.admin.role,
      };
    });

    r.put('/api/admin/sites/:siteId/settings', { preHandler: requireEditor }, async (req) => {
      const { siteId } = parse(siteParam, req.params);
      await siteOr404(siteId);
      const ruleKeys = Object.keys(RULE_DEFAULTS) as (keyof typeof RULE_DEFAULTS)[];
      const b = parse(
        z.object({
          site: z.object({ name: z.string().trim().min(1).max(80), facility: z.string().trim().max(80), address: z.string().trim().max(160) }).optional(),
          limits: z.object({ pm10: z.number().min(1).max(5000), pm25: z.number().min(1).max(5000), co: z.number().min(1).max(1000) }).optional(),
          rules: z.record(z.string(), z.boolean()).optional(),
        }),
        req.body,
      );
      await tx(async (c) => {
        if (b.site) await c.query('update sites set name = $2, facility = $3, address = $4 where id = $1', [siteId, b.site.name, b.site.facility || null, b.site.address || null]);
        if (b.limits) {
          await c.query('update sites set pm25_limit = $2, co_limit = $3 where id = $1', [siteId, b.limits.pm25, b.limits.co]);
          await c.query('update zones set pm10_limit = $2 where site_id = $1 and not is_rest', [siteId, b.limits.pm10]);
        }
        if (b.rules) {
          const clean = Object.fromEntries(Object.entries(b.rules).filter(([k]) => ruleKeys.includes(k as keyof typeof RULE_DEFAULTS) && k !== 'dEvac'));
          await c.query(`update sites set rules = rules || $2::jsonb where id = $1`, [siteId, JSON.stringify(clean)]);
        }
      });
      return { ok: true };
    });

    r.post('/api/admin/admins', { preHandler: requireOwner }, async (req) => {
      const b = parse(
        z.object({
          username: z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9._@-]+$/),
          name: z.string().trim().min(1).max(40),
          title: z.string().trim().max(40).optional(),
          role: z.enum(['admin', 'viewer']),
          password: z.string().min(8).max(200),
        }),
        req.body,
      );
      const row = await one<{ id: number }>(
        `insert into admins (username, password_hash, name, title, role, must_change_password) values ($1, $2, $3, $4, $5, true) returning id`,
        [b.username, await hashPassword(b.password), b.name, b.title ?? null, b.role],
      ).catch((e) => pgDup(e, '아이디'));
      return { id: row!.id };
    });

    r.patch('/api/admin/admins/:id', { preHandler: requireOwner }, async (req) => {
      const { id } = parse(idParam, req.params);
      if (id === req.admin.id) throw new HttpError(400, 'invalid_request', '내 계정은 여기서 바꿀 수 없어요.');
      const { active } = parse(z.object({ active: z.boolean() }), req.body);
      await q('update admins set active = $2 where id = $1', [id, active]);
      if (!active) await q('delete from admin_sessions where admin_id = $1', [id]);
      return { id, active };
    });
  });
}
