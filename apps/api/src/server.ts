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

async function main() {
  assertProductionConfig();
  await migrate();
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
