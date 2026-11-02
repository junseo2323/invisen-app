import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { HttpError } from './http.js';
import { one } from './db.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { readingsRoutes } from './routes/readings.js';
import { siteRoutes } from './routes/site.js';
import { sosRoutes } from './routes/sos.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? { level: config.production ? 'info' : 'debug' },
    trustProxy: true, // behind nginx
    bodyLimit: 512 * 1024,
  });

  await app.register(cors, { origin: config.corsOrigins, credentials: false, methods: ['GET', 'POST', 'PUT', 'DELETE'] });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({ statusCode: 429, error: 'rate_limited', message: '요청이 너무 많아요. 잠시 뒤 다시 해주세요.' }),
  });

  app.setErrorHandler((err: FastifyError | HttpError | { statusCode: number; error: string; message: string }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const status = 'statusCode' in err && err.statusCode ? err.statusCode : 500;
    if (status === 429) return reply.code(429).send({ error: 'rate_limited', message: '요청이 너무 많아요. 잠시 뒤 다시 해주세요.' });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: 'bad_request', message: '요청을 처리할 수 없어요.' });
    req.log.error(err);
    return reply.code(500).send({ error: 'server_error', message: '잠시 문제가 생겼어요. 다시 시도해 주세요.' });
  });

  app.get('/api/health', async () => {
    await one('select 1');
    return { ok: true, version: process.env.GIT_SHA ?? 'dev' };
  });

  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(readingsRoutes);
  await app.register(siteRoutes);
  await app.register(sosRoutes);
  return app;
}
