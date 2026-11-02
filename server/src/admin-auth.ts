// Admin accounts for the web dashboard: username + password (bcrypt via pgcrypto),
// bearer session tokens. Separate from worker sessions.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { one, q } from './db.js';
import { HttpError, sha256 } from './http.js';

export interface AdminCtx {
  id: number;
  role: 'owner' | 'admin' | 'viewer';
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin: AdminCtx;
  }
}

export async function checkPassword(username: string, password: string) {
  return one<{ id: number; name: string; title: string | null; role: AdminCtx['role']; must_change_password: boolean }>(
    `select id, name, title, role, must_change_password from admins
      where lower(username) = lower($1) and active and password_hash = crypt($2, password_hash)`,
    [username, password],
  );
}

export async function createAdminSession(adminId: number, remember: boolean) {
  const token = randomBytes(32).toString('base64url');
  await q(
    `insert into admin_sessions (token_hash, admin_id, expires_at) values ($1, $2, now() + $3::interval)`,
    [sha256(token), adminId, remember ? '30 days' : '12 hours'],
  );
  await q('update admins set last_login_at = now() where id = $1', [adminId]);
  return token;
}

export const adminBearer = (req: FastifyRequest) => {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
};

export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply) {
  const token = adminBearer(req);
  if (!token) throw new HttpError(401, 'unauthorized', '다시 로그인해 주세요.');
  const row = await one<AdminCtx>(
    `select a.id, a.role, a.name from admin_sessions s join admins a on a.id = s.admin_id
      where s.token_hash = $1 and s.expires_at > now() and a.active`,
    [sha256(token)],
  );
  if (!row) throw new HttpError(401, 'unauthorized', '다시 로그인해 주세요.');
  req.admin = row;
}

/** Viewers can look but not change anything. */
export async function requireEditor(req: FastifyRequest) {
  if (req.admin.role === 'viewer') throw new HttpError(403, 'forbidden', '보기 전용 계정이에요.');
}

export async function requireOwner(req: FastifyRequest) {
  if (req.admin.role !== 'owner') throw new HttpError(403, 'forbidden', '소유자만 할 수 있어요.');
}

export const hashPassword = async (password: string) =>
  (await one<{ h: string }>(`select crypt($1, gen_salt('bf', 10)) as h`, [password]))!.h;
