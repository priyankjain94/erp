import crypto from 'node:crypto';
import { assertProductionConfig, config } from './core/config.js';
import { one, pool, tx } from './core/db.js';
import { startWorker, stopWorker } from './core/jobs.js';
import { migrate } from './core/migrate.js';
import { log } from './core/util.js';
import { buildApp } from './app.js';
import { metaLeadsTick } from './integrations/metaLeads.js';
import { crmTick } from './modules/crm.js';
import { startScheduler, stopScheduler } from './modules/tasks.js';
import { bootstrap, seedDemo } from './seed.js';

/** JWT secrets: env vars win; otherwise generate once and keep them in the database, so nobody has to paste them anywhere. */
async function loadSecrets() {
  for (const k of ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    if (process.env[k]) continue;
    await pool.query('insert into app_secrets(key, value) values ($1, $2) on conflict (key) do nothing', [k, crypto.randomBytes(48).toString('base64url')]);
    (config as any)[k] = (await pool.query('select value from app_secrets where key = $1', [k])).rows[0].value;
  }
}

async function main() {
  await migrate();
  await loadSecrets();
  assertProductionConfig();
  await tx(async q => {
    const empty = Number((await one(q, 'select count(*) n from users'))!.n) === 0;
    if (config.SEED_DEMO && empty) { await seedDemo(q); log.warn('Demo data loaded (SEED_DEMO=true)'); }
    await bootstrap(q);
  });
  const server = buildApp();
  server.listen(config.PORT, () => log.info(`Make My Space API on :${config.PORT} (${config.NODE_ENV})${config.DEMO_MODE ? ' — DEMO MODE' : ''}${config.WHATSAPP_ACCESS_TOKEN ? '' : ' — WhatsApp simulated'}`));
  if (config.WORKER_ENABLED) startWorker();
  if (config.SCHEDULER_ENABLED) startScheduler([crmTick, metaLeadsTick]);
  const stop = async (sig: string) => {
    log.info('shutting down', sig);
    stopScheduler(); stopWorker();
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
}
main().catch(e => { console.error(e); process.exit(1); });
