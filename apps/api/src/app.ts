import { config } from './core/config.js';
import { db } from './core/db.js';
import { send, Router, createServer } from './core/http.js';
import { HttpError } from './core/util.js';
import { installInbound } from './integrations/inbound.js';
import { ingestLeadgenWebhook } from './integrations/metaLeads.js';
import { storageRoutes } from './integrations/storage.js';
import { ingestWhatsAppWebhook, forwardWebhook, validSignature, verifyHandshake } from './integrations/whatsapp.js';
import { adminRoutes } from './modules/admin.js';
import { authRoutes } from './modules/auth.js';
import { crmRoutes } from './modules/crm.js';
import { businessRoutes } from './modules/business.js';
import { customerRoutes } from './modules/customer.js';
import { opsRoutes } from './modules/ops.js';
import { taskRoutes } from './modules/tasks.js';

export function buildApp() {
  const r = new Router();
  r.get('/api/health', async () => { await db.query('select 1'); return { ok: true, time: new Date().toISOString(), version: '1.5.0' }; });

  // Meta webhooks: GET handshake + signed POSTs. Always answer 200 quickly; processing happens in jobs.
  r.get('/api/v1/webhooks/whatsapp', ctx => {
    const c = verifyHandshake(ctx.query, config.WHATSAPP_VERIFY_TOKEN);
    if (c === null) throw new HttpError(403, 'Forbidden', 'forbidden');
    send(ctx.res, 200, c);
  });
  r.post('/api/v1/webhooks/whatsapp', async ctx => {
    if (!validSignature(ctx.rawBody, ctx.req.headers['x-hub-signature-256'] as string)) throw new HttpError(401, 'Bad signature', 'bad_signature');
    const payload = JSON.parse(ctx.rawBody.toString('utf8') || '{}');
    await ingestWhatsAppWebhook(payload);
    forwardWebhook(ctx.rawBody, payload);
    return { ok: true };
  });
  r.get('/api/v1/webhooks/meta-leads', ctx => {
    const c = verifyHandshake(ctx.query, config.META_LEADS_VERIFY_TOKEN);
    if (c === null) throw new HttpError(403, 'Forbidden', 'forbidden');
    send(ctx.res, 200, c);
  });
  r.post('/api/v1/webhooks/meta-leads', async ctx => {
    if (!validSignature(ctx.rawBody, ctx.req.headers['x-hub-signature-256'] as string)) throw new HttpError(401, 'Bad signature', 'bad_signature');
    const n = await ingestLeadgenWebhook(JSON.parse(ctx.rawBody.toString('utf8') || '{}'));
    return { ok: true, queued: n };
  });

  authRoutes(r); adminRoutes(r); crmRoutes(r); opsRoutes(r); taskRoutes(r); customerRoutes(r); businessRoutes(r); storageRoutes(r);
  installInbound();
  return createServer(r);
}
