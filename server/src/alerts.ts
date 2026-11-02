// Site incidents for the admin dashboard. Created by the readings pipeline, SOS and the
// watchdog; acknowledged / resolved by admins. Each carries a human-readable timeline.
import type pg from 'pg';
import { one, pool, q } from './db.js';

export type AlertType = 'caution' | 'danger' | 'sos' | 'sensor' | 'advice' | 'notice';
export type AlertStatus = 'open' | 'acked' | 'resolved' | 'auto' | 'info';

/** Alert rule toggles (site settings). Missing = default. */
export const RULE_DEFAULTS = {
  cApp: true, // 주의: 작업자 앱 알림
  cAdmin: true, // 주의: 관리자 알림 (dashboard incidents)
  dEvac: true, // 위험: 자동 대피 알림 (always on)
  advice: true, // 누적 80% 교대 권고
  sensor: true, // 센서 연결 끊김 알림
} as const;
export type Rules = Record<keyof typeof RULE_DEFAULTS, boolean>;

export async function siteRules(siteId: number): Promise<Rules> {
  const r = await one<{ rules: Partial<Rules> }>('select rules from sites where id = $1', [siteId]);
  return { ...RULE_DEFAULTS, ...(r?.rules ?? {}), dEvac: true };
}

const clock = (d: Date | number = new Date()) =>
  new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }).format(d);
export const hhmmss = clock;

export interface NewAlert {
  siteId: number;
  type: AlertType;
  title: string;
  sub?: string | null;
  rec?: string | null;
  metrics?: [string, string][];
  workerIds?: number[];
  timeline?: string[]; // stamped with the current time
  dedupKey?: string | null;
  status?: AlertStatus;
}

/** Creates an incident unless one with the same dedup key is still open. Returns its id. */
export async function createAlert(a: NewAlert, c: pg.PoolClient | typeof pool = pool): Promise<number | null> {
  const now = clock();
  const res = await c.query<{ id: number }>(
    `insert into alerts (site_id, type, status, title, sub, rec, metrics, worker_ids, timeline, dedup_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (dedup_key) where dedup_key is not null and status in ('open', 'acked') do nothing
     returning id`,
    [
      a.siteId, a.type, a.status ?? (a.type === 'notice' ? 'info' : 'open'), a.title, a.sub ?? null, a.rec ?? null,
      JSON.stringify(a.metrics ?? []), a.workerIds ?? [], JSON.stringify((a.timeline ?? []).map((x) => [now, x])), a.dedupKey ?? null,
    ],
  );
  return res.rows[0]?.id ?? null;
}

export async function appendTimeline(id: number, text: string) {
  await q(`update alerts set timeline = timeline || jsonb_build_array(jsonb_build_array($2::text, $3::text)) where id = $1`, [id, clock(), text]);
}

/** Closes the open incident with this dedup key (e.g. a sensor came back). */
export async function autoResolve(dedupKey: string, text: string) {
  const row = await one<{ id: number }>(
    `update alerts set status = 'auto', resolved_at = now(),
            timeline = timeline || jsonb_build_array(jsonb_build_array($2::text, $3::text))
      where dedup_key = $1 and status in ('open', 'acked') returning id`,
    [dedupKey, clock(), text],
  );
  return row?.id ?? null;
}
