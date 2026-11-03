import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { HttpError, parse, requireAuth } from '../http.js';
import { isEscalation, levelOf, type Level } from '../exposure.js';
import { managersOf, postWebhook, pushToWorkers } from '../notify.js';
import { sensorInfo, WORKER_SENSOR } from '../queries.js';
import { createAlert, siteRules } from '../alerts.js';
import type { ReadingsResponse, SensorLive } from '../api-types.js';

const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const schema = z.object({
  sensorId: z.string().min(4).max(32),
  battery: z.number().int().min(0).max(100).optional(),
  readings: z
    .array(
      z.object({
        ts: z.iso.datetime({ offset: true }),
        pm10: num(0, 5000),
        pm25: num(0, 5000).optional(),
        co: num(0, 1000).optional(),
        temp: num(-40, 85).optional(),
        humidity: num(0, 100).optional(),
      }),
    )
    .min(1)
    .max(500),
});

const ALERT_DEDUP_MIN = 10;
const PM25_LIMIT = 50;
const CO_LIMIT = 30;

export async function readingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/readings', async (req): Promise<ReadingsResponse> => {
    const body = parse(schema, req.body);
    const workerId = req.worker.id;
    const now = Date.now();
    const rows = body.readings
      .map((r) => ({ ...r, t: Date.parse(r.ts) }))
      .filter((r) => r.t > now - 24 * 3600_000 && r.t < now + 5 * 60_000)
      .sort((a, b) => a.t - b.t);

    const w = await one<{ zone_id: number | null; zone_name: string | null; lim: number | null; alert_level: Level; name: string; employee_no: string; spot: string | null }>(
      `select w.current_zone_id as zone_id, z.name as zone_name, z.pm10_limit as lim, w.alert_level, w.name, w.employee_no, w.current_spot as spot
         from workers w left join zones z on z.id = w.current_zone_id where w.id = $1`,
      [workerId],
    );
    const paired = await one(
      'select 1 from sensors s where s.id = $2 and (s.worker_id = $1 or s.id = (select test_sensor_id from workers where id = $1))',
      [workerId, body.sensorId],
    );
    if (!w || !paired) throw new HttpError(409, 'sensor_not_paired', '연결된 센서가 아니에요. 센서를 다시 연결해 주세요.');
    const limit = w.lim ?? 100;

    let level: Level = w.alert_level;
    const newAlerts: { level: Level; pm10: number; t: number }[] = [];
    for (const r of rows) {
      const l = levelOf(r.pm10, limit);
      if (isEscalation(level, l)) newAlerts.push({ level: l, pm10: r.pm10, t: r.t });
      level = l;
    }

    const accepted = await tx(async (c) => {
      const ins = rows.length
        ? await c.query(
            `insert into readings (worker_id, sensor_id, zone_id, ts, pm10, pm25, co, temp, humidity)
             select $1, $2, $3, * from unnest($4::timestamptz[], $5::real[], $6::real[], $7::real[], $8::real[], $9::real[])
             on conflict (sensor_id, ts) do nothing`,
            [
              workerId, body.sensorId, w.zone_id,
              rows.map((r) => new Date(r.t)), rows.map((r) => r.pm10), rows.map((r) => r.pm25 ?? null),
              rows.map((r) => r.co ?? null), rows.map((r) => r.temp ?? null), rows.map((r) => r.humidity ?? null),
            ],
          )
        : { rowCount: 0 };
      await c.query('update sensors set last_seen_at = now(), battery = coalesce($2, battery) where id = $1', [body.sensorId, body.battery ?? null]);
      await c.query('update workers set alert_level = $2 where id = $1', [workerId, level]);
      for (const a of newAlerts) {
        const dup = await c.query(
          `select 1 from events where worker_id = $1 and type = 'alert' and level = $2 and ts > to_timestamp($3 / 1000.0) - make_interval(mins => $4)`,
          [workerId, a.level, a.t, ALERT_DEDUP_MIN],
        );
        if (dup.rowCount) continue;
        const pct = Math.round((a.pm10 / limit) * 100);
        await c.query(
          `insert into events (worker_id, ts, type, level, title, detail) values ($1, to_timestamp($2 / 1000.0), 'alert', $3, $4, $5)`,
          [
            workerId, a.t, a.level,
            `${w.zone_name ?? ''} PM10 ${Math.round(a.pm10)} µg/m³`.trim(),
            a.level === 'danger' ? `권고치 ${pct}% · 관리자에게 전달됐어요` : `권고치 ${pct}% · 마스크를 써주세요`,
          ],
        );
      }
      return ins.rowCount ?? 0;
    });

    // dashboard incidents (one per worker per level while it stays open)
    if (newAlerts.length) {
      const rules = await siteRules(req.worker.siteId);
      for (const a of newAlerts) {
        if (a.level === 'caution' && !rules.cAdmin) continue;
        const pct = Math.round((a.pm10 / limit) * 100);
        const v = Math.round(a.pm10);
        await createAlert({
          siteId: req.worker.siteId,
          type: a.level === 'danger' ? 'danger' : 'caution',
          title: `${w.name} 님 PM10 ${v} µg/m³`,
          sub: `${w.zone_name ?? '구역 미지정'}${w.spot ? ` ${w.spot}` : ''} · 권고치 ${pct}%`,
          metrics: [['PM10', String(v)], ['권고치 대비', `${pct}%`], ['구역', w.zone_name ?? '–']],
          rec: a.level === 'danger' ? '작업자를 안전 구역으로 대피시키고 원인을 확인해 주세요.' : null,
          workerIds: [workerId],
          timeline: a.level === 'danger' ? [`PM10 ${v} 감지`, '작업자 앱 대피 알림', '관리자 알림'] : [`PM10 ${v} 감지`, '작업자 앱 마스크 알림'],
          dedupKey: `${a.level}:${workerId}`,
        });
      }
    }
    const danger = newAlerts.find((a) => a.level === 'danger');
    if (danger) {
      const text = `[위험] ${w.name}(${w.employee_no}) ${w.zone_name ?? ''} ${w.spot ?? ''} · PM10 ${Math.round(danger.pm10)} µg/m³ (권고치 ${Math.round((danger.pm10 / limit) * 100)}%)`;
      void managersOf(workerId).then((ids) => pushToWorkers(ids, { title: '위험 알림', body: text.replace('[위험] ', ''), route: '#site' }));
      void postWebhook(text);
    }
    return { accepted, level };
  });

  app.get('/api/sensor/live', async (req): Promise<SensorLive> => {
    const s = await one<{ id: string; battery: number | null; firmware: string | null; calibrated_on: string | null; last_seen_at: Date | null; is_test: boolean }>(
      `select id, battery, firmware, calibrated_on::text, last_seen_at, is_test ${WORKER_SENSOR} limit 1`,
      [req.worker.id],
    );
    const lim = await one<{ lim: number | null }>(
      'select z.pm10_limit as lim from workers w left join zones z on z.id = w.current_zone_id where w.id = $1',
      [req.worker.id],
    );
    const hist = await q<{ ts: Date; pm10: number; pm25: number | null; co: number | null; temp: number | null; humidity: number | null }>(
      `select ts, pm10, pm25, co, temp, humidity from readings
        where worker_id = $1 and ts > now() - interval '30 minutes' order by ts`,
      [req.worker.id],
    );
    // at most ~60 points for the sparklines
    const step = Math.max(1, Math.ceil(hist.length / 60));
    const latest = hist.at(-1);
    return {
      sensor: s ? sensorInfo(s) : null,
      latest: latest ? { ts: latest.ts.toISOString(), pm10: latest.pm10, pm25: latest.pm25, co: latest.co, temp: latest.temp, humidity: latest.humidity } : null,
      history: hist.filter((_, i) => i % step === 0 || i === hist.length - 1).map((r) => ({ ts: r.ts.toISOString(), pm10: r.pm10, pm25: r.pm25, co: r.co })),
      limits: { pm10: lim?.lim ?? 100, pm25: PM25_LIMIT, co: CO_LIMIT },
    };
  });
}
