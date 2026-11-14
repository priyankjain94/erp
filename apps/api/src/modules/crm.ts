import { z } from 'zod';
import { db, many, one, tx, type Q } from '../core/db.js';
import { parse, type Ctx, type Router } from '../core/http.js';
import { addDays, bad, first, fmtDate, forbidden, inr, normPhone, notFound, prettyPhone, todayStr } from '../core/util.js';
import { leadStageName, LEAD_STAGE_IDS, LOST_REASONS, SOURCE_IDS, sourceOf, WA_TEMPLATES, renderTemplate } from '../domain.js';
import { sendTemplate, sendText, windowOpen } from '../integrations/whatsapp.js';
import { audit, staff, userOf, type Principal } from './auth.js';
import { createProject, ScopeLineZ } from './ops.js';
import { staffState } from './state.js';
import { pushTask } from './tasks.js';

type U = Extract<Principal, { type: 'user' }>;
const tl = (q: Q, leadId: string, text: string, auto = false) => q.query('insert into lead_timeline(lead_id, text, auto) values ($1,$2,$3)', [leadId, text, auto]);
const autoOn = async (q: Q, id: string) => !!(await one(q, 'select enabled from automations where id = $1', [id]))?.enabled;
const bump = (q: Q, id: string) => q.query('update automations set runs = runs + 1 where id = $1', [id]);
async function ownerIdByName(q: Q, nameOrId: string) {
  const u = await one(q, `select id from users where (id = $1 or lower(name) = lower($1)) and active limit 1`, [nameOrId]);
  return u?.id || null;
}
async function refName(q: Q, lead: any) {
  if (lead.ref_partner_id) return (await one(q, 'select name from partners where id = $1', [lead.ref_partner_id]))?.name || '';
  if (lead.ref_lead_id) return (await one(q, 'select name from leads where id = $1', [lead.ref_lead_id]))?.name || '';
  return '';
}

export interface NewLead { name: string; phone: string; source: string; sub?: string; ref?: string | null; showroom?: string; interest?: string; value?: number; area?: string; owner?: string; meta?: { leadgenId: string; formId?: string; adName?: string; campaignName?: string } }
/** Create a lead and run the "new lead" automations. Returns the lead id. */
export async function createLead(q: Q, by: U | null, f: NewLead) {
  const phone = normPhone(f.phone); if (!phone) throw bad('Enter a 10-digit mobile number.');
  const src = sourceOf(f.source); if (!src) throw bad('Pick where this client came from.');
  let partnerId: string | null = null, refLeadId: string | null = null, ownerId: string | null = null;
  if (src.family === 'partner') {
    const p = f.ref ? await one(q, 'select id, owner_id, name, type from partners where id = $1', [f.ref]) : null;
    if (!p || p.type !== f.source) throw bad('Choose the partner who sent this client, so they get credit.');
    partnerId = p.id; ownerId = p.owner_id;
  } else if (src.family === 'referral') {
    const l = f.ref ? await one(q, `select id from leads where id = $1 and stage = 'won'`, [f.ref]) : null;
    if (!l) throw bad('Choose the client who referred them.');
    refLeadId = l.id;
  }
  if (!ownerId && f.owner) ownerId = await ownerIdByName(q, f.owner);
  if (!ownerId) ownerId = (await one(q, `select u.id from users u left join leads l on l.owner_id = u.id and l.created_at > now() - interval '30 days'
                                          where u.role = 'sales' and u.active group by u.id order by count(l.id), min(u.created_at) limit 1`))?.id || null;
  const dup = await one(q, 'select id from leads where phone = $1 limit 1', [phone]);
  const id = 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  await q.query(`insert into leads(id, name, phone, source, sub, ref_partner_id, ref_lead_id, showroom, owner_id, value, interest, area, follow_up, dup_flag, meta_leadgen_id, meta_form_id, meta_ad_name, meta_campaign_name)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id, f.name.trim(), phone, f.source, f.sub || '', partnerId, refLeadId, f.source === 'walkin' ? f.showroom || '' : '', ownerId, Math.round(f.value || 0), f.interest || 'Interiors', f.area || '', todayStr(), !!dup,
     f.meta?.leadgenId || null, f.meta?.formId || null, f.meta?.adName || null, f.meta?.campaignName || null]);
  const by_ = partnerId || refLeadId ? await refName(q, { ref_partner_id: partnerId, ref_lead_id: refLeadId }) : '';
  await tl(q, id, `Lead created · ${src.name}${f.sub ? ' · ' + f.sub : ''}${by_ ? ' · referred by ' + by_ : ''}${f.source === 'walkin' && f.showroom ? ' · ' + f.showroom + ' showroom' : ''}${f.meta?.campaignName ? ' · campaign ' + f.meta.campaignName : ''}`);
  const ownerName = ownerId ? (await one(q, 'select name from users where id = $1', [ownerId]))!.name : 'our team';
  if (await autoOn(q, 'a1')) {
    const params = [first(f.name), ownerName];
    const mid = await one(q, `insert into lead_messages(lead_id, from_kind, text, tpl, status) values ($1, 'auto', $2, 'welcome_catalogue', 'queued') returning id`, [id, renderTemplate('welcome_catalogue', params)]);
    await sendTemplate(phone, 'welcome_catalogue', params, { q, related: { type: 'lead_message', id: String(mid!.id) } });
    await tl(q, id, 'Welcome template sent', true); await bump(q, 'a1');
  }
  if (partnerId && await autoOn(q, 'a11')) { await tl(q, id, `${by_} thanked on WhatsApp`, true); await bump(q, 'a11'); }
  if (refLeadId && await autoOn(q, 'a14')) { await tl(q, id, `${by_} thanked for the referral`, true); await bump(q, 'a14'); }
  if (dup) await tl(q, id, 'Duplicate number: flagged for manager review');
  if (ownerId) await pushTask(q, { title: `Call new lead · ${f.name.trim()}`, assignee: ownerId, assigner: by?.user.id || ownerId, deadline: todayStr(), priority: 'urgent', notify: true });
  if (by) await audit(q, by, 'lead.create', `Added lead ${f.name.trim()} (${src.name})`, 'lead', id);
  return { id, dup: !!dup, ownerName };
}

export async function moveLead(q: Q, by: U, id: string, stage: string, reason = '') {
  const l = await one(q, 'select * from leads where id = $1 for update', [id]); if (!l) throw notFound('Lead not found');
  if (l.stage === stage) return { notes: [] as string[] };
  if (stage === 'lost' && !LOST_REASONS.includes(reason)) throw bad('Pick a lost reason.');
  await q.query(`update leads set stage = $2, lost_reason = case when $2 = 'lost' then $3 else lost_reason end, follow_up = case when $2 in ('won','lost') then null else follow_up end, stage_changed_at = now() where id = $1`, [id, stage, reason]);
  await tl(q, id, `Moved to ${leadStageName(stage)}${reason ? ' · reason: ' + reason : ''} (${by.user.name})`);
  const notes = [`${l.name} moved to ${leadStageName(stage)}.`];
  const src = sourceOf(l.source);
  if (src.family === 'partner' && ['visit', 'proposal', 'won'].includes(stage) && await autoOn(q, 'a12')) {
    const p = await one(q, 'select name, phone from partners where id = $1', [l.ref_partner_id]);
    if (p?.phone) await sendTemplate(p.phone, 'partner_update', [first(p.name), l.name, leadStageName(stage)], { q, related: { type: 'lead', id } });
    await tl(q, id, `${p?.name} updated on WhatsApp`, true); await bump(q, 'a12'); notes.push(`${first(p?.name || '')} was updated on WhatsApp.`);
  }
  if (stage === 'won' && src.family === 'partner' && await autoOn(q, 'a13')) {
    const p = await one(q, 'select id, name, rate from partners where id = $1', [l.ref_partner_id]);
    const amt = Math.round(l.value * p.rate / 100);
    await q.query('insert into commissions(lead_id, partner_id, amount) values ($1,$2,$3)', [id, p.id, amt]);
    await tl(q, id, `Commission entry created: ${inr(amt)} (${p.rate}%) for ${p.name}, awaiting approval`, true); await bump(q, 'a13');
    notes.push(`Commission of ${inr(amt)} queued for approval.`);
  }
  if (stage === 'won' && l.source === 'referral' && await autoOn(q, 'a14')) { await tl(q, id, `Referral reward created for ${await refName(q, l)}`, true); await bump(q, 'a14'); }
  if (stage === 'proposal' && await autoOn(q, 'a6') && l.owner_id) { await pushTask(q, { title: `Quote follow-up call · ${l.name}`, assignee: l.owner_id, assigner: by.user.id, deadline: addDays(2) }); await bump(q, 'a6'); }
  if (stage === 'won' && await autoOn(q, 'a7') && l.owner_id) { await pushTask(q, { title: `Convert ${l.name} to a project`, assignee: l.owner_id, assigner: by.user.id, deadline: addDays(1) }); await bump(q, 'a7'); }
  return { notes };
}

const LeadZ = z.object({ name: z.string().trim().min(2).max(120), phone: z.string(), source: z.enum(SOURCE_IDS), sub: z.string().max(60).default(''), ref: z.string().optional().nullable(), showroom: z.string().max(60).default(''),
  interest: z.string().max(200).default(''), value: z.coerce.number().min(0).max(1e9).default(0), area: z.string().max(120).default(''), owner: z.string().optional() });

export function crmRoutes(r: Router) {
  const done = async (ctx: Ctx, extra: Record<string, unknown> = {}) => ({ ok: true, ...extra, state: await staffState(userOf(ctx)) });
  r.post('/api/v1/leads', staff('crm'), async ctx => {
    const b = parse(LeadZ, ctx.body);
    const out = await tx(q => createLead(q, userOf(ctx), b));
    return done(ctx, out);
  });
  r.post('/api/v1/leads/:id/stage', staff('crm'), async ctx => {
    const b = parse(z.object({ stage: z.enum(LEAD_STAGE_IDS), reason: z.string().max(60).default('') }), ctx.body);
    const out = await tx(q => moveLead(q, userOf(ctx), ctx.params.id, b.stage, b.reason));
    return done(ctx, out);
  });
  r.patch('/api/v1/leads/:id', staff('crm'), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ followUpDays: z.number().int().min(0).max(365).optional(), owner: z.string().optional() }).strict(), ctx.body);
    await tx(async q => {
      const l = await one(q, 'select * from leads where id = $1 for update', [ctx.params.id]); if (!l) throw notFound();
      if (b.followUpDays !== undefined) { const d = addDays(b.followUpDays); await q.query('update leads set follow_up = $2 where id = $1', [l.id, d]); await tl(q, l.id, `Follow-up set for ${fmtDate(d)}`); }
      if (b.owner) { const oid = await ownerIdByName(q, b.owner); if (!oid) throw bad('Unknown owner'); await q.query('update leads set owner_id = $2 where id = $1', [l.id, oid]); await tl(q, l.id, `Reassigned to ${b.owner}`); await audit(q, p, 'lead.owner', `${l.name} reassigned to ${b.owner}`, 'lead', l.id); }
    });
    return done(ctx);
  });
  r.post('/api/v1/leads/:id/messages', staff('crm'), async ctx => {
    const b = parse(z.object({ text: z.string().trim().max(4000).default(''), tpl: z.string().optional() }), ctx.body);
    await tx(async q => {
      const l = await one(q, 'select * from leads where id = $1', [ctx.params.id]); if (!l) throw notFound();
      if (b.tpl) {
        if (!WA_TEMPLATES[b.tpl]) throw bad('Unknown template');
        const params = [first(l.name), (l.interest || 'interiors').toLowerCase()];
        const mid = await one(q, `insert into lead_messages(lead_id, from_kind, text, tpl, status) values ($1, 'us', $2, $3, 'queued') returning id`, [l.id, renderTemplate(b.tpl, params), b.tpl]);
        await sendTemplate(l.phone, b.tpl, params, { q, related: { type: 'lead_message', id: String(mid!.id) } });
        await tl(q, l.id, `Template ${b.tpl} sent`);
      } else {
        if (!b.text) throw bad('Type a message.');
        if (!(await windowOpen(l.phone, q)) && !(l.last_inbound_at && Date.now() - new Date(l.last_inbound_at).getTime() < 864e5)) throw bad('The 24-hour window is closed. Send an approved template to restart the chat.');
        const mid = await one(q, `insert into lead_messages(lead_id, from_kind, text, status) values ($1, 'us', $2, 'queued') returning id`, [l.id, b.text]);
        await sendText(l.phone, b.text, { q, related: { type: 'lead_message', id: String(mid!.id) } });
        await tl(q, l.id, 'WhatsApp reply sent');
      }
    });
    return done(ctx);
  });
  r.patch('/api/v1/automations/:id', staff('crm'), async ctx => {
    const b = parse(z.object({ on: z.boolean() }), ctx.body);
    await tx(async q => { const a = await one(q, 'update automations set enabled = $2 where id = $1 returning name', [ctx.params.id, b.on]); if (!a) throw notFound(); await audit(q, userOf(ctx), 'automation', `${a.name} turned ${b.on ? 'on' : 'off'}`, 'automation', ctx.params.id); });
    return done(ctx);
  });
  r.post('/api/v1/leads/:id/convert', staff(), async ctx => {
    const p = userOf(ctx);
    if (!p.perms.has('edit') && !p.perms.has('crm')) throw forbidden();
    const b = parse(z.object({ pm: z.string(), target: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), surveyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), advance: z.boolean().default(false), address: z.string().trim().min(2).max(300),
      scope: z.array(ScopeLineZ).min(1, 'Add the scope of work: at least one item to make.').max(40) }), ctx.body);
    const out = await tx(async q => {
      const l = await one(q, 'select * from leads where id = $1 for update', [ctx.params.id]); if (!l) throw notFound();
      if (l.stage !== 'won') throw bad('Only won leads can become projects.');
      const pr = await createProject(q, p, { leadId: l.id, customer: l.name, phone: l.phone, address: b.address, value: l.value, pm: b.pm, target: b.target, surveyDate: b.surveyDate, advance: b.advance, scope: b.scope });
      await q.query(`update quotes set project_id = $2 where lead_id = $1 and project_id is null`, [l.id, pr.id]);
      const pmName = (await one(q, 'select name from users where id = $1', [b.pm]))?.name || '';
      await tl(q, l.id, `Converted to project ${pr.code} · PM ${pmName} · survey ${fmtDate(b.surveyDate)}`, true);
      await q.query(`insert into lead_messages(lead_id, from_kind, text, tpl, status) values ($1, 'auto', $2, 'project_welcome', 'queued')`, [l.id, renderTemplate('project_welcome', [first(l.name), pr.code, fmtDate(b.surveyDate)])]);
      return pr;
    });
    return done(ctx, out);
  });
}

/* ---------- inbound WhatsApp routing (called for every inbound message that is not a button reply) ---------- */
export async function routeInboundText(from: string, text: string, name: string | undefined, at: Date) {
  await tx(async q => {
    const lead = await one(q, 'select id, owner_id from leads where phone = $1 order by created_at desc limit 1', [from]);
    if (lead) {
      await q.query(`insert into lead_messages(lead_id, from_kind, text, status, created_at) values ($1, 'them', $2, 'received', $3)`, [lead.id, text || '(media)', at]);
      await q.query('update leads set last_inbound_at = $2 where id = $1', [lead.id, at]);
      return;
    }
    const cust = await one(q, `select p.id pid, p.pm_id from customers c join projects p on p.customer_id = c.id where c.phone = $1 order by p.created_at desc limit 1`, [from]);
    if (cust) {
      await q.query('insert into project_activity(project_id, text) values ($1, $2)', [cust.pid, `Customer wrote on WhatsApp: ${text}`]);
      if (cust.pm_id) await pushTask(q, { title: `Reply to customer WhatsApp: ${text.slice(0, 80)}`, projectId: cust.pid, assignee: cust.pm_id, assigner: cust.pm_id, deadline: todayStr(), priority: 'urgent' });
      return;
    }
    if (await one(q, 'select 1 from users where phone = $1', [from])) return; // staff chatting with the business number
    const out = await createLead(q, null, { name: name || prettyPhone(from), phone: from, source: 'online', sub: 'WhatsApp', interest: 'Interiors' });
    await q.query(`insert into lead_messages(lead_id, from_kind, text, status, created_at) values ($1, 'them', $2, 'received', $3)`, [out.id, text || '(media)', at]);
    await q.query('update leads set last_inbound_at = $2 where id = $1', [out.id, at]);
  });
}

/* ---------- scheduled CRM automations (a2 missed response, a3 follow-up nudge, a9 stale lead) ---------- */
async function once(q: Q, key: string) { return (await q.query('insert into reminder_log(key) values ($1) on conflict do nothing', [key])).rowCount === 1; }
export async function crmTick() {
  const today = todayStr();
  if (await autoOn(db, 'a2')) for (const l of await many(db, `select l.* from leads l where l.stage not in ('won','lost') and l.last_inbound_at < now() - interval '15 minutes' and l.last_inbound_at > now() - interval '1 day'
      and not exists (select 1 from lead_messages m where m.lead_id = l.id and m.from_kind <> 'them' and m.created_at > l.last_inbound_at)`))
    if (l.owner_id && await once(db, `a2:${l.id}:${new Date(l.last_inbound_at).getTime()}`)) await tx(async q => { await pushTask(q, { title: `Reply to ${l.name} on WhatsApp (waiting 15+ min)`, assignee: l.owner_id, assigner: l.owner_id, deadline: today, priority: 'urgent' }); await bump(q, 'a2'); });
  if (await autoOn(db, 'a3')) for (const l of await many(db, `select l.* from leads l where l.stage in ('new','contacted','qualified','visit','proposal','negotiation')
      and coalesce(l.last_inbound_at, l.created_at) < now() - interval '2 days'
      and exists (select 1 from lead_messages m where m.lead_id = l.id and m.from_kind <> 'them')`))
    if (await once(db, `a3:${l.id}:${today}`) && await once(db, `a3-lead:${l.id}:${Math.floor(Date.now() / (7 * 864e5))}`)) await tx(async q => {
      const params = [first(l.name), (l.interest || 'interiors').toLowerCase()];
      const mid = await one(q, `insert into lead_messages(lead_id, from_kind, text, tpl, status) values ($1, 'auto', $2, 'follow_up_gentle', 'queued') returning id`, [l.id, renderTemplate('follow_up_gentle', params)]);
      await sendTemplate(l.phone, 'follow_up_gentle', params, { q, related: { type: 'lead_message', id: String(mid!.id) } });
      await tl(q, l.id, 'Follow-up nudge sent (no reply for 2 days)', true); await bump(q, 'a3');
    });
  if (await autoOn(db, 'a9')) for (const l of await many(db, `select * from leads where stage in ('new','contacted','qualified','visit','proposal','negotiation') and stage_changed_at < now() - interval '7 days'`))
    if (l.owner_id && await once(db, `a9:${l.id}:${Math.floor(Date.now() / (7 * 864e5))}`)) await tx(async q => { await pushTask(q, { title: `Stale lead: ${l.name} idle 7+ days in ${leadStageName(l.stage)}`, assignee: l.owner_id, assigner: l.owner_id, deadline: today }); await bump(q, 'a9'); });
}

export async function leadsFor(q: Q) { return many(q, 'select id, name from leads'); }
