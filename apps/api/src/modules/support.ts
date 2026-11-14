/* v1.8 — customer support: complaint tickets with numbers, assignment to installation/service teams,
 * visit scheduling, WhatsApp updates to the customer, and closure only with the customer's happy code. */
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, many, one, tx, type Q } from '../core/db.js';
import { parse, rateLimit, type Ctx, type Router } from '../core/http.js';
import { addDays, bad, forbidden, notFound, prettyPhone, todayStr } from '../core/util.js';
import { TICKET_CATEGORY_IDS, TICKET_SLA_HOURS, TICKET_STATUS } from '../domain.js';
import { sendTemplate } from '../integrations/whatsapp.js';
import { signedFileUrl } from '../integrations/storage.js';
import { audit, can, customerOrPreview, staff, userOf } from './auth.js';
import { act } from './ops.js';
import { customerState, staffState } from './state.js';
import { pushTask } from './tasks.js';

const done = async (ctx: Ctx, extra: Record<string, unknown> = {}) => ({ ok: true, ...extra, state: await staffState(userOf(ctx)) });
const fileRef = z.string().regex(/^upload:[A-Za-z0-9_-]+\.(pdf|jpg|png|webp)$/);
const DateZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const OPEN = ['open', 'assigned', 'scheduled', 'in_progress', 'on_hold', 'resolved'];
const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

async function ev(q: Q, ticketId: number, text: string, by: string, status: string | null = null, customerVisible = true) {
  await q.query('insert into service_events(ticket_id, status, text, by_name, customer_visible) values ($1,$2,$3,$4,$5)', [ticketId, status, text, by, customerVisible]);
}
async function ticketCtx(q: Q, id: number) {
  const t = await one(q, `select s.*, p.code pcode, p.pm_id, c.name cname, c.phone cphone, p.customer_id from service_requests s
    join projects p on p.id = s.project_id join customers c on c.id = p.customer_id where s.id = $1 for update of s`, [id]);
  if (!t) throw notFound('Complaint not found');
  return t;
}
const sendCode = (q: Q, t: any) => sendTemplate(t.contact_phone || t.cphone, 'install_signoff_otp', [t.happy_code], { q, related: { type: 'ticket', id: String(t.id) } });

export async function raiseTicket(q: Q, f: { projectId: string; itemId?: string | null; text: string; photo?: string | null; category?: string; priority?: string; byName: string; contactPhone?: string | null }) {
  const pr = await one(q, 'select p.*, c.name cname, c.phone cphone from projects p join customers c on c.id = p.customer_id where p.id = $1', [f.projectId]);
  if (!pr) throw notFound('Project not found');
  let warranty: boolean | null = null;
  if (f.itemId) {
    const it = await one(q, 'select warranty_until from items where id = $1 and project_id = $2', [f.itemId, f.projectId]);
    if (!it) throw bad('That item is not on this project.');
    warranty = it.warranty_until ? new Date(it.warranty_until) >= new Date(todayStr()) : null;
  }
  const n = (await one(q, `select nextval('ticket_seq') n`))!.n;
  const ticketNo = `SR-${new Date().toISOString().slice(2, 4)}${new Date().toISOString().slice(5, 7)}-${String(n).padStart(4, '0')}`;
  const code = String(crypto.randomInt(1000, 10000));
  const priority = f.priority || 'normal';
  const row = await one(q, `insert into service_requests(project_id, item_id, text, photo, under_warranty, raised_by, ticket_no, category, priority, happy_code, due_at, contact_phone)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + make_interval(hours => $11::int), $12) returning id`,
    [f.projectId, f.itemId || null, f.text, f.photo || null, warranty, f.byName, ticketNo, f.category || 'service', priority, code, TICKET_SLA_HOURS[priority] || 48, f.contactPhone || null]);
  const id = row!.id as number;
  await ev(q, id, `Complaint registered${f.byName === 'customer app' ? ' from the customer app' : ' by ' + f.byName}`, f.byName, 'open');
  if (pr.pm_id) await pushTask(q, { title: `Complaint ${ticketNo} · ${pr.cname}: ${f.text.slice(0, 70)} — assign a team`, projectId: f.projectId, itemId: f.itemId || undefined, assignee: pr.pm_id, assigner: pr.pm_id, deadline: addDays(1), priority: priority === 'urgent' ? 'urgent' : 'normal', auto: true });
  const to = f.contactPhone || pr.cphone;
  await sendTemplate(to, 'support_ticket_raised', [pr.cname.split(' ')[0], ticketNo, f.text.slice(0, 120)], { q, related: { type: 'ticket', id: String(id) } });
  await sendTemplate(to, 'install_signoff_otp', [code], { q, related: { type: 'ticket', id: String(id) } });
  await act(q, f.projectId, `Complaint ${ticketNo} registered (${f.byName}): ${f.text}${warranty === true ? ' · under warranty' : warranty === false ? ' · warranty expired' : ''}`);
  return { id, ticketNo };
}

/** Tickets for the staff state: everyone with 'support' sees all; others see the ones assigned to them. */
export async function loadTickets(q: Q, p: { user: { id: string }; perms: Set<string> }) {
  const all = p.perms.has('support');
  const rows = await many(q, `select s.*, p.code pcode, p.address, c.name cname, c.phone cphone from service_requests s join projects p on p.id = s.project_id join customers c on c.id = p.customer_id
    ${all ? '' : 'where s.assignee_id = $1'} order by (s.status = 'closed'), s.due_at nulls last, s.id desc limit 500`, all ? [] : [p.user.id]);
  if (!rows.length) return [];
  const evs = await many(q, 'select * from service_events where ticket_id = any($1::int[]) order by created_at, id', [rows.map(r => r.id)]);
  return rows.map(t => ({
    id: t.id, no: t.ticket_no, projectId: t.project_id, project: t.pcode, customer: t.cname, phone: prettyPhone(t.contact_phone || t.cphone), address: t.address,
    itemId: t.item_id, text: t.text, photo: signedFileUrl(t.photo), category: t.category, priority: t.priority, status: t.status, statusLabel: TICKET_STATUS[t.status] || t.status,
    assignee: t.assignee_id, visitDate: t.visit_date, warranty: t.under_warranty, by: t.raised_by, at: new Date(t.created_at).getTime(), due: t.due_at ? new Date(t.due_at).getTime() : null,
    overdue: OPEN.includes(t.status) && t.status !== 'resolved' && t.due_at && new Date(t.due_at) < new Date(), closedAt: t.closed_at ? new Date(t.closed_at).getTime() : null, closedVia: t.closed_via, closeNote: t.close_note, rating: t.rating,
    events: evs.filter(e => e.ticket_id === t.id).map(e => ({ t: new Date(e.created_at).getTime(), text: e.text, by: e.by_name, status: e.status, internal: !e.customer_visible }))
  }));
}
/** Customer view of their tickets: includes their own happy code, never internal notes. */
export async function customerTickets(q: Q, pids: string[]) {
  if (!pids.length) return [];
  const rows = await many(q, `select s.*, u.name tech, u.phone techphone from service_requests s left join users u on u.id = s.assignee_id where s.project_id = any($1::text[]) order by s.id desc`, [pids]);
  const evs = rows.length ? await many(q, 'select * from service_events where ticket_id = any($1::int[]) and customer_visible order by created_at, id', [rows.map(r => r.id)]) : [];
  return rows.map(t => ({ id: t.id, no: t.ticket_no, projectId: t.project_id, itemId: t.item_id, text: t.text, category: t.category, status: t.status, statusLabel: TICKET_STATUS[t.status] || t.status,
    visitDate: t.visit_date, technician: t.tech || null, technicianPhone: t.techphone ? prettyPhone(t.techphone) : null, happyCode: t.status === 'closed' ? null : t.happy_code,
    at: new Date(t.created_at).getTime(), closedAt: t.closed_at ? new Date(t.closed_at).getTime() : null, rating: t.rating,
    events: evs.filter(e => e.ticket_id === t.id).map(e => ({ t: new Date(e.created_at).getTime(), text: e.text, status: e.status })) }));
}

const isAssignee = (ctx: Ctx, t: any) => t.assignee_id === userOf(ctx).user.id;
const canWork = (ctx: Ctx, t: any) => can(ctx, 'support') || isAssignee(ctx, t);

export function supportRoutes(r: Router) {
  const NewZ = z.object({ projectId: z.string(), itemId: z.string().nullable().default(null), category: z.enum(TICKET_CATEGORY_IDS).default('service'), priority: z.enum(['urgent', 'normal', 'low']).default('normal'),
    text: z.string().trim().min(3).max(1000), photo: fileRef.nullable().default(null), contactPhone: z.string().max(20).optional() });

  r.post('/api/v1/support/tickets', staff('support'), async ctx => {
    const b = parse(NewZ, ctx.body);
    const { normPhone } = await import('../core/util.js');
    const contact = b.contactPhone ? normPhone(b.contactPhone) : null;
    if (b.contactPhone && !contact) throw bad('Enter a 10-digit number for the contact person.');
    const out = await tx(q => raiseTicket(q, { ...b, contactPhone: contact, byName: userOf(ctx).user.name }));
    return done(ctx, out);
  });
  /* kept from v1.5: staff raise from a project's Service tab */
  r.post('/api/v1/projects/:id/service', staff(), async ctx => {
    const b = parse(NewZ.omit({ projectId: true }), ctx.body);
    const out = await tx(q => raiseTicket(q, { ...b, projectId: ctx.params.id, byName: userOf(ctx).user.name }));
    return done(ctx, out);
  });
  r.post('/api/v1/customer/projects/:id/service', customerOrPreview, async ctx => {
    const b = parse(z.object({ itemId: z.string().nullable().default(null), category: z.enum(TICKET_CATEGORY_IDS).default('service'), text: z.string().trim().min(3).max(1000), photo: fileRef.nullable().default(null) }), ctx.body);
    rateLimit('ticket-cust:' + ctx.ip, 20, 3600_000);
    const res = await tx(async q => {
      const p = await one(q, 'select * from projects where id = $1', [ctx.params.id]); if (!p) throw notFound();
      if (ctx.auth?.type === 'customer' && ctx.auth.customer.id !== p.customer_id) throw forbidden();
      const t = await raiseTicket(q, { projectId: p.id, itemId: b.itemId, category: b.category, text: b.text, photo: b.photo, byName: 'customer app' });
      return { cid: p.customer_id, ...t };
    });
    return { ok: true, ticketNo: res.ticketNo, state: await customerState(res.cid) };
  });

  /* assign a team, schedule the visit, change status, add a note */
  r.patch('/api/v1/support/tickets/:id', staff(), async ctx => {
    const b = parse(z.object({ assignee: z.string().nullable().optional(), visitDate: DateZ.nullable().optional(), priority: z.enum(['urgent', 'normal', 'low']).optional(),
      status: z.enum(['in_progress', 'on_hold', 'open']).optional(), note: z.string().trim().max(1000).optional(), noteForCustomer: z.boolean().default(false) }), ctx.body);
    const p = userOf(ctx);
    await tx(async q => {
      const t = await ticketCtx(q, Number(ctx.params.id));
      if (!canWork(ctx, t)) throw forbidden();
      if (t.status === 'closed') throw bad('This complaint is closed.');
      const first = t.cname.split(' ')[0];
      if ((b.assignee !== undefined || b.priority) && !can(ctx, 'support')) throw forbidden('Only the support desk can assign or change priority.');
      let assignee = t.assignee_id, visit = t.visit_date ? String(t.visit_date instanceof Date ? t.visit_date.toISOString().slice(0, 10) : t.visit_date).slice(0, 10) : null, status = t.status;
      if (b.assignee !== undefined && b.assignee !== t.assignee_id) {
        if (b.assignee) {
          const u = await one(q, 'select id, name, phone from users where id = $1 and active', [b.assignee]); if (!u) throw bad('Choose an active team member.');
          assignee = u.id; if (status === 'open') status = 'assigned';
          await ev(q, t.id, `Assigned to ${u.name}`, p.user.name, status);
          await q.query(`update tasks set status = 'done', done_at = now() where auto and status <> 'done' and title like $1 and title like '%assign a team'`, [`Complaint ${t.ticket_no} %`]);
          await pushTask(q, { title: `Service visit ${t.ticket_no} · ${t.cname}: ${t.text.slice(0, 70)}`, projectId: t.project_id, itemId: t.item_id || undefined, assignee: u.id, assigner: p.user.id, deadline: b.visitDate || visit || addDays(1), priority: t.priority === 'urgent' ? 'urgent' : 'normal' });
        } else { assignee = null; status = 'open'; await ev(q, t.id, 'Unassigned', p.user.name, status, false); }
      }
      if (b.visitDate !== undefined && b.visitDate !== visit) {
        visit = b.visitDate;
        if (visit) {
          if (!assignee) throw bad('Assign a technician before scheduling the visit.');
          if (['open', 'assigned'].includes(status)) status = 'scheduled';
          const tech = await one(q, 'select name, phone from users where id = $1', [assignee]);
          await ev(q, t.id, `Visit scheduled for ${fmt(visit)} with ${tech!.name}`, p.user.name, status);
          await sendTemplate(t.contact_phone || t.cphone, 'support_visit_scheduled', [first, t.ticket_no, fmt(visit), tech!.name, prettyPhone(tech!.phone)], { q, related: { type: 'ticket', id: String(t.id) } });
        }
      }
      if (b.priority && b.priority !== t.priority) {
        await q.query('update service_requests set priority = $2, due_at = created_at + make_interval(hours => $3::int) where id = $1', [t.id, b.priority, TICKET_SLA_HOURS[b.priority]]);
        await ev(q, t.id, `Priority set to ${b.priority}`, p.user.name, null, false);
      }
      if (b.status && b.status !== status) {
        status = b.status;
        await ev(q, t.id, TICKET_STATUS[status], p.user.name, status);
        if (status !== 'open') await sendTemplate(t.contact_phone || t.cphone, 'support_ticket_update', [first, t.ticket_no, TICKET_STATUS[status]], { q, related: { type: 'ticket', id: String(t.id) } });
      }
      if (b.note) await ev(q, t.id, b.note, p.user.name, null, b.noteForCustomer);
      await q.query('update service_requests set assignee_id = $2, visit_date = $3, status = $4 where id = $1', [t.id, assignee, visit, status]);
    });
    return done(ctx);
  });

  /* technician marks the work done → customer is asked for the happy code */
  r.post('/api/v1/support/tickets/:id/resolve', staff(), async ctx => {
    const b = parse(z.object({ note: z.string().trim().min(3, 'Write what was done.').max(1000) }), ctx.body);
    await tx(async q => {
      const t = await ticketCtx(q, Number(ctx.params.id));
      if (!canWork(ctx, t)) throw forbidden();
      if (t.status === 'closed') throw bad('This complaint is closed.');
      await q.query(`update service_requests set status = 'resolved', resolution = $2, resolved_at = now() where id = $1`, [t.id, b.note]);
      await ev(q, t.id, `Work done: ${b.note}`, userOf(ctx).user.name, 'resolved');
      await sendTemplate(t.contact_phone || t.cphone, 'support_ticket_update', [t.cname.split(' ')[0], t.ticket_no, TICKET_STATUS.resolved], { q, related: { type: 'ticket', id: String(t.id) } });
    });
    return done(ctx);
  });

  /* close with the customer's happy code (or an override with a reason, for support staff with 'override') */
  r.post('/api/v1/support/tickets/:id/close', staff(), async ctx => {
    const b = parse(z.object({ code: z.string().regex(/^\d{4}$/).optional(), note: z.string().trim().max(1000).default(''), overrideReason: z.string().trim().min(10).max(500).optional() }), ctx.body);
    const p = userOf(ctx);
    rateLimit('happy:' + p.user.id + ':' + ctx.params.id, 8, 3600_000);
    await tx(async q => {
      const t = await ticketCtx(q, Number(ctx.params.id));
      if (!canWork(ctx, t)) throw forbidden();
      if (t.status === 'closed') throw bad('This complaint is already closed.');
      let via = 'happy_code';
      if (b.overrideReason) {
        if (!(can(ctx, 'support') && can(ctx, 'override'))) throw forbidden('Only support staff who can override may close without the happy code.');
        via = 'override';
      } else {
        if (!b.code) throw bad("Enter the customer's 4-digit happy code.");
        const ok = t.happy_code && crypto.timingSafeEqual(Buffer.from(t.happy_code), Buffer.from(b.code));
        if (!ok) { await ev(q, t.id, 'Wrong happy code entered', p.user.name, null, false); throw bad('That happy code does not match. Ask the customer to check the code we sent them on WhatsApp.'); }
      }
      const note = b.note || t.resolution || '';
      await q.query(`update service_requests set status = 'closed', closed_at = now(), closed_by = $2, closed_via = $3, close_note = $4, resolution = case when resolution = '' then $4 else resolution end, resolved_at = coalesce(resolved_at, now()) where id = $1`, [t.id, p.user.name, via, b.overrideReason ? `${note} (override: ${b.overrideReason})` : note]);
      await ev(q, t.id, via === 'happy_code' ? 'Closed with the customer\'s happy code' : 'Closed by the support desk', p.user.name, 'closed');
      if (via === 'override') { await ev(q, t.id, `Override reason: ${b.overrideReason}`, p.user.name, null, false); await audit(q, p, 'ticket.override', `Closed ${t.ticket_no} without happy code: ${b.overrideReason}`, 'project', t.project_id); }
      await q.query(`update tasks set status = 'done', done_at = now() where status <> 'done' and title like $1`, [`% ${t.ticket_no} %`]);
      await act(q, t.project_id, `Complaint ${t.ticket_no} closed (${via === 'happy_code' ? 'happy code' : 'override'}) by ${p.user.name}`);
      await sendTemplate(t.contact_phone || t.cphone, 'support_ticket_closed', [t.cname.split(' ')[0], t.ticket_no], { q, related: { type: 'ticket', id: String(t.id) }, buttons: [`TICKET_RATE:${t.id}:5`, `TICKET_RATE:${t.id}:3`, `TICKET_RATE:${t.id}:1`] });
    });
    return done(ctx);
  });

  r.post('/api/v1/support/tickets/:id/resend-code', staff('support'), async ctx => {
    await tx(async q => {
      const t = await ticketCtx(q, Number(ctx.params.id));
      if (t.status === 'closed') throw bad('This complaint is closed.');
      await sendCode(q, t);
      await ev(q, t.id, 'Happy code sent again on WhatsApp', userOf(ctx).user.name, null, false);
    });
    return done(ctx);
  });

  /* customer rates the closed complaint in their app */
  r.post('/api/v1/customer/tickets/:id/rate', customerOrPreview, async ctx => {
    const b = parse(z.object({ rating: z.number().int().min(1).max(5) }), ctx.body);
    const cid = await tx(async q => {
      const t = await ticketCtx(q, Number(ctx.params.id));
      if (ctx.auth?.type === 'customer' && ctx.auth.customer.id !== t.customer_id) throw forbidden();
      if (t.status !== 'closed') throw bad('You can rate once the complaint is closed.');
      await q.query('update service_requests set rating = $2 where id = $1', [t.id, b.rating]);
      await ev(q, t.id, `Customer rated the service ${b.rating}/5`, 'customer app', null, true);
      return t.customer_id;
    });
    return { ok: true, state: await customerState(cid) };
  });
}

/** WhatsApp quick-reply after closure ("Very happy / Okay / Not happy"). Returns true if handled. */
export async function handleTicketRating(q: Q, payload: string) {
  const m = /^TICKET_RATE:(\d+):(\d)$/.exec(payload); if (!m) return false;
  const t = await one(q, 'select id, status from service_requests where id = $1', [Number(m[1])]);
  if (!t || t.status !== 'closed') return true;
  await q.query('update service_requests set rating = $2 where id = $1', [t.id, Number(m[2])]);
  await ev(q, t.id, `Customer rated the service ${m[2]}/5 on WhatsApp`, 'WhatsApp', null, true);
  return true;
}
export { OPEN as OPEN_TICKET_STATUSES };
