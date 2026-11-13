import crypto from 'node:crypto';
import { config, whatsappLive } from '../core/config.js';
import { db, one, type Q } from '../core/db.js';
import { enqueue, registerJob } from '../core/jobs.js';
import { log, normPhone, safeEqual, waNumber } from '../core/util.js';
import { renderTemplate, WA_TEMPLATES } from '../domain.js';

export interface SendOpts { q?: Q; related?: { type: string; id: string }; buttons?: string[] /* quick-reply payloads, in button order */ }
const graph = (p: string) => `${config.META_GRAPH_BASE}/${config.META_GRAPH_VERSION}/${p}`;

/* ---------- template mapping ----------
 * Every message the app sends has an internal name (WA_TEMPLATES). Each one is sent through a Meta template:
 * either one the business already made in WhatsApp Manager (mapped below or in Admin → Integrations),
 * or `mms_<internal name>`, which "Sync templates" creates when it doesn't exist yet.
 * params: which of the app's values go into {{1}}, {{2}}… (0-based index into the app's values, or literal text). */
export interface TplMap { name: string; params?: (number | string)[]; buttons?: boolean }
export const DEFAULT_TEMPLATE_MAP: Record<string, TplMap> = {
  welcome_catalogue: { name: 'mms_quotation_request', params: [0], buttons: false },
  follow_up_gentle: { name: 'mms_followup_day3', params: [0], buttons: false },
  quote_followup: { name: 'mms_followup_day7', params: [0], buttons: false }
};
export interface MetaTpl { name: string; language: string; status: string; category: string; params: number; quickReplies: number }
async function settingsValue<T>(key: string, fallback: T, q: Q = db): Promise<T> { return ((await one(q, 'select value from settings where key = $1', [key]))?.value ?? fallback) as T; }
async function saveSetting(key: string, value: unknown) { await db.query(`insert into settings(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]); }
export async function templateMap(q: Q = db) {
  const custom = await settingsValue<Record<string, TplMap>>('wa_template_map', {}, q);
  const out: Record<string, TplMap> = {};
  for (const k of Object.keys(WA_TEMPLATES)) out[k] = custom[k]?.name ? custom[k] : DEFAULT_TEMPLATE_MAP[k] || { name: 'mms_' + k };
  return out;
}
export async function saveTemplateMap(map: Record<string, TplMap>) {
  const clean: Record<string, TplMap> = {};
  for (const [k, v] of Object.entries(map)) if (WA_TEMPLATES[k] && v?.name) clean[k] = { name: String(v.name).trim(), ...(v.params ? { params: v.params.slice(0, 10) } : {}), ...(v.buttons === false ? { buttons: false } : {}) };
  await saveSetting('wa_template_map', clean);
}
export const metaTemplates = (q: Q = db) => settingsValue<MetaTpl[]>('wa_templates_meta', [], q);

/** Reads the templates that already exist on the WhatsApp Business Account (name, language, status, how many {{n}} and buttons). */
export async function fetchMetaTemplates(): Promise<MetaTpl[]> {
  if (!config.WHATSAPP_ACCESS_TOKEN || !config.WHATSAPP_WABA_ID) throw new Error('Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_WABA_ID first');
  const out: MetaTpl[] = [];
  let url: string | null = graph(`${config.WHATSAPP_WABA_ID}/message_templates?fields=name,language,status,category,components&limit=100`);
  for (let page = 0; url && page < 20; page++) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` } });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Meta: ${body?.error?.message || res.status}`);
    for (const t of body.data || []) {
      const bodyText = (t.components || []).find((c: any) => c.type === 'BODY')?.text || '';
      const nums = (bodyText.match(/\{\{(\d+)\}\}/g) || []).map((x: string) => Number(x.replace(/\D/g, '')));
      const btns = (t.components || []).find((c: any) => c.type === 'BUTTONS')?.buttons || [];
      out.push({ name: t.name, language: t.language, status: t.status, category: t.category, params: nums.length ? Math.max(...nums) : 0, quickReplies: btns.filter((b: any) => b.type === 'QUICK_REPLY').length });
    }
    url = body.paging?.next || null;
  }
  await saveSetting('wa_templates_meta', out);
  return out;
}

/** Queue a template message. Runs after the surrounding transaction commits. */
export async function sendTemplate(phone: string, name: string, params: string[], opts: SendOpts = {}) {
  const to = normPhone(phone); if (!to) return;
  const q = opts.q || db;
  const opted = await one(q, 'select opted_out_at from wa_contacts where phone = $1', [to]);
  if (opted?.opted_out_at && WA_TEMPLATES[name]?.category === 'MARKETING') return;
  const row = await one<{ id: number }>(q,
    `insert into wa_messages(direction, phone, kind, template, body, payload, status, related_type, related_id)
     values ('out', $1, 'template', $2, $3, $4, 'queued', $5, $6) returning id`,
    [to, name, WA_TEMPLATES[name]?.category === 'AUTHENTICATION' ? renderTemplate(name, ['••••']) : renderTemplate(name, params), { params, buttons: opts.buttons || [] }, opts.related?.type || null, opts.related?.id || null]);
  await enqueue('wa.send', { id: row!.id }, { q });
  return row!.id;
}

/** Queue a free-form text. Only allowed inside the 24-hour customer service window. */
export async function sendText(phone: string, text: string, opts: SendOpts = {}) {
  const to = normPhone(phone); if (!to) return;
  const q = opts.q || db;
  const row = await one<{ id: number }>(q,
    `insert into wa_messages(direction, phone, kind, body, status, related_type, related_id) values ('out', $1, 'text', $2, 'queued', $3, $4) returning id`,
    [to, text, opts.related?.type || null, opts.related?.id || null]);
  await enqueue('wa.send', { id: row!.id }, { q });
  return row!.id;
}

export async function windowOpen(phone: string, q: Q = db) {
  const r = await one(q, `select last_inbound_at > now() - interval '24 hours' as open from wa_contacts where phone = $1`, [normPhone(phone)]);
  return !!r?.open;
}

async function buildPayload(m: any) {
  if (m.kind === 'text') return { messaging_product: 'whatsapp', to: waNumber(m.phone), type: 'text', text: { body: m.body, preview_url: false } };
  const t = WA_TEMPLATES[m.template];
  const map = (await templateMap())[m.template] || { name: m.template };
  const known = (await metaTemplates()).filter(x => x.name === map.name);
  const meta = known.find(x => x.language === config.WHATSAPP_TEMPLATE_LANG) || known.find(x => x.status === 'APPROVED') || known[0];
  const raw: string[] = m.payload?.params || [];
  let params: string[] = map.params ? map.params.map(p => typeof p === 'number' ? String(raw[p] ?? '') : String(p)) : raw;
  if (meta) { params = params.slice(0, meta.params); while (params.length < meta.params) params.push('-'); }
  const components: any[] = [];
  if (params.length) components.push({ type: 'body', parameters: params.map(text => ({ type: 'text', text: String(text || '-').replace(/\s*\n\s*/g, ' ').slice(0, 1000) })) });
  if (t?.category === 'AUTHENTICATION') {
    // Copy-code OTP templates need the code twice: in the body and in the button.
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: params[0] }] });
  }
  const maxButtons = map.buttons === false ? 0 : meta ? meta.quickReplies : 10;
  (m.payload?.buttons || []).slice(0, maxButtons).forEach((payload: string, i: number) => {
    if (payload) components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }] });
  });
  return { messaging_product: 'whatsapp', to: waNumber(m.phone), type: 'template', template: { name: map.name, language: { code: meta?.language || config.WHATSAPP_TEMPLATE_LANG }, components } };
}

registerJob('wa.send', async ({ id }) => {
  const m = await one(db, 'select * from wa_messages where id = $1', [id]);
  if (!m || m.status !== 'queued') return;
  const isOtp = WA_TEMPLATES[m.template]?.category === 'AUTHENTICATION';
  // Login / sign-off codes are never kept after use: the params are wiped once sent, and an expired code is not sent at all.
  const redact = () => isOtp ? db.query(`update wa_messages set payload = '{"params":["redacted"]}'::jsonb where id = $1`, [id]) : null;
  if (isOtp && Date.now() - new Date(m.created_at).getTime() > config.OTP_TTL_MIN * 60_000) {
    await db.query(`update wa_messages set status = 'expired', updated_at = now() where id = $1`, [id]); await redact(); return;
  }
  if (!whatsappLive()) {
    await db.query(`update wa_messages set status = 'simulated', updated_at = now() where id = $1`, [id]);
    if (m.related_type === 'lead_message') await db.query(`update lead_messages set status = 'simulated' where id = $1`, [Number(m.related_id)]);
    // Simulated mode only (no token): the code is printed to the server log so the first admin can log in before WhatsApp is connected.
    log.info('[whatsapp simulated]', m.phone, m.template || 'text', '-', isOtp ? `code ${m.payload?.params?.[0]}` : String(m.body).slice(0, 80));
    await redact(); return;
  }
  const res = await fetch(graph(`${config.WHATSAPP_PHONE_NUMBER_ID}/messages`), {
    method: 'POST', headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(await buildPayload(m))
  });
  const body: any = await res.json().catch(() => ({}));
  if (res.ok && body.messages?.[0]?.id) {
    await db.query(`update wa_messages set status = 'sent', wamid = $2, updated_at = now() where id = $1`, [id, body.messages[0].id]);
    if (m.related_type === 'lead_message') await db.query(`update lead_messages set status = 'sent', wamid = $2 where id = $1`, [Number(m.related_id), body.messages[0].id]);
    await redact(); return;
  }
  const err = body?.error ? `${body.error.code} ${body.error.message}` : `HTTP ${res.status}`;
  // Retry rate limits and server errors; give up on permanent errors (bad template, invalid number…).
  if (res.status === 429 || res.status >= 500) throw new Error(err);
  await db.query(`update wa_messages set status = 'failed', error = $2, updated_at = now() where id = $1`, [id, err]);
  if (m.related_type === 'lead_message') await db.query(`update lead_messages set status = 'failed' where id = $1`, [Number(m.related_id)]);
  log.warn('whatsapp send failed', m.phone, err);
});

/* ---------- webhooks ---------- */
export function verifyHandshake(query: URLSearchParams, expected: string) {
  if (query.get('hub.mode') === 'subscribe' && expected && query.get('hub.verify_token') === expected) return query.get('hub.challenge') || '';
  return null;
}
/** X-Hub-Signature-256 = 'sha256=' + HMAC-SHA256(raw body, app secret). */
export function validSignature(raw: Buffer, header: string | undefined) {
  if (!config.META_APP_SECRET) return config.NODE_ENV !== 'production'; // dev without secret: accept; production: refuse
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.META_APP_SECRET).update(raw).digest('hex');
  return safeEqual(expected, header);
}

export interface Inbound { from: string; name?: string; id: string; text?: string; buttonPayload?: string; type: string; at: Date }
type InboundHandler = (m: Inbound) => Promise<void>;
let inboundHandler: InboundHandler = async () => {};
export function onInbound(fn: InboundHandler) { inboundHandler = fn; }

/** Store-then-process: each message/status is recorded once (idempotent on its id) and processed by a job. */
export async function ingestWhatsAppWebhook(payload: any) {
  for (const entry of payload?.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    const names = Object.fromEntries((v.contacts || []).map((c: any) => [c.wa_id, c.profile?.name]));
    for (const m of v.messages || []) {
      const ins = await db.query(`insert into webhook_events(source, external_id, payload) values ('wa.message', $1, $2) on conflict do nothing`, [m.id, { ...m, _name: names[m.from] }]);
      if (ins.rowCount) await enqueue('wa.inbound', { id: m.id });
    }
    for (const s of v.statuses || []) {
      const key = `${s.id}:${s.status}`;
      const ins = await db.query(`insert into webhook_events(source, external_id, payload) values ('wa.status', $1, $2) on conflict do nothing`, [key, s]);
      if (ins.rowCount) {
        await db.query(`update wa_messages set status = $2, pricing = coalesce($3, pricing), error = $4, updated_at = now() where wamid = $1`,
          [s.id, s.status, s.pricing || null, s.errors?.[0] ? `${s.errors[0].code} ${s.errors[0].title}` : null]);
        await db.query(`update lead_messages set status = $2 where wamid = $1`, [s.id, s.status]);
        await db.query(`update webhook_events set processed_at = now() where source = 'wa.status' and external_id = $1`, [key]);
      }
    }
  }
}

registerJob('wa.inbound', async ({ id }) => {
  const ev = await one(db, `select payload, processed_at from webhook_events where source = 'wa.message' and external_id = $1`, [id]);
  if (!ev || ev.processed_at) return;
  const m = ev.payload;
  const from = normPhone('+' + m.from);
  const inbound: Inbound = {
    from, name: m._name, id: m.id, type: m.type, at: new Date(Number(m.timestamp || Date.now() / 1000) * 1000),
    text: m.text?.body || m.button?.text || m.interactive?.button_reply?.title,
    buttonPayload: m.button?.payload || m.interactive?.button_reply?.id
  };
  await db.query(`insert into wa_contacts(phone, name, last_inbound_at) values ($1, $2, $3)
                  on conflict (phone) do update set last_inbound_at = greatest(wa_contacts.last_inbound_at, excluded.last_inbound_at), name = coalesce(excluded.name, wa_contacts.name)`,
    [from, inbound.name || null, inbound.at]);
  await db.query(`insert into wa_messages(direction, wamid, phone, kind, body, payload, status) values ('in', $1, $2, $3, $4, $5, 'received') on conflict (wamid) do nothing`,
    [m.id, from, m.type, inbound.text || '', m]);
  if (/^\s*stop\s*$/i.test(inbound.text || '')) await db.query('update wa_contacts set opted_out_at = now() where phone = $1', [from]);
  await inboundHandler(inbound);
  await db.query(`update webhook_events set processed_at = now() where source = 'wa.message' and external_id = $1`, [id]);
});

/** Create / sync templates in Meta (WhatsApp Manager) from WA_TEMPLATES. Used by the admin setup script. */
/** Reads what already exists on the WhatsApp Business Account and creates only the templates the app still needs.
 *  Existing templates (yours from WhatsApp Manager) are never changed. */
export async function syncTemplates(opts: { create?: boolean } = { create: true }) {
  if (!config.WHATSAPP_ACCESS_TOKEN || !config.WHATSAPP_WABA_ID) throw new Error('Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_WABA_ID first');
  const existing = await fetchMetaTemplates();
  const map = await templateMap();
  const results: { internal: string; name: string; status: string }[] = [];
  const created = new Set<string>();
  for (const [internal, t] of Object.entries(WA_TEMPLATES)) {
    const name = map[internal].name;
    const have = existing.filter(x => x.name === name);
    if (have.length) { results.push({ internal, name, status: have.map(x => `${x.status.toLowerCase()} (${x.language})`).join(', ') }); continue; }
    if (created.has(name)) { results.push({ internal, name, status: 'submitted' }); continue; }
    if (!opts.create) { results.push({ internal, name, status: 'missing' }); continue; }
    const components: any[] = [];
    if (t.category === 'AUTHENTICATION') {
      components.push({ type: 'body', add_security_recommendation: true }, { type: 'footer', code_expiration_minutes: config.OTP_TTL_MIN }, { type: 'buttons', buttons: [{ type: 'otp', otp_type: 'copy_code', text: 'Copy code' }] });
    } else {
      const n = (t.body.match(/\{\{\d+\}\}/g) || []).length;
      components.push({ type: 'BODY', text: t.body, ...(n ? { example: { body_text: [Array.from({ length: n }, (_, i) => 'sample' + (i + 1))] } } : {}) });
      if (t.buttons?.length) components.push({ type: 'BUTTONS', buttons: t.buttons.map(text => ({ type: 'QUICK_REPLY', text })) });
    }
    const res = await fetch(graph(`${config.WHATSAPP_WABA_ID}/message_templates`), {
      method: 'POST', headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, language: config.WHATSAPP_TEMPLATE_LANG, category: t.category, ...(t.category === 'AUTHENTICATION' ? { message_send_ttl_seconds: config.OTP_TTL_MIN * 60 } : {}), components })
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok) created.add(name);
    results.push({ internal, name, status: res.ok ? `created, ${String(body.status || 'pending').toLowerCase()}` : `error: ${body?.error?.error_user_msg || body?.error?.message || res.status}` });
  }
  if (created.size) await fetchMetaTemplates().catch(() => null);
  return results;
}

/** Keeps the business's existing WhatsApp bot working: every webhook the ERP receives is relayed to it,
 *  except taps on the ERP's own buttons (task / drawing approvals), which only the ERP understands. */
export function forwardWebhook(raw: Buffer, payload: any, signature?: string) {
  if (!config.WHATSAPP_FORWARD_URL) return;
  const msgs = (payload?.entry || []).flatMap((e: any) => (e.changes || []).flatMap((c: any) => c.value?.messages || []));
  const ours = (m: any) => /^(TASK_|DRAWING_|RATE:)/.test(m?.button?.payload || m?.interactive?.button_reply?.id || '');
  if (msgs.length && msgs.every(ours)) return;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // the body is relayed byte-for-byte, so Meta's own signature stays valid for the bot
  const sig = signature || (config.META_APP_SECRET ? 'sha256=' + crypto.createHmac('sha256', config.META_APP_SECRET).update(raw).digest('hex') : '');
  if (sig) headers['X-Hub-Signature-256'] = sig;
  fetch(config.WHATSAPP_FORWARD_URL, { method: 'POST', headers, body: new Uint8Array(raw), signal: AbortSignal.timeout(8000) })
    .then(r => { if (!r.ok) log.warn('whatsapp forward', r.status); }).catch(e => log.warn('whatsapp forward failed', String(e?.message || e)));
}
