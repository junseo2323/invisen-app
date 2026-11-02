import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { one, q } from './db.js';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'invalid_request', '입력값을 확인해 주세요.');
  return r.data;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const normalizePhone = (s: string) => s.replace(/\D/g, '');

declare module 'fastify' {
  interface FastifyRequest {
    worker: { id: number; siteId: number };
  }
}

export async function createSession(workerId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await q(
    `insert into sessions (token_hash, worker_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), workerId, config.sessionDays],
  );
  return token;
}

/** preHandler: requires `Authorization: Bearer <token>`. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'unauthorized', '다시 로그인해 주세요.');
  const row = await one<{ worker_id: number; site_id: number }>(
    `update sessions s set last_seen_at = now()
       from workers w
      where s.token_hash = $1 and s.expires_at > now() and w.id = s.worker_id and w.active
      returning s.worker_id, w.site_id`,
    [sha256(token)],
  );
  if (!row) throw new HttpError(401, 'unauthorized', '다시 로그인해 주세요.');
  req.worker = { id: row.worker_id, siteId: row.site_id };
}

export function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
