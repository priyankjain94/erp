import { z } from 'zod';
import { config } from '../core/config.js';
import { db, many, one, tx, type Q } from '../core/db.js';
import { parse, type Ctx, type Router } from '../core/http.js';
import { addDays, bad, conflict, first, fmtDate, forbidden, HttpError, normPhone, notFound, prettyPhone } from '../core/util.js';
import { WAITING_REASONS, BOXES, CHECKLIST, DEFAULT_PAYMENTS, DOC_CATEGORIES, DOC_CATEGORY_IDS, gatesFor, MATERIAL_FIELDS, ITEM_TYPES, OBSTRUCTIONS, PAUSE_REASONS, SNAG_FLOW, SNAG_TYPES, stageById, stageIdx, stageProof, STAGES, stageTaskTitle, typeName, TYPE_IDS } from '../domain.js';
import { sendTemplate } from '../integrations/whatsapp.js';
import { audit, can, checkOtp, issueOtp, staff, userOf, type Principal } from './auth.js';
import { staffState } from './state.js';
import { closeAutoTasks, pushTask, stageTargets } from './tasks.js';
import { addScopeLines, createItemFromScope } from './scope.js';

export const ScopeLineZ = z.object({
  room: z.string().trim().min(2).max(60), type: z.enum(TYPE_IDS), desc: z.string().trim().max(200).default(''), size: z.string().trim().max(80).default(''),
  value: z.coerce.number().min(0).max(1e8).default(0), source: z.enum(['manual', 'quote']).default('manual')
});
export type ScopeLine = z.infer<typeof ScopeLineZ>;

type U = Extract<Principal, { type: 'user' }>;
export const act = (q: Q, pid: string, text: string) => q.query('insert into project_activity(project_id, text) values ($1,$2)', [pid, text]);
const uname = async (q: Q, id?: string | null) => id ? ((await one(q, 'select name from users where id = $1', [id]))?.name || id) : 'Unassigned';
const firstUserOfRole = async (q: Q, role: string) => (await one(q, `select id from users where role = $1 and active order by created_at limit 1`, [role]))?.id || null;

/* ---------- create project (direct, or from a won CRM lead) ---------- */
export interface NewProject { leadId?: string | null; customer: string; phone: string; address: string; value: number; pm: string; target: string; surveyDate: string; advance: boolean; scope?: ScopeLine[] }
export async function createProject(q: Q, by: U, f: NewProject) {
  const phone = normPhone(f.phone); if (!phone) throw bad('Enter a valid customer mobile number.');
  if (f.leadId && await one(q, 'select 1 from projects where lead_id = $1', [f.leadId])) throw conflict('This lead already has a project.');
  const cust = await one(q, `insert into customers(name, phone) values ($1,$2) on conflict (phone) do update set name = excluded.name returning id`, [f.customer, phone]);
  const n = (await one(q, `select nextval('project_seq') n`))!.n;
  const id = 'P' + n, code = 'P-' + n;
  await q.query(`insert into projects(id, code, lead_id, customer_id, pm_id, address, value, target) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, code, f.leadId || null, cust!.id, f.pm, f.address, Math.round(f.value || 0), f.target]);
  let i = 0;
  for (const [label, pct, gate] of DEFAULT_PAYMENTS) {
    await q.query(`insert into payment_milestones(project_id, label, pct, amount, gate, received_at, received_by, sort) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, label, pct, Math.round((f.value || 0) * pct / 100), gate, i === 0 && f.advance ? new Date() : null, i === 0 && f.advance ? by.user.id : null, i]);
    i++;
  }
  if (f.scope?.length) await addScopeLines(q, id, f.scope, by.user.id);
  const surveyor = await firstUserOfRole(q, 'surveyor');
  await q.query(`insert into surveys(project_id, status, assignee_id, scheduled_at) values ($1, 'scheduled', $2, ($3::date + time '11:00') at time zone $4)`, [id, surveyor, f.surveyDate, config.TZ_BUSINESS]);
  await act(q, id, f.leadId ? `Project created from CRM lead (won) by ${by.user.name}` : `Project created by ${by.user.name}`);
  if (surveyor) await pushTask(q, { title: `Site survey · ${f.customer}, ${f.address.split(',')[0]}`, projectId: id, assignee: surveyor, assigner: by.user.id, deadline: f.surveyDate, auto: true });
  await sendTemplate(phone, 'project_welcome', [first(f.customer), code, fmtDate(f.surveyDate)], { q, related: { type: 'project', id } });
  await audit(q, by, 'project.create', `Created project ${code} for ${f.customer}`, 'project', id);
  return { id, code };
}

/* ---------- gates + moves ---------- */
async function gateInput(q: Q, itemId: string) {
  const it = await one(q, 'select * from items where id = $1', [itemId]);
  if (!it) throw notFound('Item not found');
  const drawings = await many(q, `select approved_at, url from documents where item_id = $1 and kind = 'drawing' order by id`, [itemId]);
  const boxes = Number((await one(q, 'select count(*) n from item_boxes where item_id = $1', [itemId]))!.n);
  const handoverDocs = Number((await one(q, `select count(*) n from project_docs where project_id = $1 and category = 'handover' and (item_id is null or item_id = $2)`, [it.project_id, itemId]))!.n);
  const openSnags = Number((await one(q, `select count(*) n from snags where item_id = $1 and status <> 'fixed'`, [itemId]))!.n);
  const p = await one(q, 'select site_ready from projects where id = $1', [it.project_id]);
  const s = await one(q, 'select status from surveys where project_id = $1', [it.project_id]);
  const pay = await one(q, `select label, pct, received_at from payment_milestones where project_id = $1 and gate = 'order' limit 1`, [it.project_id]);
  return {
    it,
    gi: { stage: it.stage, drawings: drawings.map(d => ({ approved: !!d.approved_at, file: !!d.url })), spec: it.spec || {}, boxes, prodPiNo: it.prod_pi_no, productionDone: it.production_done, hwReceived: it.hw_received, handoverDocs, hwPI: it.hw_pi, prodPI: it.prod_pi, po: it.po, dispatch: it.dispatch_vehicle || it.dispatch_date, delivered: it.delivered, installDone: it.install_done, signedOff: it.signed_off, openSnags },
    gp: { surveyStatus: s?.status || 'scheduled', siteReady: p!.site_ready, orderPayment: pay ? { label: pay.label, pct: pay.pct, received: !!pay.received_at } : undefined }
  };
}

async function ownerFor(q: Q, it: any, to: string) {
  if (to === 'install') return it.installer_id;
  if (to === 'drawing') return it.designer_id || await firstUserOfRole(q, 'designer');
  if (to === 'handover') return (await one(q, 'select pm_id from projects where id = $1', [it.project_id]))?.pm_id || await firstUserOfRole(q, 'pm');
  const st = stageById[to as keyof typeof stageById];
  return st?.owner ? await firstUserOfRole(q, st.owner) : null;
}

/** Move an item one stage (inside a transaction). */
export async function moveIn(q: Q, itemId: string, to: string, byId: string, note = '', override = '') {
  const it = await one(q, 'select * from items where id = $1 for update', [itemId]);
  const from = it.stage;
  await q.query(`update item_stage_log set out_at = now(), by_id = $2, override = nullif($3, '') where item_id = $1 and out_at is null`, [itemId, byId === 'system' ? null : byId, override]);
  await q.query(`insert into item_stage_log(item_id, stage, in_at, note) values ($1, $2, now(), nullif($3, ''))`, [itemId, to, note]);
  await closeAutoTasks(q, itemId, byId === 'system' ? it.installer_id || it.owner_id : byId, 'Stage completed');
  const owner = await ownerFor(q, it, to);
  await q.query(`update items set stage = $2, owner_id = $3, waiting = '', waiting_since = null, waiting_ms = 0 where id = $1`, [itemId, to, owner]);
  const targets = await stageTargets(q);
  const st = stageById[to as keyof typeof stageById];
  const assigner = byId === 'system' ? (await one(q, 'select pm_id from projects where id = $1', [it.project_id]))!.pm_id : byId;
  if (to !== 'closed') {
    if (owner) await pushTask(q, { title: stageTaskTitle(to, it.code), projectId: it.project_id, itemId, assignee: owner, assigner, deadline: to === 'install' ? it.target : addDays(targets[to] ?? st.days), auto: true, proof: stageProof(to) });
    else {
      const pm = (await one(q, 'select pm_id from projects where id = $1', [it.project_id]))!.pm_id;
      await pushTask(q, { title: `Assign installer · ${it.code}`, projectId: it.project_id, itemId, assignee: pm, assigner: pm, deadline: addDays(1), auto: true });
    }
  }
  if (to === 'install' && it.installer_id) {
    const [pc, team] = await Promise.all([one(q, 'select c.name, c.phone from projects p join customers c on c.id = p.customer_id where p.id = $1', [it.project_id]), one(q, 'select name, phone from users where id = $1', [it.installer_id])]);
    await sendTemplate(pc.phone, 'installation_scheduled', [first(pc.name), typeName(it.type).toLowerCase(), fmtDate(it.target), team.name, prettyPhone(team.phone)], { q, related: { type: 'item', id: itemId } });
  }
  const byName = byId === 'system' ? 'system' : await uname(q, byId);
  await act(q, it.project_id, `${it.code} moved ${stageById[from as keyof typeof stageById].short} → ${st.short} by ${byName}${note ? ' · ' + note : ''}${override ? ' · OVERRIDE: ' + override : ''}`);
  if (to === 'closed') {
    // warranty starts at handover; length comes from the company profile (default 10 years)
    const yrs = Number((await one(q, `select value->>'warrantyYears' y from settings where key = 'company'`))?.y ?? 10);
    await q.query(`update items set warranty_until = coalesce(warranty_until, current_date + make_interval(years => $2::int)) where id = $1`, [it.id, yrs]);
    const left = await one(q, `select count(*) n from items where project_id = $1 and stage <> 'closed'`, [it.project_id]);
    if (Number(left!.n) === 0) {
      const pc = await one(q, 'select p.code, c.name, c.phone from projects p join customers c on c.id = p.customer_id where p.id = $1', [it.project_id]);
      await sendTemplate(pc.phone, 'handover_feedback', [first(pc.name), pc.code], { q, related: { type: 'project', id: it.project_id }, buttons: [`RATE:${it.project_id}:5`, `RATE:${it.project_id}:4`, `RATE:${it.project_id}:3`] });
    }
  }
  return { from, to, owner };
}

export async function transition(q: Q, by: U, itemId: string, direction: 'next' | 'back', reason = '') {
  const { it, gi, gp } = await gateInput(q, itemId);
  const k = stageIdx(it.stage), toK = direction === 'back' ? k - 1 : k + 1;
  if (toK < 0 || toK >= STAGES.length) throw bad('This item cannot move further.');
  const to = STAGES[toK].id;
  if (direction === 'back') {
    if (!reason.trim()) throw bad('Say why you are sending it back.');
    await moveIn(q, itemId, to, by.user.id, 'sent back: ' + reason.trim());
    return { to, flags: [] as string[] };
  }
  const g = gatesFor(gi, gp);
  const hardFail = g.filter(x => !x.ok && x.hard), softFail = g.filter(x => !x.ok && !x.hard);
  if (hardFail.length && !(reason.trim() && by.perms.has('override'))) throw new HttpError(409, `Blocked: ${hardFail[0].text}.`, 'gate_blocked', { gates: g });
  const flags = softFail.map(s => 'Moved without: ' + s.text);
  await q.query('update items set flags = $2 where id = $1', [itemId, flags]);
  await moveIn(q, itemId, to, by.user.id, '', hardFail.length ? reason.trim() : '');
  if (hardFail.length) await audit(q, by, 'item.override', `Override on ${it.code}: ${reason.trim()}`, 'item', itemId, { gates: hardFail });
  return { to, flags };
}

/* ---------- assignment ---------- */
export async function assign(q: Q, by: U, itemIds: string[], installer: string, target?: string) {
  const team = await one(q, `select id, name, skills, active from users where id = $1 and role = 'installer'`, [installer]);
  if (!team?.active) throw bad('Choose an active installation team.');
  const miss = new Set<string>();
  for (const id of itemIds) {
    const it = await one(q, 'select * from items where id = $1 for update', [id]);
    if (!it) throw notFound('Item not found');
    if (team.skills.length && !team.skills.includes(it.type)) miss.add(typeName(it.type).toLowerCase());
    await q.query('update items set installer_id = $2, target = coalesce($3, target) where id = $1', [id, installer, target || null]);
    if (it.stage === 'install') {
      await closeAutoTasks(q, id, by.user.id, 'Installer assigned');
      await q.query('update items set owner_id = $2 where id = $1', [id, installer]);
      await pushTask(q, { title: stageTaskTitle('install', it.code), projectId: it.project_id, itemId: id, assignee: installer, assigner: by.user.id, deadline: target || it.target, auto: true, proof: 'photo' });
    }
    await act(q, it.project_id, `${it.code} assigned to ${team.name}${target ? ', target ' + fmtDate(target) : ''}`);
  }
  await audit(q, by, 'assign', `Assigned ${itemIds.length} item(s) to ${team.name}`, 'user', installer, { itemIds, target });
  return { warning: miss.size ? `Note: ${team.name}'s team is not marked for ${[...miss].join(', ')}.` : '' };
}

/* ---------- survey ---------- */
const WallZ = z.object({ label: z.string().regex(/^[A-H]$/), w: z.union([z.number(), z.string()]).optional(), h: z.union([z.number(), z.string()]).optional(), photo: z.string().max(400000).nullable().optional(), notes: z.string().max(1000).default(''),
  photos: z.array(z.object({ ref: z.string().min(1).max(400000), tag: z.string().max(40).default('') })).max(6).default([]),
  obs: z.array(z.object({ type: z.enum(OBSTRUCTIONS as [string, ...string[]]), left: z.coerce.number().int().min(0), floor: z.coerce.number().int().min(0), w: z.coerce.number().int().positive(), h: z.coerce.number().int().positive(),
    px: z.coerce.number().min(0).max(100).nullable().optional(), py: z.coerce.number().min(0).max(100).nullable().optional() })).max(20).default([]) });
const RoomZ = z.object({ id: z.string().min(1).max(60), name: z.string().trim().min(1).max(60), code: z.string().trim().min(1).max(6), ceiling: z.coerce.number().int().min(1000).max(10000).default(2900), floor: z.string().max(60).default(''), shape: z.enum(['rect', 'L', 'custom']).default('rect'),
  walls: z.array(WallZ).min(3).max(8), items: z.array(z.object({ type: z.enum(TYPE_IDS), wall: z.string().regex(/^[A-H]$/), desc: z.string().max(200).default(''), scopeId: z.coerce.number().int().positive().optional().nullable() })).max(30).default([]) });
const DraftZ = z.object({ rooms: z.array(RoomZ).max(60) });
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };

async function saveDraft(q: Q, pid: string, rooms: z.infer<typeof RoomZ>[]) {
  await q.query('delete from rooms where project_id = $1', [pid]);
  let sort = 0;
  for (const r of rooms) {
    await q.query('insert into rooms(id, project_id, name, code, ceiling, floor, shape, sort) values ($1,$2,$3,$4,$5,$6,$7,$8)', [r.id, pid, r.name, r.code.toUpperCase(), r.ceiling, r.floor, r.shape, sort++]);
    for (const w of r.walls) {
      const wr = await one(q, 'insert into walls(room_id, label, w, h, photo, notes, extra_photos) values ($1,$2,$3,$4,$5,$6,$7) returning id', [r.id, w.label, num(w.w), num(w.h), w.photo || null, w.notes || '', JSON.stringify(w.photos || [])]);
      for (const o of w.obs) await q.query('insert into wall_obstructions(wall_id, type, left_mm, floor_mm, w, h, px, py) values ($1,$2,$3,$4,$5,$6,$7,$8)', [wr!.id, o.type, o.left, o.floor, o.w, o.h, o.px ?? null, o.py ?? null]);
    }
    for (const x of r.items) await q.query('insert into room_items(room_id, type, wall, descr, scope_id) values ($1,$2,$3,$4,$5)', [r.id, x.type, x.wall, x.desc, x.scopeId ?? null]);
  }
}
export function surveyProblems(rooms: { name: string; walls: { label: string; w: unknown; h: unknown; photo?: string | null }[]; items: { scope_id?: number | null; scopeId?: number | null }[] }[], scope: { id: number; room_name: string; type: string }[]) {
  const errors: string[] = [], warnings: string[] = [];
  if (!scope.length) errors.push('There is no scope of work for this project. Ask the project manager to add the items to make.');
  if (!rooms.length) errors.push('Add at least one room.');
  const placed = new Map<number, number>();
  for (const r of rooms) {
    for (const w of r.walls) { const miss = [!w.photo && 'photo', !num(w.w) && 'width', !num(w.h) && 'height'].filter(Boolean); if (miss.length) errors.push(`${r.name} · wall ${w.label}: ${miss.join(', ')} missing`); }
    if (r.walls.length === 4) for (const [a, b] of [[0, 2], [1, 3]]) { const x = num(r.walls[a].w), y = num(r.walls[b].w); if (x && y && Math.abs(x - y) > 20) warnings.push(`${r.name}: walls ${r.walls[a].label} and ${r.walls[b].label} differ by ${Math.abs(x - y)} mm.`); }
    for (const x of r.items) { const sid = Number(x.scope_id ?? x.scopeId); if (!sid) { errors.push(`${r.name}: only items in the scope of work can be placed. Ask the project manager to add anything new.`); continue; } placed.set(sid, (placed.get(sid) || 0) + 1); }
  }
  for (const s of scope) { const n = placed.get(s.id) || 0; if (!n) errors.push(`${typeName(s.type)} · ${s.room_name}: not placed on a wall yet`); if (n > 1) errors.push(`${typeName(s.type)} · ${s.room_name}: placed on more than one wall`); }
  for (const sid of placed.keys()) if (!scope.some(s => s.id === sid)) errors.push('An item placed in the survey is no longer in the scope of work. Remove it from the wall.');
  return { errors, warnings };
}

async function canSurvey(q: Q, p: U, pid: string) {
  if (!p.perms.has('survey')) throw forbidden();
  const s = await one(q, 'select * from surveys where project_id = $1 for update', [pid]);
  if (!s) throw notFound('Survey not found');
  if (p.user.role === 'surveyor' && s.assignee_id !== p.user.id) throw forbidden('This survey is assigned to someone else.');
  return s;
}

/* ---------- installer helpers ---------- */
async function itemForInstaller(q: Q, p: U, id: string) {
  const it = await one(q, 'select * from items where id = $1 for update', [id]);
  if (!it) throw notFound('Item not found');
  const own = it.installer_id === p.user.id;
  if (!(own && p.perms.has('install')) && !p.perms.has('edit')) throw forbidden();
  return it;
}

const ProjectZ = z.object({ leadId: z.string().optional().nullable(), customer: z.string().trim().min(2).max(120), phone: z.string(), address: z.string().trim().min(2).max(300), value: z.coerce.number().min(0).max(1e9).default(0),
  pm: z.string(), target: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), surveyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), advance: z.boolean().default(false),
  scope: z.array(ScopeLineZ).min(1, 'Add the scope of work: at least one item to make.').max(40) });
const fileRef = z.string().regex(/^upload:[A-Za-z0-9_-]+\.(pdf|jpg|png|webp)$/, 'Upload the file first');
const ItemPatchZ = z.object({ prodPiNo: z.string().trim().max(60).optional(), prodPiAmount: z.coerce.number().min(0).max(1e9).nullable().optional(), prodPiDoc: fileRef.nullable().optional(), hwVendor: z.string().trim().max(80).optional(), hwPoDoc: fileRef.nullable().optional(), hwReceived: z.boolean().optional(), productionDone: z.boolean().optional(), spec: z.record(z.string(), z.string().max(300)).optional(), owner: z.string().optional(), target: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), hwPI: z.boolean().optional(), prodPI: z.boolean().optional(), po: z.string().max(60).optional(),
  dispatch: z.object({ vehicle: z.string().max(40).default(''), boxes: z.coerce.number().int().min(0).max(500).nullable().default(null), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null) }).optional(), delivered: z.boolean().optional(),
  waiting: z.enum(WAITING_REASONS).optional() }).strict();

export function opsRoutes(r: Router) {
  const done = async (ctx: Ctx, extra: Record<string, unknown> = {}) => ({ ok: true, ...extra, state: await staffState(userOf(ctx)) });

  r.post('/api/v1/projects', staff('assign'), async ctx => {
    const b = parse(ProjectZ, ctx.body);
    const out = await tx(q => createProject(q, userOf(ctx), b));
    return done(ctx, out);
  });
  r.patch('/api/v1/projects/:id', staff(), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ siteReady: z.boolean().optional(), notes: z.string().max(2000).optional() }).strict(), ctx.body);
    await tx(async q => {
      const pr = await one(q, 'select * from projects where id = $1 for update', [ctx.params.id]); if (!pr) throw notFound();
      if (b.siteReady !== undefined) { if (!can(ctx, 'payments')) throw forbidden(); await q.query('update projects set site_ready = $2 where id = $1', [pr.id, b.siteReady]); await act(q, pr.id, b.siteReady ? `Site marked ready by ${p.user.name} (civil, electrical, painting, flooring done)` : `Site marked not ready by ${p.user.name}`); }
      if (b.notes !== undefined) { if (!can(ctx, 'edit') && !can(ctx, 'payments')) throw forbidden(); await q.query('update projects set notes = $2 where id = $1', [pr.id, b.notes]); }
    });
    return done(ctx);
  });
  r.post('/api/v1/projects/:id/payments/:mid', staff('payments'), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ received: z.boolean() }), ctx.body);
    await tx(async q => {
      const m = await one(q, 'select * from payment_milestones where id = $1 and project_id = $2', [Number(ctx.params.mid), ctx.params.id]); if (!m) throw notFound();
      await q.query('update payment_milestones set received_at = $2, received_by = $3 where id = $1', [m.id, b.received ? new Date() : null, b.received ? p.user.id : null]);
      await act(q, m.project_id, `Payment ${b.received ? 'received' : 'unmarked'}: ${m.label} (₹${m.amount.toLocaleString('en-IN')}) by ${p.user.name}`);
      await audit(q, p, 'payment', `${b.received ? 'Marked received' : 'Unmarked'} ${m.label} on ${m.project_id}`, 'project', m.project_id);
    });
    return done(ctx);
  });
  r.post('/api/v1/projects/:id/feedback', staff('edit'), async ctx => {
    const b = parse(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(500).default('') }), ctx.body);
    await tx(q => recordFeedback(q, ctx.params.id, b.rating, b.comment, 'staff'));
    return done(ctx);
  });

  r.post('/api/v1/items/:id/transition', staff('edit'), async ctx => {
    const b = parse(z.object({ direction: z.enum(['next', 'back']), reason: z.string().max(300).default('') }), ctx.body);
    const out = await tx(q => transition(q, userOf(ctx), ctx.params.id, b.direction, b.reason));
    return done(ctx, out);
  });
  r.patch('/api/v1/items/:id', staff('edit'), async ctx => {
    const p = userOf(ctx); const b = parse(ItemPatchZ, ctx.body);
    await tx(async q => {
      const it = await one(q, 'select * from items where id = $1 for update', [ctx.params.id]); if (!it) throw notFound();
      const logs: string[] = [];
      if (b.owner !== undefined) { const u = await one(q, 'select name, active from users where id = $1', [b.owner]); if (!u?.active) throw bad('Choose an active person.'); await q.query('update items set owner_id = $2 where id = $1', [it.id, b.owner]); logs.push(`responsible changed to ${u.name}`); }
      if (b.target) { await q.query('update items set target = $2 where id = $1', [it.id, b.target]); logs.push(`target changed to ${fmtDate(b.target)}`); }
      if (b.hwPI !== undefined) { await q.query('update items set hw_pi = $2 where id = $1', [it.id, b.hwPI]); logs.push(b.hwPI ? 'hardware PI raised' : 'hardware PI unmarked'); }
      if (b.prodPI !== undefined) { await q.query('update items set prod_pi = $2 where id = $1', [it.id, b.prodPI]); logs.push(b.prodPI ? 'production PI raised' : 'production PI unmarked'); }
      if (b.po !== undefined) await q.query('update items set po = $2 where id = $1', [it.id, b.po.trim()]);
      if (b.prodPiNo !== undefined) { await q.query('update items set prod_pi_no = $2, prod_pi = $3 where id = $1', [it.id, b.prodPiNo, !!b.prodPiNo]); if (b.prodPiNo && b.prodPiNo !== it.prod_pi_no) logs.push(`factory PI ${b.prodPiNo} raised`); }
      if (b.prodPiAmount !== undefined) await q.query('update items set prod_pi_amount = $2 where id = $1', [it.id, b.prodPiAmount]);
      if (b.prodPiDoc !== undefined) { await q.query('update items set prod_pi_doc = $2 where id = $1', [it.id, b.prodPiDoc]); if (b.prodPiDoc) logs.push('factory PI copy uploaded'); }
      if (b.hwVendor !== undefined) await q.query('update items set hw_vendor = $2 where id = $1', [it.id, b.hwVendor]);
      if (b.hwPoDoc !== undefined) { await q.query('update items set hw_po_doc = $2 where id = $1', [it.id, b.hwPoDoc]); if (b.hwPoDoc) logs.push('hardware PO copy uploaded'); }
      if (b.hwReceived !== undefined) { await q.query('update items set hw_received = $2 where id = $1', [it.id, b.hwReceived]); logs.push(b.hwReceived ? 'hardware received' : 'hardware receipt unmarked'); }
      if (b.productionDone !== undefined) { await q.query('update items set production_done = $2 where id = $1', [it.id, b.productionDone]); logs.push(b.productionDone ? 'factory production complete' : 'production completion unmarked'); }
      if (b.spec !== undefined) {
        const clean = Object.fromEntries(MATERIAL_FIELDS.map(f => [f.id, String(b.spec![f.id] ?? '').trim()]).filter(([, v]) => v));
        await q.query('update items set spec = $2 where id = $1', [it.id, JSON.stringify(clean)]);
      }
      if (b.dispatch) await q.query('update items set dispatch_vehicle = $2, dispatch_boxes = $3, dispatch_date = $4 where id = $1', [it.id, b.dispatch.vehicle, b.dispatch.boxes, b.dispatch.date]);
      if (b.waiting !== undefined && b.waiting !== it.waiting) {
        const W: Record<string, string> = { client_approval: 'client approval', client_payment: 'client payment', site_not_ready: 'site not ready', client_other: 'the client' };
        if (b.waiting && !it.waiting) await q.query(`update items set waiting = $2, waiting_since = now() where id = $1`, [it.id, b.waiting]);
        else if (b.waiting) await q.query(`update items set waiting = $2 where id = $1`, [it.id, b.waiting]);
        else await q.query(`update items set waiting = '', waiting_ms = waiting_ms + coalesce((extract(epoch from (now() - waiting_since)) * 1000)::bigint, 0), waiting_since = null where id = $1`, [it.id]);
        logs.push(b.waiting ? `waiting on ${W[b.waiting]} (stage clock paused)` : 'no longer waiting on the client (clock running)');
      }
      if (b.delivered !== undefined) { await q.query('update items set delivered = $2 where id = $1', [it.id, b.delivered]); logs.push(b.delivered ? 'material delivered at site' : 'delivery unmarked'); }
      for (const l of logs) await act(q, it.project_id, `${it.code}: ${l} (${p.user.name})`);
    });
    return done(ctx);
  });
  r.post('/api/v1/items/:id/drawings', staff('edit'), async ctx => {
    const p = userOf(ctx);
    const b = parse(z.object({ file: fileRef, notes: z.string().max(500).default(''), spec: z.record(z.string(), z.string().max(300)).optional(), boxes: z.array(z.string().trim().min(1).max(80)).min(1).max(60).optional() }), ctx.body || {});
    await tx(async q => {
      const it = await one(q, 'select * from items where id = $1 for update', [ctx.params.id]); if (!it) throw notFound();
      if (!(await one(q, 'select 1 from uploads where id = $1', [b.file.slice(7)]))) throw bad('That file was not uploaded. Try again.');
      if (b.spec) {
        const clean = Object.fromEntries(MATERIAL_FIELDS.map(f => [f.id, String(b.spec![f.id] ?? '').trim()]).filter(([, v]) => v));
        await q.query('update items set spec = $2 where id = $1', [it.id, JSON.stringify(clean)]);
      }
      if (b.boxes && !it.dispatch_date && !it.install_done) {
        await q.query('delete from item_boxes where item_id = $1', [it.id]);
        for (const [i, label] of b.boxes.entries()) await q.query('insert into item_boxes(item_id, n, label) values ($1,$2,$3)', [it.id, i + 1, label]);
      }
      const spec = (await one(q, 'select spec from items where id = $1', [it.id]))!.spec;
      const n = Number((await one(q, `select count(*) n from documents where item_id = $1 and kind = 'drawing'`, [it.id]))!.n);
      await q.query(`insert into documents(item_id, kind, rev, url, by_id, notes, spec) values ($1, 'drawing', $2, $3, $4, $5, $6)`, [it.id, 'R' + n, b.file, p.user.id, b.notes, JSON.stringify(spec)]);
      await act(q, it.project_id, `${it.code}: production drawing R${n} uploaded with material spec and packing list (${p.user.name})`);
    });
    return done(ctx);
  });
  r.post('/api/v1/items/:id/drawings/send', staff('edit'), async ctx => {
    await tx(async q => {
      const it = await one(q, 'select * from items where id = $1', [ctx.params.id]); if (!it) throw notFound();
      const d = await one(q, `select rev, approved_at from documents where item_id = $1 and kind = 'drawing' order by id desc limit 1`, [it.id]);
      if (!d || d.approved_at) throw bad('Upload a new drawing first.');
      const pc = await one(q, 'select c.name, c.phone from projects p join customers c on c.id = p.customer_id where p.id = $1', [it.project_id]);
      await sendTemplate(pc.phone, 'drawing_for_approval', [first(pc.name), d.rev, `${typeName(it.type).toLowerCase()} (${it.room_name})`], { q, related: { type: 'item', id: it.id }, buttons: [`DRAWING_APPROVE:${it.id}`, `DRAWING_CHANGE:${it.id}`] });
      await act(q, it.project_id, `${it.code}: ${d.rev} sent to customer on WhatsApp with Approve button`);
    });
    return done(ctx);
  });
  r.post('/api/v1/items/:id/drawings/approve', staff('edit'), async ctx => {
    const p = userOf(ctx);
    await tx(q => approveDrawing(q, ctx.params.id, 'staff', p.user.name));
    return done(ctx);
  });
  /* project documents: floor plan, furniture drawings, final production drawings, PI / PO copies, handover */
  r.post('/api/v1/projects/:id/documents', staff('edit'), async ctx => {
    const p = userOf(ctx);
    const b = parse(z.object({ category: z.enum(DOC_CATEGORY_IDS), title: z.string().trim().min(2).max(120), file: fileRef, notes: z.string().max(500).default(''), itemId: z.string().nullable().optional() }), ctx.body);
    await tx(async q => {
      const pr = await one(q, 'select id from projects where id = $1', [ctx.params.id]); if (!pr) throw notFound();
      if (!(await one(q, 'select 1 from uploads where id = $1', [b.file.slice(7)]))) throw bad('That file was not uploaded. Try again.');
      if (b.itemId && !(await one(q, 'select 1 from items where id = $1 and project_id = $2', [b.itemId, pr.id]))) throw bad('That item is not in this project.');
      const cat = DOC_CATEGORIES.find(c => c.id === b.category)!;
      const n = Number((await one(q, 'select count(*) n from project_docs where project_id = $1 and category = $2 and title = $3', [pr.id, b.category, b.title]))!.n);
      await q.query('insert into project_docs(project_id, item_id, category, title, file, notes, rev, shared, by_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [pr.id, b.itemId || null, b.category, b.title, b.file, b.notes, 'R' + n, cat.customer, p.user.id]);
      await act(q, pr.id, `${cat.name}: "${b.title}" R${n} uploaded (${p.user.name})${cat.customer ? ', visible to the customer' : ''}`);
    });
    return done(ctx);
  });
  r.delete('/api/v1/documents/:id', staff('edit'), async ctx => {
    const p = userOf(ctx);
    await tx(async q => {
      const d = await one(q, 'select * from project_docs where id = $1', [Number(ctx.params.id)]); if (!d) throw notFound();
      if (d.by_id !== p.user.id && !p.perms.has('admin')) throw forbidden('Only the person who uploaded it or an admin can remove it.');
      await q.query('delete from project_docs where id = $1', [d.id]);
      await act(q, d.project_id, `Removed document "${d.title}" ${d.rev} (${p.user.name})`);
    });
    return done(ctx);
  });

  r.post('/api/v1/assignments', staff('assign'), async ctx => {
    const b = parse(z.object({ itemIds: z.array(z.string()).min(1).max(200), installer: z.string(), target: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable() }), ctx.body);
    const out = await tx(q => assign(q, userOf(ctx), b.itemIds, b.installer, b.target || undefined));
    return done(ctx, out);
  });

  /* snags */
  r.post('/api/v1/items/:id/snags', staff(), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ type: z.enum(SNAG_TYPES as [string, ...string[]]), part: z.string().trim().min(1).max(120), note: z.string().max(500).default(''), photo: z.string().max(400000).nullable().optional() }), ctx.body);
    await tx(async q => {
      const it = await itemForInstaller(q, p, ctx.params.id);
      const sid = 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      await q.query('insert into snags(id, item_id, part, type, note, photo, raised_by) values ($1,$2,$3,$4,$5,$6,$7)', [sid, it.id, b.part, b.type, b.note, b.photo || null, p.user.id]);
      await act(q, it.project_id, `Snag raised on ${it.code}: ${b.type} · ${b.part}`);
      const purchase = await firstUserOfRole(q, 'purchase'); const pm = (await one(q, 'select pm_id from projects where id = $1', [it.project_id]))!.pm_id;
      await pushTask(q, { title: `Snag reorder · ${it.code} · ${b.part}`, projectId: it.project_id, itemId: it.id, assignee: purchase || pm, assigner: p.user.id, deadline: addDays(1), priority: 'urgent' });
    });
    return done(ctx);
  });
  r.post('/api/v1/snags/:sid/advance', staff('edit'), async ctx => {
    const p = userOf(ctx);
    await tx(async q => {
      const s = await one(q, 'select s.*, i.code, i.project_id from snags s join items i on i.id = s.item_id where s.id = $1 for update', [ctx.params.sid]); if (!s) throw notFound();
      const next = SNAG_FLOW[Math.min(SNAG_FLOW.length - 1, SNAG_FLOW.indexOf(s.status) + 1)];
      await q.query('update snags set status = $2, updated_at = now() where id = $1', [s.id, next]);
      await act(q, s.project_id, `${s.code}: snag "${s.part}" marked ${next} (${p.user.name})`);
    });
    return done(ctx);
  });

  /* installer app */
  r.post('/api/v1/items/:id/boxes/:n', staff(), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ got: z.boolean().nullable() }), ctx.body);
    await tx(async q => { const it = await itemForInstaller(q, p, ctx.params.id); await q.query('update item_boxes set got = $3 where item_id = $1 and n = $2', [it.id, Number(ctx.params.n), b.got]); });
    return done(ctx);
  });
  r.post('/api/v1/items/:id/work/start', staff(), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ lat: z.number().optional(), lng: z.number().optional() }), ctx.body || {});
    await tx(async q => {
      const it = await itemForInstaller(q, p, ctx.params.id);
      if (it.stage !== 'install') throw bad('Material is not at site yet; this job is not at installation.');
      if (await one(q, 'select 1 from work_sessions where item_id = $1 and end_at is null', [it.id])) throw bad('Work is already running.');
      await q.query('insert into work_sessions(item_id, start_at, by_id, start_lat, start_lng) values ($1, now(), $2, $3, $4)', [it.id, p.user.id, b.lat ?? null, b.lng ?? null]);
      const auto = await many(q, `select id from tasks where item_id = $1 and auto and status = 'todo'`, [it.id]);
      for (const t of auto) { await q.query(`update tasks set status = 'progress' where id = $1`, [t.id]); await q.query(`insert into task_events(task_id, e, by_id) values ($1, 'started', $2)`, [t.id, p.user.id]); }
      await act(q, it.project_id, `${it.code}: installation started by ${p.user.name} (GPS + before photo)`);
    });
    return done(ctx);
  });
  r.post('/api/v1/items/:id/work/pause', staff(), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ reason: z.enum(PAUSE_REASONS as [string, ...string[]]) }), ctx.body);
    await tx(async q => {
      const it = await itemForInstaller(q, p, ctx.params.id);
      const r2 = await q.query('update work_sessions set end_at = now(), reason = $2 where item_id = $1 and end_at is null', [it.id, b.reason]);
      if (!r2.rowCount) throw bad('Work is not running.');
      await act(q, it.project_id, `${it.code}: paused · ${b.reason}`);
    });
    return done(ctx);
  });
  r.post('/api/v1/items/:id/complete/request-otp', staff(), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ checklist: z.record(z.boolean()), photo: z.string().min(1).max(400000) }), ctx.body);
    if (!CHECKLIST.every(c => b.checklist[c])) throw bad('Tick every checklist item first.');
    const out = await tx(async q => {
      const it = await itemForInstaller(q, p, ctx.params.id);
      if (it.stage !== 'install' || it.install_done) throw bad('This job is not open for completion.');
      await q.query('update items set checklist = $2, after_photo = $3 where id = $1', [it.id, b.checklist, b.photo]);
      const pc = await one(q, 'select c.name, c.phone from projects p join customers c on c.id = p.customer_id where p.id = $1', [it.project_id]);
      const devCode = await issueOtp(q, pc.phone, 'signoff', ctx.ip, it.id);
      return { customer: pc.name, devCode };
    });
    return done(ctx, out);
  });
  r.post('/api/v1/items/:id/complete/verify', staff(), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ code: z.string().regex(/^\d{4,8}$/) }), ctx.body);
    const out = await tx(async q => {
      const it = await itemForInstaller(q, p, ctx.params.id);
      const pc = await one(q, 'select c.phone from projects p join customers c on c.id = p.customer_id where p.id = $1', [it.project_id]);
      await checkOtp(q, pc.phone, 'signoff', b.code, it.id);
      await q.query('update work_sessions set end_at = now(), reason = $2 where item_id = $1 and end_at is null', [it.id, 'Completed']);
      await q.query('update items set install_done = true, signed_off = true, installed_at = now() where id = $1', [it.id]);
      const hrs = (await one(q, `select coalesce(sum(extract(epoch from (coalesce(end_at, now()) - start_at))), 0) / 3600 h from work_sessions where item_id = $1`, [it.id]))!.h;
      await act(q, it.project_id, `${it.code} installed by ${p.user.name} · customer signed off by OTP · ${Number(hrs).toFixed(1)} h work time`);
      const open = Number((await one(q, `select count(*) n from snags where item_id = $1 and status <> 'fixed'`, [it.id]))!.n);
      if (!open) await moveIn(q, it.id, 'handover', p.user.id, 'auto after sign-off');
      return { heldBySnags: open };
    });
    return done(ctx, out);
  });

  /* survey app */
  r.post('/api/v1/surveys/:pid/check-in', staff('survey'), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ lat: z.number().optional(), lng: z.number().optional() }), ctx.body || {});
    await tx(async q => {
      const s = await canSurvey(q, p, ctx.params.pid);
      if (s.status === 'submitted') throw bad('This survey is already submitted.');
      await q.query(`update surveys set check_in_at = coalesce(check_in_at, now()), check_in_lat = $2, check_in_lng = $3, status = 'in-progress' where project_id = $1`, [s.project_id, b.lat ?? null, b.lng ?? null]);
      await act(q, s.project_id, `Surveyor ${p.user.name} checked in at site (GPS recorded)`);
    });
    return done(ctx);
  });
  r.put('/api/v1/surveys/:pid/draft', staff('survey'), async ctx => {
    const p = userOf(ctx); const b = parse(DraftZ, ctx.body);
    await tx(async q => {
      const s = await canSurvey(q, p, ctx.params.pid);
      if (s.status === 'submitted') throw bad('This survey is already submitted.');
      await saveDraft(q, s.project_id, b.rooms);
    });
    return { ok: true, savedAt: Date.now() };
  });
  r.post('/api/v1/surveys/:pid/submit', staff('survey'), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ signed: z.boolean().default(false), rooms: z.array(RoomZ).max(60).optional() }), ctx.body || {});
    const out = await tx(async q => {
      const s = await canSurvey(q, p, ctx.params.pid);
      if (s.status === 'submitted') throw bad('This survey is already submitted.');
      if (b.rooms) await saveDraft(q, s.project_id, b.rooms);
      const pid = s.project_id;
      const rooms = await many(q, 'select * from rooms where project_id = $1 order by sort', [pid]);
      const shaped = await Promise.all(rooms.map(async r2 => ({ ...r2, walls: await many(q, 'select * from walls where room_id = $1 order by label', [r2.id]), items: await many(q, 'select * from room_items where room_id = $1 order by id', [r2.id]) })));
      const scope = await many(q, `select * from project_scope where project_id = $1 and status = 'active' and item_id is null order by sort, id`, [pid]);
      const pr = surveyProblems(shaped, scope);
      if (pr.errors.length) throw new HttpError(400, pr.errors[0], 'survey_incomplete', pr);
      const proj = await one(q, 'select p.*, c.name cname, c.phone cphone from projects p join customers c on c.id = p.customer_id where p.id = $1', [pid]);
      await q.query(`update surveys set status = 'submitted', submitted_at = now(), minutes = greatest(1, round(extract(epoch from (now() - coalesce(check_in_at, now()))) / 60)), signed = $2 where project_id = $1`, [pid, b.signed]);
      const designers = (await many(q, `select id from users where role = 'designer' and active order by created_at`)).map(d => d.id);
      let di = 0, created = 0;
      for (const r2 of shaped) for (const x of r2.items) {
        const s = scope.find(z => z.id === Number(x.scope_id)); if (!s) continue;
        const designer = designers.length ? designers[di++ % designers.length] : null;
        await createItemFromScope(q, s, { code: r2.code, name: r2.name }, x.wall, x.descr, p.user.id, designer, proj.target, proj.created_at);
        created++;
      }
      const t = await many(q, `select id from tasks where project_id = $1 and auto and item_id is null and title like 'Site survey%' and status <> 'done'`, [pid]);
      for (const x of t) { await q.query(`update tasks set status = 'done', done_at = now() where id = $1`, [x.id]); await q.query(`insert into task_events(task_id, e, by_id, note) values ($1, 'done', $2, 'Survey submitted')`, [x.id, p.user.id]); }
      const walls = shaped.reduce((a, r2) => a + r2.walls.length, 0);
      const mins = (await one(q, 'select minutes from surveys where project_id = $1', [pid]))!.minutes;
      await act(q, pid, `Site survey submitted by ${p.user.name} · ${shaped.length} rooms, ${walls} walls, ${mins} min on site${b.signed ? ' · customer signed' : ''}`);
      await sendTemplate(proj.cphone, 'survey_done', [first(proj.cname), proj.code], { q, related: { type: 'project', id: pid } });
      if (proj.lead_id) await q.query('insert into lead_timeline(lead_id, text, auto) values ($1, $2, true)', [proj.lead_id, `Site survey completed for ${proj.code}`]);
      return { created, warnings: pr.warnings };
    });
    return done(ctx, out);
  });
}

/* used by the customer app and WhatsApp buttons too */
export async function approveDrawing(q: Q, itemId: string, via: 'staff' | 'customer_app' | 'whatsapp', who: string) {
  const it = await one(q, 'select * from items where id = $1', [itemId]); if (!it) throw notFound();
  const d = await one(q, `select id, rev, approved_at from documents where item_id = $1 and kind = 'drawing' order by id desc limit 1`, [itemId]);
  if (!d) throw bad('No drawing uploaded yet.');
  if (d.approved_at) return { already: true };
  await q.query('update documents set approved_at = now(), approved_via = $2 where id = $1', [d.id, via]);
  await act(q, it.project_id, `${it.code}: customer approved ${d.rev} ${via === 'staff' ? `(recorded by ${who})` : via === 'whatsapp' ? 'on WhatsApp' : 'in the customer app'}`);
  return { rev: d.rev };
}
export async function recordFeedback(q: Q, pid: string, rating: number, comment: string, channel: string) {
  const p = await one(q, 'select * from projects where id = $1', [pid]); if (!p) throw notFound();
  await q.query('update projects set feedback_rating = $2, feedback_comment = $3, feedback_at = now() where id = $1', [pid, rating, comment || null]);
  await act(q, pid, `Customer rated ${rating}/5 (${channel})${comment ? ': ' + comment : ''}`);
  if (p.lead_id) await q.query('insert into lead_timeline(lead_id, text, auto) values ($1, $2, true)', [p.lead_id, `Project ${p.code} completed · customer rated ${rating}/5`]);
}
