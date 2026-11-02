import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { pool } from './db.js';
import { startWatchdog } from './watchdog.js';

await migrate((m) => console.log(m));
const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
const stopWatchdog = startWatchdog((e) => app.log.error(e));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    stopWatchdog();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
