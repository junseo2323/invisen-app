import type { FastifyInstance } from 'fastify';
import { one, q } from '../db.js';
import { requireAuth } from '../http.js';
import { levelOf, worse, type Level } from '../exposure.js';
import type { Site } from '../api-types.js';

export async function siteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/site', async (req): Promise<Site> => {
    const site = (await one<{ name: string; map_width_m: number | null; map_height_m: number | null }>(
      'select name, map_width_m, map_height_m from sites where id = $1',
      [req.worker.siteId],
    ))!;
    const me = await one<{ map_x: number | null; map_y: number | null }>('select map_x, map_y from workers where id = $1', [req.worker.id]);
    const team = await q<{ id: number; name: string; zone: string | null; map_x: number | null; map_y: number | null; alert_level: Level }>(
      `select w.id, w.name, z.name as zone, w.map_x, w.map_y, w.alert_level
         from workers w left join zones z on z.id = w.current_zone_id
        where w.site_id = $1 and w.active and w.id <> $2 and w.role = 'worker' and not w.is_demo`,
      [req.worker.siteId, req.worker.id],
    );
    const zoneNow = await q<{ name: string; lim: number; avg: number }>(
      `select z.name, z.pm10_limit as lim, avg(r.pm10)::real as avg
         from readings r join zones z on z.id = r.zone_id
        where z.site_id = $1 and r.ts > now() - interval '10 minutes' and not z.is_rest
        group by z.id order by avg(r.pm10) / z.pm10_limit desc`,
      [req.worker.siteId],
    );
    const working = await one<{ n: number; avg: number | null }>(
      `select count(distinct r.worker_id)::int as n, avg(r.pm10)::real as avg
         from readings r join workers w on w.id = r.worker_id
        where w.site_id = $1 and not w.is_demo and r.ts > now() - interval '10 minutes'`,
      [req.worker.siteId],
    );
    const notices = await q<{ id: number; title: string; detail: string | null }>(
      `select id, title, detail from notices where site_id = $1
          and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())
        order by created_at desc limit 5`,
      [req.worker.siteId],
    );

    const dist = (x: number | null, y: number | null) => {
      if (x == null || y == null || me?.map_x == null || me?.map_y == null || !site.map_width_m || !site.map_height_m) return null;
      return Math.round(Math.hypot(((x - me.map_x) / 100) * site.map_width_m, ((y - me.map_y) / 100) * site.map_height_m));
    };
    const worst = zoneNow.find((z) => levelOf(z.avg, z.lim) !== 'safe');

    return {
      name: site.name,
      working: working?.n ?? 0,
      cautionZone: worst?.name ?? null,
      pm10: working?.avg == null ? null : Math.round(working.avg),
      me: { x: me?.map_x ?? null, y: me?.map_y ?? null },
      team: team
        .map((t) => ({
          id: t.id,
          name: t.name,
          initial: t.name.slice(0, 1),
          zone: t.zone,
          distanceM: dist(t.map_x, t.map_y),
          x: t.map_x,
          y: t.map_y,
          level: worse(t.alert_level, 'safe'),
        }))
        .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity)),
      notices,
    };
  });
}
