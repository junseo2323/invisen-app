import { one, q } from './db.js';
import { siteRules } from './alerts.js';
import { config } from './config.js';
import type { Me, SensorInfo } from './api-types.js';
import type { Sample } from './exposure.js';

const hm = (t: string | null) => (t ? t.slice(0, 5) : null);

interface WorkerRow {
  is_demo: boolean;
  id: number;
  employee_no: string;
  name: string;
  company: string | null;
  team: string | null;
  site_id: number;
  site_name: string;
  control_room_phone: string | null;
  shift_name: string | null;
  shift_start: string | null;
  shift_end: string | null;
  zones: string[] | null;
  manager_name: string | null;
  manager_phone: string | null;
  manager_role: string | null;
}

export function sensorInfo(r: { id: string; battery: number | null; firmware: string | null; calibrated_on: string | Date | null; last_seen_at: Date | null }): SensorInfo {
  const cal = r.calibrated_on instanceof Date ? r.calibrated_on.toISOString().slice(0, 10) : r.calibrated_on;
  return { id: r.id, battery: r.battery, firmware: r.firmware, calibratedOn: cal, lastSeenAt: r.last_seen_at?.toISOString() ?? null };
}

export async function loadMe(workerId: number): Promise<Me> {
  const w = await one<WorkerRow>(
    `select w.id, w.employee_no, w.name, w.company, w.team, w.site_id, s.name as site_name, s.control_room_phone,
            w.shift_name, w.shift_start::text, w.shift_end::text, w.is_demo,
            (select array_agg(z.name order by z.name) from zones z where z.id = any(w.assigned_zone_ids)) as zones,
            m.name as manager_name, m.phone as manager_phone, m.role as manager_role
       from workers w
       join sites s on s.id = w.site_id
       left join workers m on m.id = w.manager_id
      where w.id = $1`,
    [workerId],
  );
  if (!w) throw new Error(`worker ${workerId} not found`);
  const sensor = await one<{ id: string; battery: number | null; firmware: string | null; calibrated_on: string | null; last_seen_at: Date | null }>(
    `select id, battery, firmware, calibrated_on::text, last_seen_at from sensors where worker_id = $1`,
    [workerId],
  );
  return {
    id: w.id,
    employeeNo: w.employee_no,
    name: w.name,
    company: w.company,
    team: w.team,
    site: { id: w.site_id, name: w.site_name, controlRoomPhone: w.control_room_phone },
    zones: w.zones ?? [],
    shift: { name: w.shift_name, start: hm(w.shift_start), end: hm(w.shift_end) },
    manager: w.manager_name ? { name: w.manager_name, title: '반장', phone: w.manager_phone ?? '' } : null,
    sensor: sensor ? sensorInfo(sensor) : null,
    demo: w.is_demo,
    cautionAlerts: (await siteRules(w.site_id)).cApp,
  };
}

export async function samples(workerId: number, from: number, to: number): Promise<Sample[]> {
  const rows = await q<{ ts: Date; pm10: number; zone_id: number | null; lim: number | null }>(
    `select r.ts, r.pm10, r.zone_id, z.pm10_limit as lim
       from readings r left join zones z on z.id = r.zone_id
      where r.worker_id = $1 and r.ts >= $2 and r.ts < $3
      order by r.ts`,
    [workerId, new Date(from), new Date(to)],
  );
  return rows.map((r) => ({ ts: r.ts.getTime(), pm10: r.pm10, zoneId: r.zone_id, limit: r.lim ?? 100 }));
}

export async function workerShift(workerId: number) {
  return one<{ shift_name: string | null; shift_start: string | null; shift_end: string | null }>(
    'select shift_name, shift_start::text, shift_end::text from workers where id = $1',
    [workerId],
  );
}

export const tz = () => config.tzOffsetMin;
