// Applies migrations/*.sql in name order, once each. Safe to run on every deploy.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
// works from src/ (tsx) and dist/src/ (built)
const candidates = [join(here, '../migrations'), join(here, '../../migrations')];

export async function migrate(log = console.log) {
  const dir = candidates.find((d) => {
    try {
      return readdirSync(d).length > 0;
    } catch {
      return false;
    }
  });
  if (!dir) throw new Error('migrations directory not found');
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(727001)');
    await c.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await c.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await c.query('begin');
      try {
        await c.query(readFileSync(join(dir, file), 'utf8'));
        await c.query('insert into schema_migrations (name) values ($1)', [file]);
        await c.query('commit');
        log(`migrated ${file}`);
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
