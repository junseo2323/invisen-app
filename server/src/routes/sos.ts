import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.js';
import { HttpError, parse, requireAuth } from '../http.js';
import { hhmm } from '../exposure.js';
import { managersOf, postWebhook, pushToWorkers } from '../notify.js';
import { tz } from '../queries.js';
import type { SosResponse } from '../api-types.js';

const schema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracy: z.number().min(0).max(100_000).optional(),
});

export async function sosRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/sos', async (req): Promise<SosResponse> => {
    const body = parse(schema, req.body ?? {});
    const w = (await one<{ name: string; employee_no: string; zone_id: number | null; zone: string | null; spot: string | null; manager: string | null }>(
      `select w.name, w.employee_no, w.current_zone_id as zone_id, z.name as zone, w.current_spot as spot, m.name as manager
         from workers w left join zones z on z.id = w.current_zone_id left join workers m on m.id = w.manager_id where w.id = $1`,
      [req.worker.id],
    ))!;
    const latest = await one<{ pm10: number }>(
      `select pm10 from readings where worker_id = $1 and ts > now() - interval '5 minutes' order by ts desc limit 1`,
      [req.worker.id],
    );
    const row = (await one<{ id: number; created_at: Date }>(
      `insert into sos_calls (worker_id, zone_id, spot, pm10, lat, lng, accuracy) values ($1, $2, $3, $4, $5, $6, $7)
       returning id, created_at`,
      [req.worker.id, w.zone_id, w.spot, latest?.pm10 ?? null, body.lat ?? null, body.lng ?? null, body.accuracy ?? null],
    ))!;
    await q(`insert into events (worker_id, type, level, title, detail) values ($1, 'sos', 'danger', 'SOS 호출', $2)`, [
      req.worker.id,
      '관제실과 반장님께 보냈어요',
    ]);

    const where = [w.zone, w.spot].filter(Boolean).join(' ');
    const map = body.lat != null && body.lng != null ? ` · 위치 https://maps.google.com/?q=${body.lat},${body.lng}` : '';
    const text = `[SOS] ${w.name}(${w.employee_no}) ${where}${latest ? ` · PM10 ${Math.round(latest.pm10)}` : ''}${map}`;
    const managers = await managersOf(req.worker.id);
    const [pushed, hooked] = await Promise.all([
      pushToWorkers(managers, { title: 'SOS 긴급 호출', body: text.replace('[SOS] ', ''), route: '#site', critical: true }),
      postWebhook(text),
    ]);
    req.log.warn({ sos: row.id, worker: req.worker.id, pushed, hooked }, 'SOS');

    return {
      id: row.id,
      createdAt: row.created_at.toISOString(),
      time: hhmm(row.created_at.getTime(), tz()),
      zone: w.zone,
      spot: w.spot,
      pm10: latest ? Math.round(latest.pm10) : null,
      notified: ['반장', '관제실'],
    };
  });

  app.post('/api/sos/:id/cancel', async (req, reply) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const row = await one(
      `update sos_calls set status = 'cancelled', cancelled_at = now() where id = $1 and worker_id = $2 and status = 'sent' returning id`,
      [id, req.worker.id],
    );
    if (!row) throw new HttpError(404, 'not_found', '취소할 호출이 없어요.');
    await q(`insert into events (worker_id, type, title, detail) values ($1, 'sos', 'SOS 취소', '호출을 취소했어요')`, [req.worker.id]);
    const managers = await managersOf(req.worker.id);
    void pushToWorkers(managers, { title: 'SOS 취소', body: '작업자가 SOS 호출을 취소했어요', route: '#site' });
    void postWebhook(`[SOS 취소] 호출 #${id}`);
    return reply.code(204).send();
  });
}
