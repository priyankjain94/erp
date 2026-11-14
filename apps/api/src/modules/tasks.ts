import { z } from 'zod';
import { config } from '../core/config.js';
import { db, many, one, tx, type Q } from '../core/db.js';
import { parse, type Router } from '../core/http.js';
import { addDays, bad, daysFrom, fmtDate, forbidden, localParts, notFound, todayStr } from '../core/util.js';
import { BLOCK_REASONS, STAGE_TARGETS_DEFAULT, TASK_TEMPLATES_DEFAULT } from '../domain.js';
import { sendTemplate } from '../integrations/whatsapp.js';
import { audit, staff, userOf } from './auth.js';
import { staffState } from './state.js';

export interface NewTask { title: string; projectId?: string | null; itemId?: string | null; assignee: string; assigner: string; deadline: string; priority?: 'normal' | 'urgent'; auto?: boolean; proof?: string; repeat?: string; notify?: boolean; verify?: boolean; template?: string }

const projectLabel = async (q: Q, pid?: string | null) => pid ? ((await one(q, 'select c.name from projects p join customers c on c.id = p.customer_id where p.id = $1', [pid]))?.name || 'General') : 'General';
const userRow = (q: Q, id: string | null | undefined) => id ? one(q, 'select id, name, phone, role, active from users where id = $1', [id]) : Promise.resolve(null);

/* ---------- settings: stage targets and task templates ---------- */
export async function stageTargets(q: Q = db): Promise<Record<string, number>> {
  const v = (await one(q, `select value from settings where key = 'stage_targets'`))?.value || {};
  return { ...STAGE_TARGETS_DEFAULT, ...v };
}
export async function taskTemplates(q: Q = db) {
  return (await one(q, `select value from settings where key = 'task_templates'`))?.value || TASK_TEMPLATES_DEFAULT;
}

/** next date for a repeating task, following the calendar (monthly keeps the day of the month) */
export function nextOccurrence(from: string, repeat: string) {
  if (repeat === 'daily') return addDays(1, from);
  if (repeat === 'weekly') return addDays(7, from);
  const d = new Date(from + 'T00:00:00Z'), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

export async function pushTask(q: Q, t: NewTask) {
  const id = 'T' + (await one(q, `select nextval('task_seq') n`))!.n;
  await q.query(`insert into tasks(id, title, project_id, item_id, assignee_id, assigner_id, deadline, original_deadline, priority, auto, proof, repeat, verify, template) values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13)`,
    [id, t.title, t.projectId || null, t.itemId || null, t.assignee, t.assigner, t.deadline, t.priority || 'normal', !!t.auto, t.proof || '', t.repeat || '', !!t.verify, t.template || null]);
  await q.query(`insert into task_events(task_id, e, by_id, to_id) values ($1, 'assigned', $2, $3)`, [id, t.assigner, t.assignee]);
  if (t.notify !== false) {
    const [a, by] = await Promise.all([userRow(q, t.assignee), userRow(q, t.assigner)]);
    if (a) await sendTemplate(a.phone, 'task_assigned', [t.auto || t.assigner === t.assignee || !by?.name ? 'Make My Space (automatic)' : by.name, t.title, await projectLabel(q, t.projectId), fmtDate(t.deadline)], { q, related: { type: 'task', id }, buttons: [`TASK_START:${id}`, `TASK_OPEN:${id}`] });
  }
  return id;
}

export async function closeAutoTasks(q: Q, itemId: string, by: string, note: string) {
  const open = await many(q, `select id from tasks where item_id = $1 and auto and status not in ('done','missed')`, [itemId]);
  for (const t of open) {
    await q.query(`update tasks set status = 'done', done_at = now() where id = $1`, [t.id]);
    await q.query(`insert into task_events(task_id, e, by_id, note) values ($1, 'done', $2, $3)`, [t.id, by, note]);
  }
}

/** Who answers for a task: for automatic or self-given tasks that is the project's PM (or the ops head), not whoever moved the card. */
export async function responsibleManager(q: Q, t: any): Promise<string | null> {
  if (!t.auto && t.assigner_id !== t.assignee_id) return t.assigner_id;
  const pm = t.project_id ? (await one(q, 'select pm_id from projects where id = $1', [t.project_id]))?.pm_id : null;
  if (pm && pm !== t.assignee_id) return pm;
  return (await one(q, `select id from users where role = 'ops_head' and active and id <> $1 order by created_at limit 1`, [t.assignee_id]))?.id
    || (await one(q, `select id from users where role = 'admin' and active and id <> $1 order by created_at limit 1`, [t.assignee_id]))?.id || null;
}
/** May this person manage the task (change its deadline, approve more time, check or reopen it)? */
async function isManager(q: Q, actorId: string, t: any, perms?: Set<string>) {
  if (actorId === 'system') return true;
  if (perms?.has('tasksAll') || perms?.has('assign')) return true;
  if (t.assigner_id === actorId && t.assignee_id !== actorId) return true;
  if (t.assigner_id === actorId && !t.auto) return true; // your own personal to-do
  if (t.project_id && (await one(q, 'select 1 from projects where id = $1 and pm_id = $2', [t.project_id, actorId]))) return true;
  return (await responsibleManager(q, t)) === actorId;
}

const upload = z.string().regex(/^upload:[A-Za-z0-9_-]+\.(pdf|jpg|png|webp)$/);
export type TaskAction = 'seen' | 'start' | 'done' | 'block' | 'unblock' | 'handover' | 'remind' | 'deadline' | 'extend' | 'extend_ok' | 'extend_no' | 'verify' | 'reopen';
export const TASK_ACTIONS: TaskAction[] = ['seen', 'start', 'done', 'block', 'unblock', 'handover', 'remind', 'deadline', 'extend', 'extend_ok', 'extend_no', 'verify', 'reopen'];
type ActionData = { note?: string; reason?: string; to?: string; date?: string; file?: string; on?: string; followUp?: string; via?: string };

/** Apply one task action. `actorId` is the person acting (assignee via WhatsApp, or the logged-in user). */
export async function taskAction(q: Q, actorId: string, id: string, action: TaskAction, data: ActionData = {}, perms?: Set<string>) {
  const t = await one(q, 'select * from tasks where id = $1 for update', [id]);
  if (!t) throw notFound('Task not found');
  const manager = await isManager(q, actorId, t, perms);
  const involved = t.assignee_id === actorId || manager || (t.blocked_on === actorId);
  if (!involved) throw forbidden('This task is not yours.');
  const ev = (e: string, extra: { to?: string; note?: string } = {}) => q.query(`insert into task_events(task_id, e, by_id, to_id, note) values ($1,$2,$3,$4,$5)`, [id, e, actorId, extra.to || null, extra.note || null]);
  const tellAssignee = async (text: string) => { if (actorId === t.assignee_id) return; const a = await userRow(q, t.assignee_id); if (a) await sendTemplate(a.phone, 'task_update', [t.title, text], { q, related: { type: 'task', id } }); };
  const closed = t.status === 'done' || t.status === 'missed';
  if (closed && !['seen', 'remind', 'verify', 'reopen'].includes(action)) throw bad('This task is already closed.');
  switch (action) {
    case 'seen':
      if (t.assignee_id === actorId && !t.seen_at) { await q.query('update tasks set seen_at = now() where id = $1', [id]); await ev('seen', { note: data.via || undefined }); }
      break;
    case 'start':
      if (t.assignee_id !== actorId && !manager) throw forbidden();
      await q.query(`update tasks set status = 'progress', started_at = coalesce(started_at, now()), seen_at = coalesce(seen_at, now()) where id = $1`, [id]); await ev('started'); break;
    case 'done': {
      if (t.assignee_id !== actorId && !manager) throw forbidden();
      if (t.status === 'blocked') throw bad('Unblock the task before marking it done.');
      let proofRef: string | null = null;
      if (t.proof === 'photo' || t.proof === 'file') {
        if (!data.file || !upload.safeParse(data.file).success) throw bad(t.proof === 'photo' ? 'Take or attach a photo to complete this task.' : 'Attach the file to complete this task.');
        proofRef = data.file;
      } else if (t.proof === 'comment' && !String(data.note || '').trim()) throw bad('Add a short comment to complete this task.');
      await q.query(`update tasks set status = 'done', done_at = now(), proof_note = $2, proof_ref = $3, started_at = coalesce(started_at, now()), seen_at = coalesce(seen_at, now()), ext_request = null where id = $1`, [id, data.note || null, proofRef]);
      await ev('done', { note: data.note });
      if (t.verify && actorId !== t.assigner_id) {
        const s = await userRow(q, t.assigner_id);
        if (s && s.id !== t.assignee_id) await sendTemplate(s.phone, 'task_update', [t.title, `${(await userRow(q, t.assignee_id))?.name || 'The team member'} marked it done. Please check it in the app; it is accepted automatically after one working day`], { q, related: { type: 'task', id } });
      }
      if (t.repeat) await nextRepeat(q, t);
      break;
    }
    case 'block': {
      const reason = data.reason && (BLOCK_REASONS.includes(data.reason) || data.reason.length < 120) ? data.reason.trim() : '';
      if (!reason) throw bad('Pick a reason.');
      let on = data.on || '';
      if (on && on !== 'client' && !(await one(q, 'select 1 from users where id = $1 and active', [on]))) throw bad('Choose who has to act.');
      if (!on) on = (await responsibleManager(q, t)) || t.assigner_id;
      const fu = data.followUp && /^\d{4}-\d{2}-\d{2}$/.test(data.followUp) ? data.followUp : addDays(2);
      if (daysFrom(fu) < 0) throw bad('The follow-up date cannot be in the past.');
      if (daysFrom(fu) > 14) throw bad('Pick a follow-up date within 2 weeks.');
      await q.query(`update tasks set status = 'blocked', blocked_reason = $2, blocked_on = $3, follow_up = $4, blocked_at = now() where id = $1`, [id, reason, on, fu]);
      const onName = on === 'client' ? 'the client' : (await userRow(q, on))?.name || '';
      await ev('blocked', { note: `${reason} · waiting on ${onName} · follow up ${fmtDate(fu)}` });
      const by = (await userRow(q, t.assignee_id))?.name || '';
      const tell = new Set([on !== 'client' ? on : null, t.assigner_id].filter(x => x && x !== actorId && x !== 'system') as string[]);
      for (const uid of tell) { const u = await userRow(q, uid); if (u) await sendTemplate(u.phone, 'task_blocked', [by, t.title, `${reason} (waiting on ${uid === on ? 'you' : onName})`], { q, related: { type: 'task', id } }); }
      break;
    }
    case 'unblock':
      await q.query(`update tasks set status = 'progress', blocked_reason = '', blocked_days = blocked_days + greatest(0, extract(epoch from (now() - coalesce(blocked_at, now()))) / 86400), blocked_at = null, blocked_on = null, follow_up = null where id = $1`, [id]);
      await ev('started', { note: 'Unblocked' + (data.note ? ' · ' + data.note : '') });
      if (actorId !== t.assignee_id) await tellAssignee('it is unblocked, you can continue now');
      break;
    case 'handover': {
      if (t.assignee_id !== actorId && !manager) throw forbidden();
      if (!data.to || !String(data.note || '').trim()) throw bad('Choose who takes over and add a short note.');
      const to = await userRow(q, data.to);
      if (!to?.active) throw bad('That person is not active.');
      await q.query(`update tasks set assignee_id = $2, status = 'todo', seen_at = null, started_at = null where id = $1`, [id, data.to]);
      await ev('handover', { to: data.to, note: data.note });
      const by = await userRow(q, actorId);
      await sendTemplate(to.phone, 'task_assigned', [by?.name || '', t.title, await projectLabel(q, t.project_id), fmtDate(t.deadline)], { q, related: { type: 'task', id }, buttons: [`TASK_START:${id}`, `TASK_OPEN:${id}`] });
      break;
    }
    case 'remind': {
      await q.query('update tasks set reminders = reminders + 1 where id = $1', [id]);
      await q.query(`insert into task_events(task_id, e, by_id) values ($1, 'reminded', 'system')`, [id]);
      const a = await userRow(q, t.assignee_id);
      const d = daysFrom(t.deadline);
      if (a) await sendTemplate(a.phone, 'task_reminder', [d < 0 ? `Overdue by ${-d} day${d < -1 ? 's' : ''}` : d === 0 ? 'Due today' : `Due ${fmtDate(t.deadline)}`, t.title, await projectLabel(q, t.project_id)],
        { q, related: { type: 'task', id }, buttons: t.proof ? [`TASK_OPEN:${id}`, `TASK_BLOCKED:${id}`] : [`TASK_DONE:${id}`, `TASK_BLOCKED:${id}`] });
      break;
    }
    case 'deadline': {
      if (!manager) throw forbidden('Only the person who gave the task or a manager can change the deadline. Use "Need more time" to ask.');
      if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw bad('Pick a date.');
      if (data.date === t.deadline) break;
      await ev('deadline', { note: `Deadline ${fmtDate(t.deadline)} → ${fmtDate(data.date)}${data.reason ? ' · ' + data.reason : ''}` });
      await q.query('update tasks set deadline = $2, ext_request = null where id = $1', [id, data.date]);
      await tellAssignee(`the deadline is now ${fmtDate(data.date)}`);
      break;
    }
    case 'extend': {
      if (t.assignee_id !== actorId) throw forbidden('Only the person doing the task can ask for more time.');
      if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date) || data.date <= t.deadline) throw bad('Pick a date after the current deadline.');
      const reason = String(data.reason || '').trim();
      if (reason.length < 5) throw bad('Say why you need more time.');
      const mgr = await responsibleManager(q, t);
      if (!mgr || mgr === actorId) {   // nobody above: own task, just move it (still counted as a change)
        await ev('deadline', { note: `Deadline ${fmtDate(t.deadline)} → ${fmtDate(data.date)} · ${reason}` });
        await q.query('update tasks set deadline = $2 where id = $1', [id, data.date]); break;
      }
      await q.query('update tasks set ext_request = $2 where id = $1', [id, JSON.stringify({ date: data.date, reason, at: Date.now(), to: mgr })]);
      await ev('extension', { to: mgr, note: `Asked for ${fmtDate(data.date)} · ${reason}` });
      const [m, a] = await Promise.all([userRow(q, mgr), userRow(q, actorId)]);
      if (m) await sendTemplate(m.phone, 'task_more_time', [a?.name || '', t.title, fmtDate(t.deadline), fmtDate(data.date), reason], { q, related: { type: 'task', id }, buttons: [`TASK_EXTOK:${id}`, `TASK_EXTNO:${id}`] });
      break;
    }
    case 'extend_ok': case 'extend_no': {
      if (!manager) throw forbidden('Only the person who gave the task or a manager can decide.');
      const r = t.ext_request; if (!r) throw bad('There is no request for more time.');
      await q.query('update tasks set ext_request = null where id = $1', [id]);
      if (action === 'extend_ok') {
        await q.query('update tasks set deadline = $2 where id = $1', [id, r.date]);
        await ev('deadline', { note: `Deadline ${fmtDate(t.deadline)} → ${fmtDate(r.date)} · more time approved · ${r.reason}` });
        await tellAssignee(`more time approved, new deadline ${fmtDate(r.date)}`);
      } else {
        await ev('extension_no', { note: data.reason || 'Keep the current deadline' });
        await tellAssignee(`more time was not approved, please finish by ${fmtDate(t.deadline)}${data.reason ? ' (' + data.reason + ')' : ''}`);
      }
      break;
    }
    case 'verify':
      if (!manager) throw forbidden();
      if (t.status !== 'done') throw bad('Only finished tasks can be checked.');
      await q.query('update tasks set verified_at = now() where id = $1', [id]);
      await ev('verified', { note: data.note || undefined });
      break;
    case 'reopen': {
      if (!manager) throw forbidden('Only the person who gave the task or a manager can reopen it.');
      if (!closed) throw bad('The task is still open.');
      const reason = String(data.reason || '').trim(); if (reason.length < 3) throw bad('Say what is wrong.');
      const dl = data.date && /^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data.date : addDays(1);
      await q.query(`update tasks set status = 'todo', done_at = null, verified_at = null, deadline = $2 where id = $1`, [id, dl]);
      await ev('reopened', { note: `${reason} · due ${fmtDate(dl)}` });
      await tellAssignee(`it was reopened: ${reason}. Please finish by ${fmtDate(dl)}`);
      break;
    }
  }
}

/** create the next occurrence of a repeating task (once) */
async function nextRepeat(q: Q, t: any, today = todayStr()) {
  let next = nextOccurrence(t.deadline, t.repeat);
  while (daysFrom(next, today) < 0) next = nextOccurrence(next, t.repeat);
  const exists = await one(q, `select 1 from tasks where title = $1 and assignee_id = $2 and repeat = $3 and status not in ('done','missed') and deadline >= $4`, [t.title, t.assignee_id, t.repeat, next]);
  if (!exists) await pushTask(q, { title: t.title, projectId: t.project_id, itemId: t.item_id, assignee: t.assignee_id, assigner: t.assigner_id, deadline: next, repeat: t.repeat, priority: t.priority, proof: t.proof, verify: t.verify, template: t.template });
}

const TaskBody = z.object({
  title: z.string().trim().min(2).max(300), projectId: z.string().optional().nullable(), itemId: z.string().optional().nullable(),
  assignee: z.string(), deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), priority: z.enum(['normal', 'urgent']).default('normal'),
  proof: z.enum(['', 'photo', 'file', 'comment']).default(''), repeat: z.enum(['', 'daily', 'weekly', 'monthly']).default(''),
  verify: z.boolean().default(false), template: z.string().max(200).optional().nullable()
});
const TemplateZ = z.object({ title: z.string().trim().min(2).max(200), days: z.coerce.number().int().min(0).max(60), proof: z.enum(['', 'photo', 'file', 'comment']).default(''), verify: z.boolean().default(false), priority: z.enum(['normal', 'urgent']).default('normal') });

export function taskRoutes(r: Router) {
  r.post('/api/v1/tasks', staff(), async ctx => {
    const p = userOf(ctx); const b = parse(TaskBody, ctx.body);
    if (daysFrom(b.deadline) < 0) throw bad('The deadline cannot be in the past.');
    await tx(async q => {
      const a = await one(q, 'select active from users where id = $1', [b.assignee]);
      if (!a?.active) throw bad('Choose an active person.');
      await pushTask(q, { ...b, projectId: b.projectId || null, itemId: b.itemId || null, assigner: p.user.id, template: b.template || undefined });
    });
    return { ok: true, state: await staffState(p) };
  });
  r.post('/api/v1/tasks/:id/:action', staff(), async ctx => {
    const p = userOf(ctx); const action = ctx.params.action as TaskAction;
    if (!TASK_ACTIONS.includes(action)) throw notFound();
    await tx(q => taskAction(q, p.user.id, ctx.params.id, action, ctx.body || {}, p.perms));
    return { ok: true, state: await staffState(p) };
  });
  /* stage targets and task templates */
  r.put('/api/v1/settings/stage-targets', staff('admin'), async ctx => {
    const b = parse(z.record(z.string(), z.coerce.number().int().min(0).max(90)), ctx.body);
    const clean = Object.fromEntries(Object.keys(STAGE_TARGETS_DEFAULT).filter(k => b[k] !== undefined).map(k => [k, b[k]]));
    await db.query(`insert into settings(key, value) values ('stage_targets', $1) on conflict (key) do update set value = excluded.value`, [JSON.stringify(clean)]);
    await audit(db, userOf(ctx), 'settings.stages', `Stage targets: ${Object.entries(clean).map(([k, v]) => `${k} ${v}d`).join(', ')}`, 'settings', 'stage_targets');
    return { ok: true, state: await staffState(userOf(ctx)) };
  });
  r.put('/api/v1/settings/task-templates', staff('assign'), async ctx => {
    const b = parse(z.object({ templates: z.array(TemplateZ).max(40) }), ctx.body);
    await db.query(`insert into settings(key, value) values ('task_templates', $1) on conflict (key) do update set value = excluded.value`, [JSON.stringify(b.templates)]);
    return { ok: true, state: await staffState(userOf(ctx)) };
  });
}

/* ---------- reminders (runs every minute; each message is sent once thanks to reminder_log) ---------- */
async function once(q: Q, key: string) { return (await q.query('insert into reminder_log(key) values ($1) on conflict do nothing', [key])).rowCount === 1; }
export async function holidays(q: Q = db): Promise<string[]> { return (await one(q, `select value from settings where key = 'holidays'`))?.value || []; }

/** escalation ladder: 2 days late → the responsible manager, 4 → ops head, 7 → owner */
export const LADDER = [{ days: 2, level: 'manager' }, { days: 4, level: 'ops_head' }, { days: 7, level: 'admin' }] as const;
async function ladderTargets(q: Q, t: any, level: string): Promise<{ id: string; phone: string }[]> {
  if (level === 'manager') { const m = await responsibleManager(q, t); const u = m && await userRow(q, m); return u && u.active && u.id !== t.assignee_id ? [u] : []; }
  return many(q, `select id, phone from users where role = $1 and active and id <> $2`, [level, t.assignee_id]);
}

export async function runReminders(now = new Date()) {
  const { hhmm, weekday, date } = localParts(now);
  const sent: string[] = [];
  const at = (t: string) => hhmm >= t;
  const today = todayStr(now);
  // housekeeping runs every day, Sundays included
  // 1. checks that were not done within one day are accepted automatically
  for (const t of await many(db, `select id from tasks where status = 'done' and verify and verified_at is null and done_at < now() - interval '1 day'`)) {
    await db.query('update tasks set verified_at = now() where id = $1', [t.id]);
    await db.query(`insert into task_events(task_id, e, by_id, note) values ($1, 'verified', 'system', 'Accepted automatically (not checked within a day)')`, [t.id]);
  }
  // 2. repeating tasks follow the calendar: a missed one is closed as missed and the next one is created
  for (const t of await many(db, `select * from tasks where repeat <> '' and status in ('todo','progress') and deadline < $1::date`, [today])) {
    if (!(await once(db, `missed:${t.id}`))) continue;
    await tx(async q => {
      await q.query(`update tasks set status = 'missed' where id = $1`, [t.id]);
      await q.query(`insert into task_events(task_id, e, by_id, note) values ($1, 'missed', 'system', 'Not done by the deadline; the next one has been created')`, [t.id]);
      await nextRepeat(q, t, today);
    });
    sent.push('missed:' + t.id);
  }
  if (weekday === 'Sun' || (await holidays()).includes(date)) return { skipped: true, sent };
  const open = await many(db, `select t.*, a.phone a_phone, a.name a_name from tasks t join users a on a.id = t.assignee_id where t.status in ('todo','progress','blocked') and a.active`);
  if (at('09:00')) {
    const byPerson = new Map<string, any[]>(); for (const t of open) { if (!byPerson.has(t.assignee_id)) byPerson.set(t.assignee_id, []); byPerson.get(t.assignee_id)!.push(t); }
    for (const [uid, ts] of byPerson) if (await once(db, `digest:${date}:${uid}`)) {
      const od = ts.filter(t => effectiveLate(t, today) > 0).length, td = ts.filter(t => t.deadline === today && t.status !== 'blocked').length;
      if (od || td) { await sendTemplate(ts[0].a_phone, 'daily_digest', [ts[0].a_name, String(od), String(td)], { related: { type: 'digest', id: uid } }); sent.push('digest:' + uid); }
    }
  }
  for (const t of open) {
    if (t.status === 'blocked') {
      // the person who has to act is reminded every day; after the follow-up date it counts as late again
      if (t.blocked_on && t.blocked_on !== 'client' && t.blocked_on !== t.assignee_id && at('10:00') && await once(db, `blk:${date}:${t.id}`)) {
        const u = await userRow(db, t.blocked_on);
        if (u?.active) { await sendTemplate(u.phone, 'task_blocked', [t.a_name, t.title, `${t.blocked_reason} (waiting on you since ${fmtDate(String(t.blocked_at?.toISOString?.() || today).slice(0, 10))})`], { related: { type: 'task', id: t.id } }); sent.push('blk:' + t.id); }
      }
      if (!(t.follow_up && daysFrom(t.follow_up, today) < 0)) continue;
    }
    const late = effectiveLate(t, today);
    const d = t.status === 'blocked' ? -late : daysFrom(t.deadline, today);
    const key = d === 1 ? 'tomorrow' : d === 0 ? 'today' : d < 0 ? 'overdue' : null;
    const due = d === 0 ? at('09:30') : at('10:00');
    if (key && due && await once(db, `rem:${date}:${t.id}:${key}`)) { await tx(q => taskAction(q, 'system', t.id, 'remind', {}, new Set(['tasksAll']))); sent.push(`rem:${t.id}`); }
    if (late >= 2 && at('10:05')) for (const step of LADDER) if (late >= step.days && await once(db, `esc:${date}:${t.id}:${step.level}`)) {
      for (const u of await ladderTargets(db, t, step.level)) {
        await sendTemplate(u.phone, 'task_escalation', [t.a_name, String(late), t.title], { related: { type: 'task', id: t.id }, buttons: [`TASK_OPEN:${t.id}`, `TASK_NUDGE:${t.id}`] });
        await db.query(`insert into task_events(task_id, e, by_id, to_id, note) values ($1, 'escalated', 'system', $2, $3)`, [t.id, u.id, `${late} days late`]);
      }
      sent.push(`esc:${t.id}:${step.level}`);
    }
  }
  if (at('19:00') && await once(db, `summary:${date}`)) {
    const s = await one(db, `select
      (select count(*) from task_events where e = 'done' and created_at::date = $1::date) done,
      (select count(*) from tasks where status in ('todo','progress') and deadline < $1::date) overdue,
      (select count(*) from item_stage_log where in_at::date = $1::date) moved,
      (select count(*) from snags where created_at::date = $1::date) snags`, [date]);
    const owners = await many(db, `select phone from users where role = 'admin' and active`);
    for (const o of owners) await sendTemplate(o.phone, 'owner_day_summary', [String(s.done), String(s.overdue), String(s.moved), String(s.snags)], { related: { type: 'summary', id: date } });
    sent.push('summary');
  }
  if (weekday === 'Mon' && at('09:00') && await once(db, `weekly:${date}`)) {
    const w = await weeklyNumbers(addDays(-7, today), today);
    const owners = await many(db, `select phone from users where role = 'admin' and active`);
    for (const o of owners) await sendTemplate(o.phone, 'weekly_owner_report', [String(w.done), String(w.onTimePct), String(w.overdue), String(w.stuck), w.worst || 'nobody'], { related: { type: 'weekly', id: date } });
    sent.push('weekly');
  }
  return { sent };
}
/** days late for reminders: past the deadline, or past the blocked follow-up date */
function effectiveLate(t: any, today: string) {
  if (t.status === 'blocked') return t.follow_up && daysFrom(t.follow_up, today) < 0 ? -daysFrom(t.follow_up, today) : 0;
  return Math.max(0, -daysFrom(t.deadline, today));
}
export async function weeklyNumbers(from: string, to: string) {
  const done = await many(db, `select t.assignee_id, t.done_at, coalesce(t.original_deadline, t.deadline) od, u.name from tasks t join users u on u.id = t.assignee_id where t.status = 'done' and t.done_at >= $1::date and t.done_at < $2::date`, [from, to]);
  const onTime = done.filter(x => String(new Date(x.done_at).toISOString()).slice(0, 10) <= String(x.od)).length;
  const overdue = await many(db, `select u.name from tasks t join users u on u.id = t.assignee_id where t.status in ('todo','progress') and t.deadline < $1::date`, [to]);
  const counts = new Map<string, number>(); overdue.forEach(x => counts.set(x.name, (counts.get(x.name) || 0) + 1));
  const worst = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} (${c})`).join(', ');
  const targets = await stageTargets();
  const items = await many(db, `select i.stage, i.waiting_ms, i.waiting_since, (select max(in_at) from item_stage_log l where l.item_id = i.id) stage_in from items i where i.stage <> 'closed'`);
  const stuck = items.filter(i => i.stage_in && stageAgeDays(i) > (targets[i.stage] ?? 99)).length;
  return { done: done.length, onTimePct: done.length ? Math.round(onTime / done.length * 100) : 100, overdue: overdue.length, worst, stuck };
}
export function stageAgeDays(i: { stage_in: Date; waiting_ms?: number | string; waiting_since?: Date | null }) {
  const wait = Number(i.waiting_ms || 0) + (i.waiting_since ? Date.now() - new Date(i.waiting_since).getTime() : 0);
  return (Date.now() - new Date(i.stage_in).getTime() - wait) / 864e5;
}

let schedTimer: NodeJS.Timeout | null = null;
export function startScheduler(extra: (() => Promise<unknown>)[] = []) {
  const tick = async () => {
    try { await runReminders(); for (const f of extra) await f(); } catch (e: any) { console.error('[scheduler]', e?.message); }
  };
  schedTimer = setInterval(tick, 60_000); setTimeout(tick, 3_000);
  if (config.NODE_ENV === 'test') clearInterval(schedTimer);
}
export function stopScheduler() { if (schedTimer) clearInterval(schedTimer); }
