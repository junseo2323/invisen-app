// Endpoints for managers / the admin dashboard. A manager is a worker with role 'manager'
// and acts only on workers of their own site.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one } from '../db.js';
import { HttpError, normalizePhone, parse, requireAuth } from '../http.js';
import { issueInvite } from '../invites.js';
import type { InviteResponse } from '../api-types.js';

async function requireManager(req: FastifyRequest) {
  const m = await one('select 1 from workers where id = $1 and role = $2 and active', [req.worker.id, 'manager']);
  if (!m) throw new HttpError(403, 'forbidden', '관리자만 할 수 있어요.');
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireManager);

  /** Issue a one-time login code for a worker (replaces any earlier unused code). */
  app.post('/api/admin/invites', async (req): Promise<InviteResponse> => {
    const body = parse(
      z.object({
        workerId: z.number().int().positive().optional(),
        phone: z.string().transform(normalizePhone).optional(),
        ttlHours: z.number().int().min(1).max(24 * 14).optional(),
      }),
      req.body,
    );
    if (!body.workerId && !body.phone) throw new HttpError(400, 'invalid_request', '작업자를 골라주세요.');
    const w = await one<{ id: number; name: string; phone: string }>(
      `select id, name, phone from workers where active and site_id = $1 and (id = $2 or phone = $3)`,
      [req.worker.siteId, body.workerId ?? null, body.phone ?? null],
    );
    if (!w) throw new HttpError(404, 'not_found', '이 현장에 등록된 작업자가 아니에요.');
    const inv = await issueInvite(w.id, req.worker.id, body.ttlHours);
    return { ...inv, worker: { id: w.id, name: w.name, phone: w.phone } };
  });
}
