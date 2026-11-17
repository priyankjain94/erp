import { z } from 'zod';
import { db, many, one, tx } from '../core/db.js';
import { parse } from '../core/http.js';
import { addDays, bad, first, fmtDate, forbidden, inr, normPhone, notFound, prettyPhone, todayStr } from '../core/util.js';
import { AUTOMATIONS, leadStageName, LEAD_STAGES, LEAD_STAGE_IDS, LOST_REASONS, SOURCES, SOURCE_IDS, sourceOf, WA_TEMPLATES, renderTemplate } from '../domain.js';
import { automationOn, sendTemplate, sendText, windowOpen } from '../integrations/whatsapp.js';
import { audit, staff, userOf } from './auth.js';
import { createProject, ScopeLineZ } from './ops.js';
import { staffState } from './state.js';
import { pushTask } from './tasks.js';
const tl = (q, leadId, text, auto = false) => q.query('insert into lead_timeline(lead_id, text, auto) values ($1,$2,$3)', [leadId, text, auto]);
const autoOn = automationOn;
const bump = (q, id) => q.query('update automations set runs = runs + 1 where id = $1', [id]);
async function ownerIdByName(q, nameOrId) {
    const u = await one(q, `select id from users where (id = $1 or lower(name) = lower($1)) and active limit 1`, [nameOrId]);
    return u?.id || null;
}
async function refName(q, lead) {
    if (lead.ref_partner_id)
        return (await one(q, 'select name from partners where id = $1', [lead.ref_partner_id]))?.name || '';
    if (lead.ref_lead_id)
        return (await one(q, 'select name from leads where id = $1', [lead.ref_lead_id]))?.name || '';
    return '';
}
/** Create a lead and run the "new lead" automations. Returns the lead id. */
export async function createLead(q, by, f, opts = {}) {
    const phone = normPhone(f.phone);
    if (!phone)
        throw bad('Enter a 10-digit mobile number.');
    const src = sourceOf(f.source);
    if (!src)
        throw bad('Pick where this client came from.');
    let partnerId = null, refLeadId = null, ownerId = null;
    if (src.family === 'partner') {
        const p = f.ref ? await one(q, 'select id, owner_id, name, type from partners where id = $1', [f.ref]) : null;
        if (!p || p.type !== f.source)
            throw bad('Choose the partner who sent this client, so they get credit.');
        partnerId = p.id;
        ownerId = p.owner_id;
    }
    else if (src.family === 'referral') {
        const l = f.ref ? await one(q, `select id from leads where id = $1 and stage = 'won'`, [f.ref]) : null;
        if (!l)
            throw bad('Choose the client who referred them.');
        refLeadId = l.id;
    }
    if (!ownerId && f.owner)
        ownerId = await ownerIdByName(q, f.owner);
    if (!ownerId)
        ownerId = (await one(q, `select u.id from users u left join leads l on l.owner_id = u.id and l.created_at > now() - interval '30 days'
                                          where u.role = 'sales' and u.active group by u.id order by count(l.id), min(u.created_at) limit 1`))?.id || null;
    const dup = await one(q, 'select id from leads where phone = $1 limit 1', [phone]);
    const id = 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
    await q.query(`insert into leads(id, name, phone, source, sub, ref_partner_id, ref_lead_id, showroom, owner_id, value, interest, area, follow_up, dup_flag, meta_leadgen_id, meta_form_id, meta_ad_name, meta_campaign_name)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [id, f.name.trim(), phone, f.source, f.sub || '', partnerId, refLeadId, f.source === 'walkin' ? f.showroom || '' : '', ownerId, Math.round(f.value || 0), f.interest || 'Interiors', f.area || '', todayStr(), !!dup,
        f.meta?.leadgenId || null, f.meta?.formId || null, f.meta?.adName || null, f.meta?.campaignName || null]);
    const by_ = partnerId || refLeadId ? await refName(q, { ref_partner_id: partnerId, ref_lead_id: refLeadId }) : '';
    await tl(q, id, `Lead created · ${src.name}${f.sub ? ' · ' + f.sub : ''}${by_ ? ' · referred by ' + by_ : ''}${f.source === 'walkin' && f.showroom ? ' · ' + f.showroom + ' showroom' : ''}${f.meta?.campaignName ? ' · campaign ' + f.meta.campaignName : ''}`);
    const ownerName = ownerId ? (await one(q, 'select name from users where id = $1', [ownerId])).name : 'our team';
    if (opts.welcome !== false && await autoOn(q, 'a1')) {
        const params = [first(f.name), ownerName];
        const mid = await one(q, `insert into lead_messages(lead_id, from_kind, text, tpl, status) values ($1, 'auto', $2, 'welcome_catalogue', 'queued') returning id`, [id, renderTemplate('welcome_catalogue', params)]);
        await sendTemplate(phone, 'welcome_catalogue', params, { q, related: { type: 'lead_message', id: String(mid.id) } });
        await tl(q, id, 'Welcome template sent', true);
        await bump(q, 'a1');
    }
    if (partnerId && await autoOn(q, 'a11')) {
        const pt = await one(q, 'select name, phone from partners where id = $1', [partnerId]);
        if (pt?.phone) {
            await sendTemplate(pt.phone, 'partner_update', [first(pt.name), f.name.trim(), `received, ${ownerName} will call them today`], { q, related: { type: 'lead', id } });
            await tl(q, id, `${by_} told on WhatsApp that the lead was received`, true);
        }
        else
            await tl(q, id, `${by_} has no WhatsApp number, so was not told`, true);
        await bump(q, 'a11');
    }
    if (refLeadId && await autoOn(q, 'a14')) {
        await tl(q, id, `Referred by ${by_}`, true);
        await tl(q, refLeadId, `Referred a new lead: ${f.name.trim()}`, true);
        await bump(q, 'a14');
    }
    if (dup)
        await tl(q, id, 'Duplicate number: flagged for manager review');
    if (ownerId && opts.task !== false)
        await pushTask(q, { title: `Call new lead · ${f.name.trim()}`, assignee: ownerId, assigner: by?.user.id || ownerId, deadline: todayStr(), priority: 'urgent', notify: true });
    if (by && opts.audit !== false)
        await audit(q, by, 'lead.create', `Added lead ${f.name.trim()} (${src.name})`, 'lead', id);
    return { id, dup: !!dup, ownerName, ownerId };
}
export async function moveLead(q, by, id, stage, reason = '') {
    const l = await one(q, 'select * from leads where id = $1 for update', [id]);
    if (!l)
        throw notFound('Lead not found');
    if (l.stage === stage)
        return { notes: [] };
    if (stage === 'lost' && !LOST_REASONS.includes(reason))
        throw bad('Pick a lost reason.');
    await q.query(`update leads set stage = $2, lost_reason = case when $2 = 'lost' then $3 else lost_reason end, follow_up = case when $2 in ('won','lost') then null else follow_up end, stage_changed_at = now() where id = $1`, [id, stage, reason]);
    await tl(q, id, `Moved to ${leadStageName(stage)}${reason ? ' · reason: ' + reason : ''} (${by.user.name})`);
    const notes = [`${l.name} moved to ${leadStageName(stage)}.`];
    const src = sourceOf(l.source);
    if (src.family === 'partner' && ['visit', 'proposal', 'won'].includes(stage) && await autoOn(q, 'a12')) {
        const p = await one(q, 'select name, phone from partners where id = $1', [l.ref_partner_id]);
        if (p?.phone)
            await sendTemplate(p.phone, 'partner_update', [first(p.name), l.name, leadStageName(stage)], { q, related: { type: 'lead', id } });
        await tl(q, id, `${p?.name} updated on WhatsApp`, true);
        await bump(q, 'a12');
        notes.push(`${first(p?.name || '')} was updated on WhatsApp.`);
    }
    if (stage === 'won' && src.family === 'partner' && await autoOn(q, 'a13')) {
        const p = await one(q, 'select id, name, rate from partners where id = $1', [l.ref_partner_id]);
        const amt = Math.round(l.value * p.rate / 100);
        await q.query('insert into commissions(lead_id, partner_id, amount) values ($1,$2,$3)', [id, p.id, amt]);
        await tl(q, id, `Commission entry created: ${inr(amt)} (${p.rate}%) for ${p.name}, awaiting approval`, true);
        await bump(q, 'a13');
        notes.push(`Commission of ${inr(amt)} queued for approval.`);
    }
    if (stage === 'won' && l.source === 'referral' && await autoOn(q, 'a14')) {
        const who = await refName(q, l);
        if (l.owner_id)
            await pushTask(q, { title: `Give ${who} the referral reward for ${l.name}`, assignee: l.owner_id, assigner: by.user.id, deadline: addDays(3) });
        await tl(q, id, `Referral reward task created for ${who}`, true);
        await bump(q, 'a14');
    }
    if (stage === 'proposal' && await autoOn(q, 'a6') && l.owner_id) {
        await pushTask(q, { title: `Quote follow-up call · ${l.name}`, assignee: l.owner_id, assigner: by.user.id, deadline: addDays(2) });
        await bump(q, 'a6');
    }
    if (stage === 'won' && await autoOn(q, 'a7') && l.owner_id) {
        await pushTask(q, { title: `Convert ${l.name} to a project`, assignee: l.owner_id, assigner: by.user.id, deadline: addDays(1) });
        await bump(q, 'a7');
    }
    return { notes };
}
const LeadZ = z.object({ name: z.string().trim().min(2).max(120), phone: z.string(), source: z.enum(SOURCE_IDS), sub: z.string().max(60).default(''), ref: z.string().optional().nullable(), showroom: z.string().max(60).default(''),
    interest: z.string().max(200).default(''), value: z.coerce.number().min(0).max(1e9).default(0), area: z.string().max(120).default(''), owner: z.string().optional() });
/* ---------- bulk import ---------- */
const ImportRowZ = z.object({ name: z.string().default(''), phone: z.string().default(''), source: z.string().default(''), sub: z.string().default(''), partner: z.string().default(''),
    showroom: z.string().default(''), interest: z.string().default(''), value: z.union([z.string(), z.number()]).default(''), area: z.string().default(''), owner: z.string().default(''),
    stage: z.string().default(''), notes: z.string().default('') }).partial().passthrough();
const ImportZ = z.object({ rows: z.array(ImportRowZ).min(1).max(2000), source: z.enum(SOURCE_IDS).default('online'), owner: z.string().default(''),
    welcome: z.boolean().default(false), dupes: z.enum(['skip', 'flag']).default('skip'), dryRun: z.boolean().default(false), file: z.string().max(120).default('') });
const IMPORT_STAGES = LEAD_STAGES.filter(s => s.id !== 'won' && s.id !== 'lost');
const SRC_WORDS = [[/walk|showroom|store/, 'walkin'], [/field|cold|site visit|exhibition/, 'field'], [/architect|interior|designer|planner/, 'architect'],
    [/contractor|engineer|civil|builder/, 'contractor'], [/agent|broker|real ?estate|property/, 'agent'], [/referr|reference|friend|existing client/, 'referral'],
    [/online|facebook|insta|meta|google|web|site|justdial|indiamart|ads?\b|whatsapp|youtube|lead form/, 'online']];
const s_ = (v) => String(v ?? '').trim();
/** "3.5 lakh", "35k", "1.2 cr", "₹ 3,50,000" → rupees */
export function parseMoney(v) {
    const t = s_(v).toLowerCase().replace(/[₹,\s]|rs\.?|inr/g, '');
    if (!t)
        return 0;
    const m = t.match(/^(\d+(?:\.\d+)?)(l|lac|lakh|lakhs|k|cr|crore|crores)?$/);
    if (!m)
        return NaN;
    const n = Number(m[1]), u = m[2] || '';
    return Math.round(n * (u.startsWith('l') ? 1e5 : u === 'k' ? 1e3 : u.startsWith('c') ? 1e7 : 1));
}
function sourceFromText(t, def) {
    const x = t.toLowerCase().trim();
    if (!x)
        return { id: def, sub: '' };
    const exact = SOURCES.find(s => s.id === x || s.name.toLowerCase() === x);
    if (exact)
        return { id: exact.id, sub: '' };
    for (const [re, id] of SRC_WORDS)
        if (re.test(x))
            return { id, sub: id === 'online' || id === 'field' ? t.trim().slice(0, 60) : '' };
    return { id: def, sub: t.trim().slice(0, 60) };
}
async function importLeads(q, p, b) {
    const existing = new Map((await many(q, 'select phone, name from leads')).map(l => [l.phone, l.name]));
    const partners = await many(q, 'select id, name, type, owner_id from partners');
    const won = await many(q, `select id, name, phone from leads where stage = 'won'`);
    const users = await many(q, 'select id, name from users where active');
    const defOwner = b.owner ? await ownerIdByName(q, b.owner) : null;
    const seen = new Set();
    const out = [];
    const perOwner = new Map();
    for (let i = 0; i < b.rows.length; i++) {
        const r = b.rows[i];
        const name = s_(r.name), rawPhone = s_(r.phone);
        const res = { row: i + 1, status: 'ok', name, phone: rawPhone, message: '' };
        out.push(res);
        if (!name && !rawPhone) {
            res.status = 'error';
            res.message = 'Empty row';
            continue;
        }
        if (name.length < 2) {
            res.status = 'error';
            res.message = 'Name missing';
            continue;
        }
        const phone = normPhone(rawPhone);
        if (!phone) {
            res.status = 'error';
            res.message = 'Not a valid 10-digit mobile number';
            continue;
        }
        res.phone = prettyPhone(phone);
        if (seen.has(phone)) {
            res.status = 'duplicate';
            res.message = 'Same number appears earlier in this file';
            continue;
        }
        seen.add(phone);
        const dupName = existing.get(phone);
        if (dupName && b.dupes === 'skip') {
            res.status = 'duplicate';
            res.message = `Already a lead: ${dupName}`;
            continue;
        }
        const src = sourceFromText(s_(r.source), b.source);
        const fam = sourceOf(src.id).family;
        let ref = null;
        const notes = [];
        if (fam === 'partner') {
            const pn = s_(r.partner).toLowerCase();
            const pt = pn ? partners.find(x => x.type === src.id && x.name.toLowerCase() === pn) || partners.find(x => x.name.toLowerCase() === pn) : null;
            if (!pt) {
                res.status = 'error';
                res.message = pn ? `Partner "${s_(r.partner)}" not found. Add them in Partners first.` : `${sourceOf(src.id).name} needs a partner name`;
                continue;
            }
            if (pt.type !== src.id)
                src.id = pt.type;
            ref = pt.id;
        }
        else if (fam === 'referral') {
            const rn = s_(r.partner).toLowerCase(), rp = normPhone(s_(r.partner));
            const c = rn ? won.find(x => x.name.toLowerCase() === rn || (rp && x.phone === rp)) : null;
            if (!c) {
                res.status = 'error';
                res.message = rn ? `Referring client "${s_(r.partner)}" not found among won clients` : 'Client referral needs the referring client\'s name';
                continue;
            }
            ref = c.id;
        }
        const value = parseMoney(r.value);
        if (Number.isNaN(value)) {
            notes.push(`budget "${s_(r.value)}" not read`);
        }
        const stageTxt = s_(r.stage).toLowerCase();
        const stage = stageTxt ? IMPORT_STAGES.find(s => s.id === stageTxt || s.name.toLowerCase() === stageTxt || s.name.toLowerCase().startsWith(stageTxt)) : IMPORT_STAGES[0];
        if (stageTxt && !stage)
            notes.push(`stage "${s_(r.stage)}" unknown, put in New`);
        let ownerId = null;
        if (s_(r.owner)) {
            ownerId = users.find(u => u.name.toLowerCase() === s_(r.owner).toLowerCase() || u.id === s_(r.owner))?.id || null;
            if (!ownerId)
                notes.push(`owner "${s_(r.owner)}" not found, auto-assigned`);
        }
        if (!ownerId)
            ownerId = defOwner;
        if (dupName)
            notes.push(`number already a lead (${dupName}), flagged`);
        res.source = sourceOf(src.id).name + (s_(r.sub) || src.sub ? ' · ' + (s_(r.sub) || src.sub) : '');
        res.message = notes.join('; ');
        if (b.dryRun) {
            res.owner = ownerId ? users.find(u => u.id === ownerId)?.name : 'Auto (round-robin)';
            continue;
        }
        const owner = ownerId ? users.find(u => u.id === ownerId).name : undefined;
        const c = await createLead(q, p, { name, phone, source: src.id, sub: (s_(r.sub) || src.sub).slice(0, 60), ref, showroom: src.id === 'walkin' ? s_(r.showroom).slice(0, 60) : '',
            interest: s_(r.interest).slice(0, 200), value: Number.isNaN(value) ? 0 : value, area: s_(r.area).slice(0, 120), owner }, { welcome: b.welcome, task: false, audit: false });
        res.id = c.id;
        res.owner = c.ownerName;
        await tl(q, c.id, `Imported${b.file ? ' from ' + b.file : ''} by ${p.user.name}`);
        if (stage && stage.id !== 'new') {
            await q.query('update leads set stage = $2 where id = $1', [c.id, stage.id]);
            await tl(q, c.id, `Imported at stage ${stage.name}`);
        }
        if (s_(r.notes))
            await tl(q, c.id, `Note: ${s_(r.notes).slice(0, 500)}`);
        if (c.ownerId)
            perOwner.set(c.ownerId, (perOwner.get(c.ownerId) || 0) + 1);
    }
    if (!b.dryRun) {
        for (const [oid, n] of perOwner)
            await pushTask(q, { title: `Call ${n} imported lead${n > 1 ? 's' : ''}${b.file ? ' · ' + b.file : ''}`, assignee: oid, assigner: p.user.id, deadline: todayStr(), priority: 'urgent', notify: true });
        const n = out.filter(x => x.status === 'ok').length;
        await audit(q, p, 'lead.import', `Imported ${n} lead${n === 1 ? '' : 's'}${b.file ? ' from ' + b.file : ''} (${out.length - n} skipped)`, 'lead', '');
    }
    const count = (s) => out.filter(x => x.status === s).length;
    return { results: out, counts: { ok: count('ok'), duplicate: count('duplicate'), error: count('error') } };
}
export function crmRoutes(r) {
    const done = async (ctx, extra = {}) => ({ ok: true, ...extra, state: await staffState(userOf(ctx)) });
    r.post('/api/v1/leads', staff('crm'), async (ctx) => {
        const b = parse(LeadZ, ctx.body);
        const out = await tx(q => createLead(q, userOf(ctx), b));
        return done(ctx, out);
    });
    r.post('/api/v1/leads/import', staff('crm'), async (ctx) => {
        const b = parse(ImportZ, ctx.body);
        const p = userOf(ctx);
        const out = await tx(q => importLeads(q, p, b));
        return b.dryRun ? { ok: true, ...out } : done(ctx, out);
    });
    r.post('/api/v1/leads/:id/stage', staff('crm'), async (ctx) => {
        const b = parse(z.object({ stage: z.enum(LEAD_STAGE_IDS), reason: z.string().max(60).default('') }), ctx.body);
        const out = await tx(q => moveLead(q, userOf(ctx), ctx.params.id, b.stage, b.reason));
        return done(ctx, out);
    });
    r.patch('/api/v1/leads/:id', staff('crm'), async (ctx) => {
        const p = userOf(ctx);
        const b = parse(z.object({ followUpDays: z.number().int().min(0).max(365).optional(), owner: z.string().optional() }).strict(), ctx.body);
        await tx(async (q) => {
            const l = await one(q, 'select * from leads where id = $1 for update', [ctx.params.id]);
            if (!l)
                throw notFound();
            if (b.followUpDays !== undefined) {
                const d = addDays(b.followUpDays);
                await q.query('update leads set follow_up = $2 where id = $1', [l.id, d]);
                await tl(q, l.id, `Follow-up set for ${fmtDate(d)}`);
            }
            if (b.owner) {
                const oid = await ownerIdByName(q, b.owner);
                if (!oid)
                    throw bad('Unknown owner');
                await q.query('update leads set owner_id = $2 where id = $1', [l.id, oid]);
                await tl(q, l.id, `Reassigned to ${b.owner}`);
                await audit(q, p, 'lead.owner', `${l.name} reassigned to ${b.owner}`, 'lead', l.id);
            }
        });
        return done(ctx);
    });
    r.post('/api/v1/leads/:id/messages', staff('crm'), async (ctx) => {
        const b = parse(z.object({ text: z.string().trim().max(4000).default(''), tpl: z.string().optional() }), ctx.body);
        await tx(async (q) => {
            const l = await one(q, 'select * from leads where id = $1', [ctx.params.id]);
            if (!l)
                throw notFound();
            if (b.tpl) {
                if (!WA_TEMPLATES[b.tpl])
                    throw bad('Unknown template');
                const params = [first(l.name), (l.interest || 'interiors').toLowerCase()];
                const mid = await one(q, `insert into lead_messages(lead_id, from_kind, text, tpl, status) values ($1, 'us', $2, $3, 'queued') returning id`, [l.id, renderTemplate(b.tpl, params), b.tpl]);
                await sendTemplate(l.phone, b.tpl, params, { q, related: { type: 'lead_message', id: String(mid.id) } });
                await tl(q, l.id, `Template ${b.tpl} sent`);
            }
            else {
                if (!b.text)
                    throw bad('Type a message.');
                if (!(await windowOpen(l.phone, q)) && !(l.last_inbound_at && Date.now() - new Date(l.last_inbound_at).getTime() < 864e5))
                    throw bad('The 24-hour window is closed. Send an approved template to restart the chat.');
                const mid = await one(q, `insert into lead_messages(lead_id, from_kind, text, status) values ($1, 'us', $2, 'queued') returning id`, [l.id, b.text]);
                await sendText(l.phone, b.text, { q, related: { type: 'lead_message', id: String(mid.id) } });
                await tl(q, l.id, 'WhatsApp reply sent');
            }
        });
        return done(ctx);
    });
    r.patch('/api/v1/automations/:id', staff('crm'), async (ctx) => {
        const b = parse(z.object({ on: z.boolean() }), ctx.body);
        if (b.on && AUTOMATIONS.find(a => a.id === ctx.params.id)?.built === false)
            throw bad('This automation is not built yet, so it can\'t be turned on.');
        await tx(async (q) => { const a = await one(q, 'update automations set enabled = $2 where id = $1 returning name', [ctx.params.id, b.on]); if (!a)
            throw notFound(); await audit(q, userOf(ctx), 'automation', `${a.name} turned ${b.on ? 'on' : 'off'}`, 'automation', ctx.params.id); });
        return done(ctx);
    });
    r.post('/api/v1/leads/:id/convert', staff(), async (ctx) => {
        const p = userOf(ctx);
        if (!p.perms.has('edit') && !p.perms.has('crm'))
            throw forbidden();
        const b = parse(z.object({ pm: z.string(), target: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), surveyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), advance: z.boolean().default(false), address: z.string().trim().min(2).max(300),
            scope: z.array(ScopeLineZ).min(1, 'Add the scope of work: at least one item to make.').max(40) }), ctx.body);
        const out = await tx(async (q) => {
            const l = await one(q, 'select * from leads where id = $1 for update', [ctx.params.id]);
            if (!l)
                throw notFound();
            if (l.stage !== 'won')
                throw bad('Only won leads can become projects.');
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
export async function routeInboundText(from, text, name, at) {
    await tx(async (q) => {
        const lead = await one(q, 'select id, owner_id from leads where phone = $1 order by created_at desc limit 1', [from]);
        if (lead) {
            await q.query(`insert into lead_messages(lead_id, from_kind, text, status, created_at) values ($1, 'them', $2, 'received', $3)`, [lead.id, text || '(media)', at]);
            await q.query('update leads set last_inbound_at = $2 where id = $1', [lead.id, at]);
            return;
        }
        const cust = await one(q, `select p.id pid, p.pm_id from customers c join projects p on p.customer_id = c.id where c.phone = $1 order by p.created_at desc limit 1`, [from]);
        if (cust) {
            await q.query('insert into project_activity(project_id, text) values ($1, $2)', [cust.pid, `Customer wrote on WhatsApp: ${text}`]);
            if (cust.pm_id)
                await pushTask(q, { title: `Reply to customer WhatsApp: ${text.slice(0, 80)}`, projectId: cust.pid, assignee: cust.pm_id, assigner: cust.pm_id, deadline: todayStr(), priority: 'urgent' });
            return;
        }
        if (await one(q, 'select 1 from users where phone = $1', [from]))
            return; // staff chatting with the business number
        const out = await createLead(q, null, { name: name || prettyPhone(from), phone: from, source: 'online', sub: 'WhatsApp', interest: 'Interiors' });
        await q.query(`insert into lead_messages(lead_id, from_kind, text, status, created_at) values ($1, 'them', $2, 'received', $3)`, [out.id, text || '(media)', at]);
        await q.query('update leads set last_inbound_at = $2 where id = $1', [out.id, at]);
    });
}
/* ---------- scheduled CRM automations (a2 missed response, a3 follow-up nudge, a9 stale lead) ---------- */
async function once(q, key) { return (await q.query('insert into reminder_log(key) values ($1) on conflict do nothing', [key])).rowCount === 1; }
export async function crmTick() {
    const today = todayStr();
    if (await autoOn(db, 'a2'))
        for (const l of await many(db, `select l.* from leads l where l.stage not in ('won','lost') and l.last_inbound_at < now() - interval '15 minutes' and l.last_inbound_at > now() - interval '1 day'
      and not exists (select 1 from lead_messages m where m.lead_id = l.id and m.from_kind <> 'them' and m.created_at > l.last_inbound_at)`))
            if (l.owner_id && await once(db, `a2:${l.id}:${new Date(l.last_inbound_at).getTime()}`))
                await tx(async (q) => { await pushTask(q, { title: `Reply to ${l.name} on WhatsApp (waiting 15+ min)`, assignee: l.owner_id, assigner: l.owner_id, deadline: today, priority: 'urgent' }); await bump(q, 'a2'); });
    if (await autoOn(db, 'a3'))
        for (const l of await many(db, `select l.* from leads l where l.stage in ('new','contacted','qualified','visit','proposal','negotiation')
      and coalesce(l.last_inbound_at, l.created_at) < now() - interval '2 days'
      and exists (select 1 from lead_messages m where m.lead_id = l.id and m.from_kind <> 'them')`))
            if (await once(db, `a3:${l.id}:${today}`) && await once(db, `a3-lead:${l.id}:${Math.floor(Date.now() / (7 * 864e5))}`))
                await tx(async (q) => {
                    const params = [first(l.name), (l.interest || 'interiors').toLowerCase()];
                    const mid = await one(q, `insert into lead_messages(lead_id, from_kind, text, tpl, status) values ($1, 'auto', $2, 'follow_up_gentle', 'queued') returning id`, [l.id, renderTemplate('follow_up_gentle', params)]);
                    await sendTemplate(l.phone, 'follow_up_gentle', params, { q, related: { type: 'lead_message', id: String(mid.id) } });
                    await tl(q, l.id, 'Follow-up nudge sent (no reply for 2 days)', true);
                    await bump(q, 'a3');
                });
    // a3 second half: still silent 5 days after the nudge -> Nurture
    if (await autoOn(db, 'a3'))
        for (const l of await many(db, `select l.id, l.name, l.stage from leads l where l.stage in ('new','contacted','qualified','visit','proposal','negotiation')
      and exists (select 1 from lead_timeline t where t.lead_id = l.id and t.auto and t.text like 'Follow-up nudge sent%' and t.created_at < now() - interval '5 days'
                  and t.created_at > coalesce(l.last_inbound_at, 'epoch'::timestamptz) and t.created_at > l.stage_changed_at)`))
            await tx(async (q) => {
                await q.query(`update leads set stage = 'nurture', stage_changed_at = now() where id = $1 and stage = $2`, [l.id, l.stage]);
                await tl(q, l.id, `Moved to Nurture: no reply 5 days after the follow-up nudge (automatic)`, true);
                await bump(q, 'a3');
            });
    if (await autoOn(db, 'a15'))
        for (const pt of await many(db, `select p.id, p.name, p.owner_id from partners p where p.active and p.owner_id is not null and p.created_at < now() - interval '60 days'
      and not exists (select 1 from leads l where l.ref_partner_id = p.id and l.created_at > now() - interval '60 days')`))
            if (await once(db, `a15:${pt.id}:${today.slice(0, 7)}`))
                await tx(async (q) => { await pushTask(q, { title: `Partner gone quiet: visit or call ${pt.name} (no lead in 60 days)`, assignee: pt.owner_id, assigner: pt.owner_id, deadline: addDays(3) }); await bump(q, 'a15'); });
    // a17: on the 1st of the month, remind the admin to send this month's launches to partners
    if (today.slice(8) === '01' && await autoOn(db, 'a17') && await once(db, `a17:${today.slice(0, 7)}`)) {
        const admin = await one(db, `select id from users where role = 'admin' and active order by created_at limit 1`);
        const n = Number((await one(db, `select count(*) n from partners where active and phone is not null`)).n);
        if (admin && n)
            await tx(async (q) => { await pushTask(q, { title: `Send this month's new launches to ${n} partner${n > 1 ? 's' : ''} (Partners → Send monthly update)`, assignee: admin.id, assigner: admin.id, deadline: addDays(3) }); await bump(q, 'a17'); });
    }
    if (await autoOn(db, 'a9'))
        for (const l of await many(db, `select * from leads where stage in ('new','contacted','qualified','visit','proposal','negotiation') and stage_changed_at < now() - interval '7 days'`))
            if (l.owner_id && await once(db, `a9:${l.id}:${Math.floor(Date.now() / (7 * 864e5))}`))
                await tx(async (q) => { await pushTask(q, { title: `Stale lead: ${l.name} idle 7+ days in ${leadStageName(l.stage)}`, assignee: l.owner_id, assigner: l.owner_id, deadline: today }); await bump(q, 'a9'); });
}
export async function leadsFor(q) { return many(q, 'select id, name from leads'); }
