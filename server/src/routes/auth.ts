import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.js';
import { HttpError, parse, sha256, normalizePhone, createSession, requireAuth, bearer } from '../http.js';
import { checkInvite } from '../invites.js';
import { loadMe } from '../queries.js';
import type { LoginResponse } from '../api-types.js';

const loginSchema = z.object({
  phone: z.string().transform(normalizePhone).pipe(z.string().regex(/^01\d{8,9}$/)),
  code: z.string().regex(/^\d{6}$/),
});

const WRONG = '등록 코드가 맞지 않아요. 번호와 코드를 확인해 주세요.';

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
          hook: 'preHandler',
          keyGenerator: (req) => `login:${req.ip}:${normalizePhone(String((req.body as { phone?: string })?.phone ?? ''))}`,
        },
      },
    },
    async (req): Promise<LoginResponse> => {
      const { phone, code } = parse(loginSchema, req.body);
      const worker = await one<{ id: number }>('select id from workers where phone = $1 and active', [phone]);
      // unknown numbers get the same answer as a wrong code (no account probing)
      if (!worker) throw new HttpError(400, 'invalid_code', WRONG);
      const r = await checkInvite(worker.id, code);
      if (r === 'wrong') throw new HttpError(400, 'invalid_code', WRONG);
      if (r === 'expired') throw new HttpError(400, 'expired', '쓸 수 있는 등록 코드가 없어요. 반장님께 새 코드를 받아주세요.');
      if (r === 'locked') throw new HttpError(429, 'locked', '여러 번 틀려서 이 코드는 잠겼어요. 반장님께 새 코드를 받아주세요.');
      const token = await createSession(worker.id);
      return { token, me: await loadMe(worker.id) };
    },
  );

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    await q('delete from sessions where token_hash = $1', [sha256(bearer(req))]);
    await q('delete from push_tokens where worker_id = $1', [req.worker.id]);
    return reply.code(204).send();
  });
}
