// Shared calculations for the admin dashboard (per-site worker status and exposure).
import { q } from './db.js';
import { dayStart, exposurePercent, levelOf, type Level, type Sample } from './exposure.js';
import { tz } from './queries.js';

export const DAY = 86_400_000;

export interface SiteWorker {
  id: number;
  name: string;
  employeeNo: string;
  phone: string;
  company: string | null;
  team: string | null;
  shiftName: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  zoneId: number | null;
  zone: string | null;
  zoneRest: boolean;
  spot: string | null;
  x: number | null;
  y: number | null;
  limit: number;
  sensorId: string | null;
  battery: number | null;
  lastSeen: number | null; // epoch ms of the sensor's last data
  loggedIn: boolean;
  inviteExpiresAt: string | null;
  pm10: number | null; // latest within 2 minutes
  cum: number; // today's exposure %
  readToday: boolean;
  level: Level;
  /** what the dashboard shows: danger / caution / safe / off (sensor not sending) */
  state: 'danger' | 'caution' | 'safe' | 'off';
}

export async function siteWorkers(siteId: number, opts: { includeInactive?: boolean } = {}): Promise<SiteWorker[]> {
  const now = Date.now();
  const today = dayStart(now, tz());
  const rows = await q<{
    id: number; name: string; employee_no: string; phone: string; company: string | null; team: string | null;
    shift_name: string | null; shift_start: string | null; shift_end: string | null;
    zone_id: number | null; zone: string | null; zone_rest: boolean | null; spot: string | null; map_x: number | null; map_y: number | null;
    lim: number | null; sensor_id: string | null; battery: number | null; last_seen: Date | null; logged_in: boolean; invite_exp: Date | null;
  }>(
    `select w.id, w.name, w.employee_no, w.phone, w.company, w.team, w.shift_name,
            to_char(w.shift_start, 'HH24:MI') as shift_start, to_char(w.shift_end, 'HH24:MI') as shift_end,
            w.current_zone_id as zone_id, z.name as zone, z.is_rest as zone_rest, w.current_spot as spot, w.map_x, w.map_y,
            z.pm10_limit as lim, s.id as sensor_id, s.battery, s.last_seen_at as last_seen,
            exists (select 1 from sessions x where x.worker_id = w.id and x.expires_at > now()) as logged_in,
            (select i.expires_at from invites i where i.worker_id = w.id and i.used_at is null and i.revoked_at is null and i.expires_at > now()) as invite_exp
       from workers w
       left join zones z on z.id = w.current_zone_id
       left join sensors s on s.worker_id = w.id or s.id = w.test_sensor_id
      where w.site_id = $1 and w.role = 'worker' and not w.is_demo ${opts.includeInactive ? '' : 'and w.active'}
      order by w.name`,
    [siteId],
  );
  const readings = await q<{ worker_id: number; ts: Date; pm10: number; zone_id: number | null; lim: number | null }>(
    `select r.worker_id, r.ts, r.pm10, r.zone_id, z.pm10_limit as lim
       from readings r join workers w on w.id = r.worker_id left join zones z on z.id = r.zone_id
      where w.site_id = $1 and r.ts >= $2 order by r.ts`,
    [siteId, new Date(today)],
  );
  const byWorker = new Map<number, Sample[]>();
  for (const r of readings) {
    const list = byWorker.get(r.worker_id) ?? [];
    list.push({ ts: r.ts.getTime(), pm10: r.pm10, zoneId: r.zone_id, limit: r.lim ?? 100 });
    byWorker.set(r.worker_id, list);
  }
  return rows.map((w) => {
    const samples = byWorker.get(w.id) ?? [];
    const last = samples.at(-1);
    const limit = w.lim ?? 100;
    const pm10 = last && now - last.ts < 120_000 ? Math.round(last.pm10) : null;
    const cum = samples.length ? Math.round(exposurePercent(samples, now)) : 0;
    const nowLevel = pm10 == null ? 'safe' : levelOf(pm10, limit);
    const cumLevel = levelOf(cum, 100);
    const level: Level = nowLevel === 'danger' || cumLevel === 'danger' ? 'danger' : nowLevel === 'caution' || cumLevel === 'caution' ? 'caution' : 'safe';
    const lastSeen = w.last_seen?.getTime() ?? null;
    const off = !!w.sensor_id && samples.length > 0 && pm10 == null;
    return {
      id: w.id,
      name: w.name,
      employeeNo: w.employee_no,
      phone: w.phone,
      company: w.company,
      team: w.team,
      shiftName: w.shift_name,
      shiftStart: w.shift_start,
      shiftEnd: w.shift_end,
      zoneId: w.zone_id,
      zone: w.zone,
      zoneRest: !!w.zone_rest,
      spot: w.spot,
      x: w.map_x,
      y: w.map_y,
      limit,
      sensorId: w.sensor_id,
      battery: w.battery,
      lastSeen,
      loggedIn: w.logged_in,
      inviteExpiresAt: w.invite_exp?.toISOString() ?? null,
      pm10,
      cum,
      readToday: samples.length > 0,
      level,
      state: off ? 'off' : level,
    };
  });
}

export const hm = (d: Date | number) =>
  new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }).format(d);
export const dateLabel = (d: Date | number) =>
  new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Seoul' }).format(d);
export const shortDate = (d: Date | number) =>
  new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Seoul' }).format(d).replace(/\.\s?/g, '/').replace(/\/$/, '');
