import { db, many, one } from '../core/db.js';
import { prettyPhone } from '../core/util.js';
import { AUTOMATIONS, CUSTOMER_STAGE, DEFAULT_ROLES, PERMS } from '../domain.js';
import { signedFileUrl } from '../integrations/storage.js';
import { stageTargets, taskTemplates } from './tasks.js';
import { loadDrafts } from './workflow.js';
import { partnerStats } from './business.js';
import { customerTickets, loadTickets } from './support.js';
const ms = (d) => d ? new Date(d).getTime() : null;
const group = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
        const k = r[key];
        if (!m.has(k))
            m.set(k, []);
        m.get(k).push(r);
    }
    return m;
};
async function loadProjects(q, ids, opts) {
    const where = ids ? 'where p.id = any($1::text[])' : '';
    const projects = await many(q, `select p.*, c.name customer, c.phone from projects p join customers c on c.id = p.customer_id ${where} order by p.created_at desc`, ids ? [ids] : []);
    if (!projects.length)
        return [];
    const pids = projects.map(p => p.id);
    const [pays, acts, surveys, rooms, walls, obs, ritems, pdocs, rcpts, invs, cos, svc, pquotes, scopeRows] = await Promise.all([
        many(q, 'select * from payment_milestones where project_id = any($1::text[]) order by sort, id', [pids]),
        many(q, 'select project_id, text, created_at from project_activity where project_id = any($1::text[]) order by created_at, id', [pids]),
        many(q, 'select * from surveys where project_id = any($1::text[])', [pids]),
        many(q, 'select * from rooms where project_id = any($1::text[]) order by sort, name', [pids]),
        many(q, 'select w.* from walls w join rooms r on r.id = w.room_id where r.project_id = any($1::text[]) order by w.label', [pids]),
        many(q, 'select o.* from wall_obstructions o join walls w on w.id = o.wall_id join rooms r on r.id = w.room_id where r.project_id = any($1::text[]) order by o.id', [pids]),
        many(q, 'select ri.* from room_items ri join rooms r on r.id = ri.room_id where r.project_id = any($1::text[]) order by ri.id', [pids]),
        many(q, `select * from project_docs where project_id = any($1::text[]) ${opts.customer ? 'and shared' : ''} ${opts.money ? '' : opts.internal ? "and category <> 'quotation'" : "and category not in ('pi','po','quotation')"} order by created_at desc, id desc`, [pids]),
        opts.money ? many(q, 'select * from payment_receipts where project_id = any($1::text[]) order by paid_on, id', [pids]) : [],
        opts.money ? many(q, 'select * from invoices where project_id = any($1::text[]) order by invoice_date, id', [pids]) : [],
        many(q, 'select * from change_orders where project_id = any($1::text[]) order by created_at, id', [pids]),
        many(q, 'select * from service_requests where project_id = any($1::text[]) order by created_at desc, id desc', [pids]),
        opts.money && !opts.customer ? many(q, `select q.id, q.rev, q.total, q.status, q.created_at, p.id project_id from quotes q join projects p on p.lead_id = q.lead_id where p.id = any($1::text[]) order by q.rev`, [pids]) : [],
        many(q, `select * from project_scope where project_id = any($1::text[]) and status = 'active' order by sort, id`, [pids])
    ]);
    const scBy = group(scopeRows, 'project_id');
    const rcBy = group(rcpts, 'project_id'), ivBy = group(invs, 'project_id'), coBy = group(cos, 'project_id'), svBy = group(svc, 'project_id'), pqBy = group(pquotes, 'project_id');
    const docBy = group(pdocs, 'project_id'), payBy = group(pays, 'project_id'), actBy = group(acts, 'project_id'), roomBy = group(rooms, 'project_id'), wallBy = group(walls, 'room_id'), obsBy = group(obs, 'wall_id'), riBy = group(ritems, 'room_id');
    const survBy = new Map(surveys.map(s => [s.project_id, s]));
    return projects.map(p => {
        const s = survBy.get(p.id) || {};
        return {
            id: p.id, code: p.code, leadId: p.lead_id, customer: p.customer, phone: prettyPhone(p.phone), address: p.address, pm: p.pm_id,
            value: opts.money ? p.value : 0, created: ms(p.created_at), target: p.target, siteReady: p.site_ready, notes: p.notes,
            feedback: p.feedback_rating ? { rating: p.feedback_rating, comment: p.feedback_comment || '', at: ms(p.feedback_at) } : null,
            payments: opts.money ? (payBy.get(p.id) || []).map(m => ({ id: m.id, label: m.label, pct: m.pct, amount: m.amount, gate: m.gate, received: !!m.received_at,
                paid: (rcBy.get(p.id) || []).filter(r => r.milestone_id === m.id).reduce((a, r) => a + Number(r.amount), 0) })) : [],
            receipts: (rcBy.get(p.id) || []).map(r => ({ id: r.id, no: r.receipt_no, amount: Number(r.amount), on: r.paid_on, mode: r.mode, ref: r.reference, milestone: r.milestone_id, note: r.note, by: r.by_id })),
            invoices: (ivBy.get(p.id) || []).map(v => ({ id: v.id, no: v.invoice_no, date: v.invoice_date, desc: v.description, taxable: Number(v.taxable), gstPct: Number(v.gst_pct), gst: Number(v.gst), total: Number(v.total) })),
            changes: (coBy.get(p.id) || []).map(c => ({ id: c.id, itemId: c.item_id, desc: c.description, amount: opts.money ? Number(c.amount) : null, days: c.days, status: c.status, via: c.decided_via, at: ms(c.created_at), decidedAt: ms(c.decided_at), by: c.by_id })),
            service: (svBy.get(p.id) || []).map(v => ({ id: v.id, no: v.ticket_no, itemId: v.item_id, text: v.text, photo: signedFileUrl(v.photo), category: v.category, priority: v.priority, status: v.status, visitDate: v.visit_date, assignee: v.assignee_id, resolution: v.resolution, warranty: v.under_warranty, by: v.raised_by, at: ms(v.created_at), resolvedAt: ms(v.resolved_at), closedAt: ms(v.closed_at) })),
            quotes: (pqBy.get(p.id) || []).map(x => ({ id: x.id, rev: x.rev, total: Number(x.total), status: x.status, at: ms(x.created_at) })),
            activity: (actBy.get(p.id) || []).map(a => ({ t: ms(a.created_at), text: a.text })),
            docs: (docBy.get(p.id) || []).map(d => ({ id: d.id, category: d.category, title: d.title, rev: d.rev, notes: d.notes, itemId: d.item_id, by: d.by_id, at: ms(d.created_at), url: signedFileUrl(d.file), shared: d.shared })),
            palette: p.palette || {},
            scope: (scBy.get(p.id) || []).map(s => ({ id: s.id, room: s.room_name, roomCode: s.room_code, type: s.type, desc: s.descr, size: s.size, value: opts.money ? Number(s.value) : null, source: s.source, itemId: s.item_id || null })),
            survey: {
                status: s.status || 'scheduled', assignee: s.assignee_id || null, scheduled: ms(s.scheduled_at), checkIn: ms(s.check_in_at), at: ms(s.submitted_at), mins: s.minutes ?? null, signed: !!s.signed,
                rooms: (roomBy.get(p.id) || []).map(r => ({
                    id: r.id, name: r.name, code: r.code, ceiling: r.ceiling, floor: r.floor, shape: r.shape,
                    walls: (wallBy.get(r.id) || []).map(w => ({ label: w.label, w: w.w ?? '', h: w.h ?? '', photo: w.photo, photoUrl: signedFileUrl(w.photo), notes: w.notes,
                        photos: (Array.isArray(w.extra_photos) ? w.extra_photos : []).map((x) => ({ ref: x.ref, tag: x.tag || '', url: signedFileUrl(x.ref) })),
                        obs: (obsBy.get(w.id) || []).map(o => ({ type: o.type, left: o.left_mm, floor: o.floor_mm, w: o.w, h: o.h, px: o.px, py: o.py })) })),
                    items: (riBy.get(r.id) || []).map(x => ({ type: x.type, wall: x.wall, desc: x.descr, scopeId: x.scope_id ?? null }))
                }))
            }
        };
    });
}
async function loadItems(q, where, params) {
    const items = await many(q, `select * from items ${where} order by created_at, id`, params);
    if (!items.length)
        return [];
    const ids = items.map(i => i.id);
    const [docs, boxes, sess, snags, logs] = await Promise.all([
        many(q, `select * from documents where item_id = any($1::text[]) and kind = 'drawing' order by id`, [ids]),
        many(q, 'select * from item_boxes where item_id = any($1::text[]) order by n', [ids]),
        many(q, 'select * from work_sessions where item_id = any($1::text[]) order by start_at', [ids]),
        many(q, 'select * from snags where item_id = any($1::text[]) order by created_at', [ids]),
        many(q, 'select * from item_stage_log where item_id = any($1::text[]) order by in_at, id', [ids])
    ]);
    const d = group(docs, 'item_id'), b = group(boxes, 'item_id'), s = group(sess, 'item_id'), n = group(snags, 'item_id'), l = group(logs, 'item_id');
    return items.map(i => ({
        id: i.id, code: i.code, projectId: i.project_id, room: i.room_code, roomName: i.room_name, type: i.type, wall: i.wall, desc: i.descr,
        stage: i.stage, owner: i.owner_id, target: i.target, installer: i.installer_id, designer: i.designer_id,
        drawings: (d.get(i.id) || []).map(x => ({ rev: x.rev, at: ms(x.created_at), by: x.by_id, approved: !!x.approved_at, url: signedFileUrl(x.url), notes: x.notes || '', spec: x.spec || null })),
        spec: i.spec || {}, prodPiNo: i.prod_pi_no || '', prodPiAmount: i.prod_pi_amount === null ? null : Number(i.prod_pi_amount), prodPiDoc: signedFileUrl(i.prod_pi_doc), hwVendor: i.hw_vendor || '', hwPoDoc: signedFileUrl(i.hw_po_doc), hwReceived: !!i.hw_received, productionDone: !!i.production_done,
        hwPI: i.hw_pi, prodPI: i.prod_pi, po: i.po,
        dispatch: i.dispatch_vehicle !== null || i.dispatch_date ? { vehicle: i.dispatch_vehicle || '', boxes: i.dispatch_boxes, date: i.dispatch_date } : null,
        delivered: i.delivered, boxes: (b.get(i.id) || []).map(x => ({ n: x.n, label: x.label, got: x.got })),
        sessions: (s.get(i.id) || []).map(x => ({ start: ms(x.start_at), end: ms(x.end_at), reason: x.reason })),
        checklist: i.checklist || {}, afterPhoto: i.after_photo ? signedFileUrl(i.after_photo) : false, installDone: i.install_done, signedOff: i.signed_off, installedAt: ms(i.installed_at),
        snags: (n.get(i.id) || []).map(x => ({ id: x.id, part: x.part, type: x.type, note: x.note, photo: signedFileUrl(x.photo), status: x.status, raisedBy: x.raised_by, at: ms(x.created_at), vendor: x.vendor || '', cost: x.cost === null || x.cost === undefined ? null : Number(x.cost), payer: x.payer || '' })),
        productionSteps: i.production_steps || {}, warrantyUntil: i.warranty_until || null, value: i.value === null || i.value === undefined ? null : Number(i.value), scopeId: i.scope_id || null,
        waiting: i.waiting || '', waitingSince: ms(i.waiting_since), waitingMs: Number(i.waiting_ms || 0),
        log: (l.get(i.id) || []).map(x => ({ stage: x.stage, in: ms(x.in_at), out: ms(x.out_at), by: x.by_id, override: x.override || undefined, note: x.note || undefined })),
        flags: i.flags || []
    }));
}
async function loadTasks(q, where, params) {
    const tasks = await many(q, `select * from tasks ${where} order by created_at desc, id`, params);
    if (!tasks.length)
        return [];
    const ev = group(await many(q, 'select * from task_events where task_id = any($1::text[]) order by created_at, id', [tasks.map(t => t.id)]), 'task_id');
    const msg = group(await many(q, `select related_id, phone, template, kind, status, created_at from wa_messages where related_type = 'task' and direction = 'out' and related_id = any($1::text[]) order by id`, [tasks.map(t => t.id)]), 'related_id');
    return tasks.map(t => ({
        id: t.id, title: t.title, projectId: t.project_id, itemId: t.item_id, assignee: t.assignee_id, assigner: t.assigner_id, created: ms(t.created_at),
        deadline: t.deadline, originalDeadline: t.original_deadline || t.deadline, priority: t.priority, status: t.status, blockedReason: t.blocked_reason, auto: t.auto, proof: t.proof, repeat: t.repeat, reminders: t.reminders,
        verify: t.verify, verifiedAt: ms(t.verified_at), blockedOn: t.blocked_on || null, followUp: t.follow_up || null, blockedAt: ms(t.blocked_at), blockedDays: Number(t.blocked_days || 0),
        proofNote: t.proof_note || '', proofUrl: t.proof_ref ? signedFileUrl(t.proof_ref) : null, ext: t.ext_request || null, seenAt: ms(t.seen_at), startedAt: ms(t.started_at), doneAt: ms(t.done_at), template: t.template || null,
        msgs: (msg.get(t.id) || []).map(m => ({ t: ms(m.created_at), to: m.phone, template: m.template || m.kind, status: m.status })),
        events: (ev.get(t.id) || []).map(e => ({ e: e.e, by: e.by_id, to: e.to_id || undefined, note: e.note || undefined, t: ms(e.created_at) }))
    }));
}
export async function loadLeads(q) {
    const leads = await many(q, `select l.*, u.name owner_name from leads l left join users u on u.id = l.owner_id order by l.created_at desc`);
    const ids = leads.map(l => l.id);
    const msgs = group(await many(q, 'select * from lead_messages where lead_id = any($1::text[]) order by created_at, id', [ids]), 'lead_id');
    const tl = group(await many(q, 'select * from lead_timeline where lead_id = any($1::text[]) order by created_at, id', [ids]), 'lead_id');
    const qts = group(await many(q, 'select * from quotes where lead_id = any($1::text[]) order by rev', [ids]), 'lead_id');
    return leads.map(l => ({
        id: l.id, name: l.name, phone: prettyPhone(l.phone), source: l.source, sub: l.sub, ref: l.ref_partner_id || l.ref_lead_id || null, showroom: l.showroom,
        stage: l.stage, owner: l.owner_name || '', value: l.value, interest: l.interest, area: l.area, fu: l.follow_up, lastIn: ms(l.last_inbound_at),
        created: ms(l.created_at), lostReason: l.lost_reason, dup: l.dup_flag,
        meta: l.meta_leadgen_id ? { form: l.meta_form_id, ad: l.meta_ad_name, campaign: l.meta_campaign_name } : null,
        msgs: (msgs.get(l.id) || []).map(m => ({ from: m.from_kind, text: m.text, t: ms(m.created_at), tpl: m.tpl || undefined, status: m.status })),
        timeline: (tl.get(l.id) || []).map(t => ({ t: ms(t.created_at), text: t.text, auto: t.auto || undefined })),
        quotes: (qts.get(l.id) || []).map(x => ({ id: x.id, rev: x.rev, lines: x.lines, discount: Number(x.discount), gstPct: Number(x.gst_pct), subtotal: Number(x.subtotal), total: Number(x.total), notes: x.notes, status: x.status, at: ms(x.created_at), by: x.by_id }))
    }));
}
/** Everything the signed-in staff member may see, in the shapes the web app renders. */
export async function staffState(p, q = db) {
    const me = p.user.id, perms = p.perms;
    const seeAllProjects = perms.has('projects') || perms.has('ops') || perms.has('tasksAll') || perms.has('assign');
    const users = (await many(q, 'select id, name, role, title, phone, active, members, skills, email, google_sub from users order by created_at, name'))
        .map(u => ({ id: u.id, name: u.name, role: u.role, title: u.title, phone: prettyPhone(u.phone), active: u.active, members: u.members, skills: u.skills.length ? u.skills : undefined, ...(perms.has('admin') || u.id === me ? { email: u.email || '', google: !!u.google_sub } : {}) }));
    const accessRequests = perms.has('admin') || perms.has('people') ? (await many(q, `select * from access_requests where status = 'pending' order by created_at`)).map(a => ({ id: a.id, name: a.name, phone: prettyPhone(a.phone), email: a.email || '', roleWanted: a.role_wanted, note: a.note, at: ms(a.created_at) })) : [];
    const roleRows = await many(q, 'select role, perm, allowed from role_permissions');
    const roles = JSON.parse(JSON.stringify(DEFAULT_ROLES));
    for (const r of roleRows)
        (roles[r.role] ||= {})[r.perm] = r.allowed;
    for (const k of PERMS)
        roles.admin[k] = true;
    let items, projects;
    if (seeAllProjects) {
        items = await loadItems(q, '', []);
        projects = await loadProjects(q, null, { money: perms.has('money'), internal: perms.has('edit') || perms.has('ops') });
    }
    else {
        items = await loadItems(q, 'where installer_id = $1', [me]);
        const pids = [...new Set(items.map(i => i.projectId))];
        projects = await loadProjects(q, pids, { money: false });
    }
    if (!perms.has('money'))
        items = items.map((i) => ({ ...i, value: null }));
    const tasks = perms.has('tasksAll') ? await loadTasks(q, '', []) : await loadTasks(q, 'where assignee_id = $1 or assigner_id = $1', [me]);
    const audit = perms.has('admin') ? (await many(q, 'select actor_id, text, created_at from audit_log order by id desc limit 100')).map(a => ({ t: ms(a.created_at), by: a.actor_id, text: a.text })) : [];
    const crm = perms.has('crm') ? {
        leads: await loadLeads(q),
        partners: await (async () => {
            const st = new Map((await partnerStats(q)).map(s => [s.id, s]));
            const coms = group(await many(q, 'select * from commissions order by created_at'), 'partner_id');
            return (await many(q, 'select * from partners order by name')).map(x => {
                const s = st.get(x.id) || {};
                return {
                    id: x.id, name: x.name, firm: x.firm, type: x.type, tier: x.tier, rate: x.rate, owner: x.owner_id ? users.find(u => u.id === x.owner_id)?.name : '', ownerId: x.owner_id,
                    phone: x.phone ? prettyPhone(x.phone) : '', email: x.email || '', city: x.city || '', notes: x.notes || '', active: x.active !== false, created: ms(x.created_at),
                    stats: { leads: s.leads || 0, open: s.open || 0, pipeline: Number(s.pipeline || 0), won: s.won || 0, wonValue: Number(s.won_value || 0), projectValue: Number(s.project_value || 0), commission: Number(s.commission || 0), commissionPaid: Number(s.commission_paid || 0), lastLead: ms(s.last_lead) },
                    commissions: perms.has('money') ? (coms.get(x.id) || []).map(c => ({ id: c.id, leadId: c.lead_id, amount: c.amount, status: c.status, at: ms(c.created_at) })) : []
                };
            });
        })(),
        autos: (await many(q, 'select * from automations order by length(id), id')).map(a => { const d = AUTOMATIONS.find(x => x.id === a.id); return { id: a.id, fam: a.fam, name: a.name, when: a.when_text, then: a.then_text, on: a.enabled && d?.built !== false, runs: a.runs, tpl: d?.tpl || null, to: d?.to || null, built: d?.built !== false }; })
    } : { leads: [], partners: [], autos: [] };
    const wa = await one(q, `select count(*) filter (where status = 'simulated') sim, count(*) filter (where status in ('sent','delivered','read')) sent, count(*) filter (where status = 'failed') failed from wa_messages where created_at > now() - interval '30 days'`);
    const tickets = await loadTickets(q, p);
    const settings = { stageTargets: await stageTargets(q), taskTemplates: await taskTemplates(q) };
    const drafts = await loadDrafts(q, p);
    return { erp: { me, projects, items, tasks, users, roles, audit, accessRequests, tickets, settings, drafts }, crm, server: { wa } };
}
/** What a customer sees: only their own projects, in customer-friendly terms. */
export async function customerState(customerId, q = db) {
    const pids = (await many(q, 'select id from projects where customer_id = $1', [customerId])).map(r => r.id);
    const projects = await loadProjects(q, pids, { money: true, customer: true });
    const items = await loadItems(q, 'where project_id = any($1::text[])', [pids]);
    const staffIds = [...new Set([...projects.map(p => p.pm), ...items.map(i => i.installer)].filter(Boolean))];
    const staff = await many(q, 'select id, name, phone from users where id = any($1::text[])', [staffIds]);
    return {
        projects: projects.map(p => ({ ...p, activity: [], notes: '' })),
        items: items.map(i => ({ ...i, customerStage: CUSTOMER_STAGE[i.stage], sessions: [], log: [], boxes: [], flags: [], prodPiNo: '', prodPiAmount: null, prodPiDoc: null, hwVendor: '', hwPoDoc: null })),
        staff: staff.map(s => ({ id: s.id, name: s.name, phone: prettyPhone(s.phone) })),
        tickets: await customerTickets(q, pids)
    };
}
