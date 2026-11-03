import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { HttpError, parse, requireAuth } from '../http.js';
import { loadMe, samples, sensorInfo, tz, WORKER_SENSOR } from '../queries.js';
import {
  buckets, dayStart, exposurePercent, hhmm, levelOf, localParts, measuredMs, peak,
  timeWeightedAverage, WEEKDAYS, zoneDurations, atLocalTime,
} from '../exposure.js';
import { managersOf, pushToWorkers } from '../notify.js';
import type { Exposure, LogDay, LogEvent, SensorInfo, Status, TestSensor } from '../api-types.js';

const DAY = 86_400_000;
const round = (n: number) => Math.round(n);

interface Ctx {
  current_zone_id: number | null;
  zone_code: string | null;
  zone_name: string | null;
  zone_limit: number | null;
  refuge_name: string | null;
  refuge_distance_m: number | null;
  current_spot: string | null;
  shift_name: string | null;
  shift_start: string | null;
  shift_end: string | null;
}

async function ctx(workerId: number) {
  const c = await one<Ctx>(
    `select w.current_zone_id, z.code as zone_code, z.name as zone_name, z.pm10_limit as zone_limit,
            z.refuge_name, z.refuge_distance_m, w.current_spot,
            w.shift_name, w.shift_start::text, w.shift_end::text
       from workers w left join zones z on z.id = w.current_zone_id where w.id = $1`,
    [workerId],
  );
  if (!c) throw new HttpError(404, 'not_found', '작업자 정보를 찾을 수 없어요.');
  return c;
}

export function minutesLeft(now: number, start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  let s = atLocalTime(now, start, tz());
  let e = atLocalTime(now, end, tz());
  if (e <= s) {
    // overnight shift
    if (now < e) s -= DAY;
    else e += DAY;
  }
  if (now < s || now >= e) return null;
  return Math.ceil((e - now) / 60_000);
}

async function zoneNames(ids: (number | null)[]): Promise<Map<number, string>> {
  const real = ids.filter((x): x is number => x != null);
  if (!real.length) return new Map();
  const rows = await q<{ id: number; name: string }>('select id, name from zones where id = any($1)', [real]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function meRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/me', async (req) => loadMe(req.worker.id));

  app.get('/api/me/status', async (req): Promise<Status> => {
    const now = Date.now();
    const c = await ctx(req.worker.id);
    const latest = await one<{ ts: Date; pm10: number }>(
      `select ts, pm10 from readings where worker_id = $1 and ts > now() - interval '2 minutes' order by ts desc limit 1`,
      [req.worker.id],
    );
    const sensor = await one<{ id: string; battery: number | null; last_seen_at: Date | null }>(
      `select id, battery, last_seen_at ${WORKER_SENSOR} limit 1`,
      [req.worker.id],
    );
    const limit = c.zone_limit ?? 100;
    const pct = exposurePercent(await samples(req.worker.id, dayStart(now, tz()), now), now);
    return {
      zone: c.zone_code ? { code: c.zone_code, name: c.zone_name!, spot: c.current_spot, limit } : null,
      now: latest ? { pm10: round(latest.pm10), level: levelOf(latest.pm10, limit), ts: latest.ts.toISOString() } : null,
      exposure: { percent: round(pct), level: levelOf(pct, 100) },
      shift: { minutesLeft: minutesLeft(now, c.shift_start, c.shift_end) },
      refuge: c.refuge_name ? { name: c.refuge_name, distanceM: c.refuge_distance_m } : null,
      sensor: sensor ? { id: sensor.id, battery: sensor.battery, lastSeenAt: sensor.last_seen_at?.toISOString() ?? null } : null,
    };
  });

  app.get('/api/me/exposure', async (req): Promise<Exposure> => {
    const now = Date.now();
    const t = tz();
    const today = dayStart(now, t);
    const c = await ctx(req.worker.id);
    const week = await samples(req.worker.id, today - 6 * DAY, now);
    const todays = week.filter((s) => s.ts >= today);
    const pct = exposurePercent(todays, now);
    const top = peak(todays);
    const names = await zoneNames([...new Set(week.map((s) => s.zoneId))]);

    const alerts = (await one<{ total: number; caution: number; danger: number }>(
      `select count(*)::int as total,
              count(*) filter (where level = 'caution')::int as caution,
              count(*) filter (where level = 'danger')::int as danger
         from events where worker_id = $1 and ts >= $2 and type = 'alert' and level is not null`,
      [req.worker.id, new Date(today)],
    ))!;

    const seriesStart = c.shift_start
      ? Math.min(atLocalTime(now, c.shift_start, t), todays[0]?.ts ?? now)
      : (todays[0]?.ts ?? now);
    const bucketStart = Math.floor((seriesStart - today) / 1_800_000) * 1_800_000 + today;
    const series = todays.length
      ? buckets(todays, bucketStart, now).map((b) => ({ time: hhmm(b.start, t), avg: b.avg == null ? null : round(b.avg) }))
      : [];

    const zones = [...zoneDurations(todays, now)]
      .filter(([, ms]) => ms >= 60_000)
      .sort((a, b) => b[1] - a[1])
      .map(([id, ms]) => ({ name: id == null ? '기타' : (names.get(id) ?? '기타'), minutes: round(ms / 60_000) }));

    const days = Array.from({ length: 7 }, (_, i) => {
      const start = today - (6 - i) * DAY;
      const end = Math.min(start + DAY, now);
      const ds = week.filter((s) => s.ts >= start && s.ts < start + DAY);
      const p = localParts(start, t);
      return { day: i === 6 ? '오늘' : WEEKDAYS[p.weekday], percent: ds.length ? round(exposurePercent(ds, end)) : null, today: i === 6 };
    });

    const lp = localParts(now, t);
    return {
      dateLabel: `${lp.month}월 ${lp.day}일 ${WEEKDAYS[lp.weekday]}요일`,
      shiftName: c.shift_name,
      percent: round(pct),
      level: levelOf(pct, 100),
      average: (() => {
        const a = timeWeightedAverage(todays, now);
        return a == null ? null : round(a);
      })(),
      limit: c.zone_limit ?? 100,
      workedMinutes: round(measuredMs(todays, now) / 60_000),
      minutesLeft: minutesLeft(now, c.shift_start, c.shift_end),
      peak: top ? { value: round(top.pm10), time: hhmm(top.ts, t), zone: top.zoneId == null ? null : (names.get(top.zoneId) ?? null) } : null,
      alerts,
      series,
      zones,
      week: days,
    };
  });

  app.get('/api/me/events', async (req): Promise<LogDay> => {
    const now = Date.now();
    const t = tz();
    const today = dayStart(now, t);
    const rows = await q<{ id: number; ts: Date; type: LogEvent['type']; level: LogEvent['level']; title: string; detail: string | null }>(
      'select id, ts, type, level, title, detail from events where worker_id = $1 and ts >= $2 order by ts desc limit 200',
      [req.worker.id, new Date(today)],
    );
    const y = await samples(req.worker.id, today - DAY, today);
    const yCounts = (await one<{ alerts: number; count: number }>(
      `select count(*) filter (where type = 'alert' and level is not null)::int as alerts, count(*)::int as count
         from events where worker_id = $1 and ts >= $2 and ts < $3`,
      [req.worker.id, new Date(today - DAY), new Date(today)],
    ))!;
    const yPct = y.length ? exposurePercent(y, today) : null;
    return {
      today: rows.map((r) => ({ id: r.id, time: hhmm(r.ts.getTime(), t), type: r.type, level: r.level, title: r.title, detail: r.detail })),
      yesterday: { percent: yPct == null ? null : round(yPct), level: levelOf(yPct ?? 0, 100), ...yCounts },
    };
  });

  // ---- sensor pairing ----
  // Test sensors (sensors.is_test) are shown on the login sensor screen without Bluetooth and
  // any number of workers can pick the same one, so their pairing lives on workers.test_sensor_id.
  app.get('/api/me/test-sensors', async (): Promise<TestSensor[]> =>
    q<{ id: string; battery: number | null }>('select id, battery from sensors where is_test order by id'),
  );

  app.put('/api/me/sensor', async (req): Promise<SensorInfo> => {
    const { sensorId } = parse(z.object({ sensorId: z.string().regex(/^[A-Z0-9-]{4,32}$/) }), req.body);
    const me = req.worker.id;
    return tx(async (c) => {
      const s = (await c.query<{ id: string; worker_id: number | null; battery: number | null; firmware: string | null; calibrated_on: string | null; last_seen_at: Date | null; is_test: boolean }>(
        'select id, worker_id, battery, firmware, calibrated_on::text, last_seen_at, is_test from sensors where id = $1 for update',
        [sensorId],
      )).rows[0];
      if (!s) throw new HttpError(404, 'sensor_not_found', '등록되지 않은 센서예요. 관리자에게 문의해 주세요.');
      const cur = (await c.query<{ test_sensor_id: string | null }>('select test_sensor_id from workers where id = $1', [me])).rows[0];
      if (s.is_test) {
        if (cur?.test_sensor_id !== sensorId) {
          await c.query('update sensors set worker_id = null where worker_id = $1', [me]);
          await c.query('update workers set test_sensor_id = $2 where id = $1', [me, sensorId]);
          await c.query(`insert into events (worker_id, type, title, detail) values ($1, 'sensor', '센서 연결', $2)`, [me, sensorId]);
        }
        return sensorInfo(s);
      }
      if (s.worker_id && s.worker_id !== me) {
        throw new HttpError(409, 'sensor_in_use', '다른 작업자가 쓰고 있는 센서예요.');
      }
      if (cur?.test_sensor_id) await c.query('update workers set test_sensor_id = null where id = $1', [me]);
      if (s.worker_id !== me) {
        await c.query('update sensors set worker_id = null where worker_id = $1', [me]);
        await c.query('update sensors set worker_id = $1 where id = $2', [me, sensorId]);
        await c.query(`insert into events (worker_id, type, title, detail) values ($1, 'sensor', '센서 연결', $2)`, [me, sensorId]);
      }
      return sensorInfo(s);
    });
  });

  app.delete('/api/me/sensor', async (req, reply) => {
    await q('update sensors set worker_id = null where worker_id = $1', [req.worker.id]);
    await q('update workers set test_sensor_id = null where id = $1', [req.worker.id]);
    return reply.code(204).send();
  });

  // ---- push ----
  app.put('/api/me/push-token', async (req, reply) => {
    const { token, platform } = parse(
      z.object({ token: z.string().regex(/^[0-9a-fA-F]{32,200}$/), platform: z.enum(['ios']).default('ios') }),
      req.body,
    );
    await q(
      `insert into push_tokens (token, worker_id, platform) values ($1, $2, $3)
       on conflict (token) do update set worker_id = excluded.worker_id, updated_at = now()`,
      [token.toLowerCase(), req.worker.id, platform],
    );
    return reply.code(204).send();
  });

  // ---- requests to the manager ----
  app.post('/api/me/requests', async (req) => {
    const { type } = parse(z.object({ type: z.enum(['shift']) }), req.body);
    const me = await loadMe(req.worker.id);
    const c = await ctx(req.worker.id);
    await q(`insert into events (worker_id, type, title, detail) values ($1, 'request', '교대 요청', $2)`, [
      req.worker.id,
      me.manager ? `${me.manager.name} ${me.manager.title}에게 보냈어요` : '관리자에게 보냈어요',
    ]);
    const managers = await managersOf(req.worker.id);
    await pushToWorkers(managers, {
      title: '교대 요청',
      body: `${me.name} · ${c.zone_name ?? ''} — 누적 노출량이 높아 교대를 요청했어요`,
      route: '#site',
    });
    return { type, notified: me.manager ? [`${me.manager.name} ${me.manager.title}`] : [] };
  });

  // ---- danger alert acknowledged ----
  app.post('/api/me/alerts/ack', async (req, reply) => {
    const c = await ctx(req.worker.id);
    await q(`insert into events (worker_id, type, title, detail) values ($1, 'alert', '위험 알림 확인', $2)`, [
      req.worker.id,
      c.zone_name ? `${c.zone_name}에서 대피 안내를 확인했어요` : '대피 안내를 확인했어요',
    ]);
    return reply.code(204).send();
  });
}
