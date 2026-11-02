// Invite codes: a manager (later: the admin dashboard) issues a one-time 6-digit code
// for a registered worker, who logs in with phone number + code. No SMS involved.
import { randomInt, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { one, q, tx } from './db.js';
import { sha256 } from './http.js';

const hash = (workerId: number, code: string) => sha256(`${config.inviteSecret}:${workerId}:${code}`);

export async function issueInvite(workerId: number, createdBy: number | null, ttlHours = config.inviteTtlHours) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const row = await tx(async (c) => {
    await c.query('update invites set revoked_at = now() where worker_id = $1 and used_at is null and revoked_at is null', [workerId]);
    return (await c.query<{ expires_at: Date }>(
      `insert into invites (worker_id, code_hash, expires_at, created_by)
       values ($1, $2, now() + make_interval(hours => $3), $4) returning expires_at`,
      [workerId, hash(workerId, code), ttlHours, createdBy],
    )).rows[0];
  });
  return { code, expiresAt: row.expires_at.toISOString() };
}

export type CheckResult = 'ok' | 'wrong' | 'expired' | 'locked';

/** Checks (and on success consumes) the worker's live invite code. */
export async function checkInvite(workerId: number, code: string): Promise<CheckResult> {
  if (config.devLoginCode && code === config.devLoginCode) return 'ok';
  const inv = await one<{ id: number; code_hash: string; expired: boolean; attempts: number }>(
    `select id, code_hash, expires_at < now() as expired, attempts from invites
      where worker_id = $1 and used_at is null and revoked_at is null`,
    [workerId],
  );
  if (!inv) return 'expired';
  if (inv.expired) return 'expired';
  if (inv.attempts >= config.inviteMaxAttempts) return 'locked';
  const ok = timingSafeEqual(Buffer.from(inv.code_hash), Buffer.from(hash(workerId, code)));
  if (!ok) {
    await q('update invites set attempts = attempts + 1 where id = $1', [inv.id]);
    return inv.attempts + 1 >= config.inviteMaxAttempts ? 'locked' : 'wrong';
  }
  await q('update invites set used_at = now() where id = $1', [inv.id]);
  return 'ok';
}
