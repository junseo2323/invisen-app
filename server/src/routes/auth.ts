import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { one, q } from '../db.js';
import { config } from '../config.js';
import { HttpError, parse, sha256, normalizePhone, createSession, requireAuth, bearer } from '../http.js';
import { sms } from '../sms.js';
import { loadMe } from '../queries.js';
import type { OtpResponse, VerifyResponse } from '../api-types.js';

const phoneSchema = z.object({ phone: z.string().transform(normalizePhone).pipe(z.string().regex(/^01\d{8,9}$/)) });
const verifySchema = phoneSchema.extend({ code: z.string().regex(/^\d{6}$/) });

const otpHash = (phone: string, code: string) => sha256(`${config.otpSecret}:${phone}:${code}`);

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/api/auth/otp',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour',
          hook: 'preHandler',
          keyGenerator: (req) => `otp:${normalizePhone(String((req.body as { phone?: string })?.phone ?? ''))}`,
        },
      },
    },
    async (req): Promise<OtpResponse> => {
      const { phone } = parse(phoneSchema, req.body);
      const recent = await one<{ wait: number }>(
        `select extract(epoch from (sent_at + make_interval(secs => $2) - now()))::int as wait
           from otp_codes where phone = $1 and sent_at > now() - make_interval(secs => $2)`,
        [phone, config.otpResendSec],
      );
      if (recent) throw new HttpError(429, 'too_soon', `${Math.max(1, recent.wait)}초 뒤에 다시 받을 수 있어요.`);

      const worker = await one('select id from workers where phone = $1 and active', [phone]);
      // Same response whether or not the number is registered (no account probing).
      if (worker) {
        const code = config.otpDevCode ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
        await q(
          `insert into otp_codes (phone, code_hash, expires_at, attempts, sent_at)
           values ($1, $2, now() + make_interval(secs => $3), 0, now())
           on conflict (phone) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = now()`,
          [phone, otpHash(phone, code), config.otpTtlSec],
        );
        await sms.send(phone, `[invisen] 인증번호 ${code} (3분 안에 입력해 주세요)`);
      } else {
        await q(
          `insert into otp_codes (phone, code_hash, expires_at, sent_at) values ($1, '', now(), now())
           on conflict (phone) do update set code_hash = '', expires_at = now(), sent_at = now()`,
          [phone],
        );
      }
      return { ttlSec: config.otpTtlSec, resendSec: config.otpResendSec };
    },
  );

  app.post(
    '/api/auth/verify',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req): Promise<VerifyResponse> => {
      const { phone, code } = parse(verifySchema, req.body);
      const row = await one<{ code_hash: string; expired: boolean; attempts: number }>(
        'select code_hash, expires_at < now() as expired, attempts from otp_codes where phone = $1',
        [phone],
      );
      if (!row || !row.code_hash || row.expired) throw new HttpError(400, 'expired', '인증번호가 만료됐어요. 다시 받아주세요.');
      if (row.attempts >= config.otpMaxAttempts) throw new HttpError(429, 'too_many_attempts', '여러 번 틀렸어요. 인증번호를 다시 받아주세요.');
      const ok = timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(otpHash(phone, code)));
      if (!ok) {
        await q('update otp_codes set attempts = attempts + 1 where phone = $1', [phone]);
        throw new HttpError(400, 'invalid_code', '인증번호가 맞지 않아요.');
      }
      await q('delete from otp_codes where phone = $1', [phone]);
      const worker = await one<{ id: number }>('select id from workers where phone = $1 and active', [phone]);
      if (!worker) throw new HttpError(400, 'invalid_code', '인증번호가 맞지 않아요.');
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
