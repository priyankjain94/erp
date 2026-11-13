import { config, metaLeadsLive } from '../core/config.js';
import { db, many, one, tx } from '../core/db.js';
import { enqueue, registerJob } from '../core/jobs.js';
import { log } from '../core/util.js';
import { createLead } from '../modules/crm.js';

const graph = (p: string) => `${config.META_GRAPH_BASE}/${config.META_GRAPH_VERSION}/${p}`;
const FIELDS = 'created_time,field_data,ad_id,ad_name,adset_name,campaign_name,form_id,platform';

/** Store each leadgen notification once, then process it in the background. */
export async function ingestLeadgenWebhook(payload: any) {
  let n = 0;
  for (const entry of payload?.entry || []) for (const ch of entry.changes || []) {
    if (ch.field !== 'leadgen') continue;
    const v = ch.value || {};
    const ins = await db.query(`insert into meta_leads_raw(leadgen_id, form_id, page_id, payload) values ($1,$2,$3,$4) on conflict do nothing`, [String(v.leadgen_id), v.form_id ? String(v.form_id) : null, v.page_id ? String(v.page_id) : null, v]);
    if (ins.rowCount) { await enqueue('meta.lead', { leadgenId: String(v.leadgen_id) }); n++; }
  }
  return n;
}

/** Map Meta lead form answers to a CRM lead. Field names follow Meta's standard questions; custom answers go into "interest". */
export function mapLead(data: any) {
  const f: Record<string, string> = {};
  for (const x of data.field_data || []) f[String(x.name).toLowerCase()] = Array.isArray(x.values) ? x.values.join(', ') : String(x.values ?? '');
  const name = f.full_name || [f.first_name, f.last_name].filter(Boolean).join(' ') || 'Meta lead';
  const phone = f.phone_number || f.phone || f.mobile || '';
  const std = new Set(['full_name', 'first_name', 'last_name', 'phone_number', 'phone', 'mobile', 'email', 'city', 'state', 'zip', 'post_code', 'street_address']);
  const custom = Object.entries(f).filter(([k]) => !std.has(k)).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
  const budget = Number(String(f.budget || f.your_budget || '').replace(/[^\d]/g, '')) || 0;
  return { name, phone, email: f.email || '', area: f.city || '', interest: custom.slice(0, 3).join('; ') || 'Interiors', value: budget, platform: data.platform === 'ig' ? 'Instagram lead form' : 'Meta lead form' };
}

registerJob('meta.lead', async ({ leadgenId }) => {
  const raw = await one(db, 'select * from meta_leads_raw where leadgen_id = $1', [leadgenId]);
  if (!raw || raw.lead_id) return;
  let data = raw.payload;
  if (!data.field_data) {
    if (!metaLeadsLive()) { log.warn('meta lead received but META_PAGE_ACCESS_TOKEN is not set; cannot fetch', leadgenId); return; }
    const res = await fetch(graph(`${leadgenId}?fields=${FIELDS}&access_token=${encodeURIComponent(config.META_PAGE_ACCESS_TOKEN)}`));
    data = await res.json();
    if (!res.ok) throw new Error(`Graph ${res.status}: ${data?.error?.message || 'lead fetch failed'}`);
    await db.query('update meta_leads_raw set payload = $2 where leadgen_id = $1', [leadgenId, { ...raw.payload, ...data }]);
  }
  const m = mapLead(data);
  if (!m.phone) { log.warn('meta lead without phone', leadgenId); return; }
  await tx(async q => {
    const out = await createLead(q, null, { name: m.name, phone: m.phone, source: 'online', sub: m.platform, interest: m.interest, value: m.value, area: m.area,
      meta: { leadgenId, formId: data.form_id || raw.form_id, adName: data.ad_name, campaignName: data.campaign_name } });
    await q.query('update meta_leads_raw set lead_id = $2 where leadgen_id = $1', [leadgenId, out.id]);
  });
});

/** Safety net: every 15 minutes pull leads created since the last sync, in case a webhook was missed. */
export async function pollLeads() {
  if (!metaLeadsLive()) return { skipped: true };
  const last = (await one(db, `select value from settings where key = 'meta_leads_last_sync'`))?.value || Math.floor(Date.now() / 1000) - 3600;
  const started = Math.floor(Date.now() / 1000);
  const formsRes = await fetch(graph(`${config.META_PAGE_ID}/leadgen_forms?fields=id,name,status&limit=100&access_token=${encodeURIComponent(config.META_PAGE_ACCESS_TOKEN)}`));
  const forms: any = await formsRes.json();
  if (!formsRes.ok) throw new Error('leadgen_forms: ' + (forms?.error?.message || formsRes.status));
  let found = 0;
  for (const f of forms.data || []) {
    const filtering = encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: last }]));
    let url: string | null = graph(`${f.id}/leads?fields=id,${FIELDS}&filtering=${filtering}&limit=100&access_token=${encodeURIComponent(config.META_PAGE_ACCESS_TOKEN)}`);
    while (url) {
      const res: Response = await fetch(url); const body: any = await res.json();
      if (!res.ok) throw new Error('leads: ' + (body?.error?.message || res.status));
      for (const l of body.data || []) {
        const ins = await db.query(`insert into meta_leads_raw(leadgen_id, form_id, page_id, payload) values ($1,$2,$3,$4) on conflict do nothing`, [String(l.id), String(f.id), config.META_PAGE_ID, l]);
        if (ins.rowCount) { await enqueue('meta.lead', { leadgenId: String(l.id) }); found++; }
      }
      url = body.paging?.next || null;
    }
  }
  await db.query(`insert into settings(key, value) values ('meta_leads_last_sync', $1) on conflict (key) do update set value = excluded.value`, [JSON.stringify(started - 120)]);
  return { found };
}

let lastPoll = 0;
export async function metaLeadsTick() { if (Date.now() - lastPoll < 15 * 60_000) return; lastPoll = Date.now(); try { await pollLeads(); } catch (e: any) { log.warn('meta poll', e.message); } }

/** One-time: install the app on the Page so Meta sends leadgen webhooks. */
export async function subscribePage() {
  const res = await fetch(graph(`${config.META_PAGE_ID}/subscribed_apps?subscribed_fields=leadgen&access_token=${encodeURIComponent(config.META_PAGE_ACCESS_TOKEN)}`), { method: 'POST' });
  return res.json();
}
export async function recentMetaLeads() { return many(db, 'select leadgen_id, lead_id, created_at from meta_leads_raw order by created_at desc limit 20'); }
