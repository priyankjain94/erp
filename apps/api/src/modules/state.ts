import { db, many, one, type Q } from '../core/db.js';
import { prettyPhone } from '../core/util.js';
import { CUSTOMER_STAGE, DEFAULT_ROLES, PERMS } from '../domain.js';
import type { Principal } from './auth.js';
import { signedFileUrl } from '../integrations/storage.js';

const ms = (d: Date | string | null) => d ? new Date(d).getTime() : null;
const group = <T extends Record<string, any>>(rows: T[], key: string) => {
  const m = new Map<any, T[]>(); for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); } return m;
};

async function loadProjects(q: Q, ids: string[] | null, opts: { money: boolean; customer?: boolean }) {
  const where = ids ? 'where p.id = any($1::text[])' : '';
  const projects = await many(q, `select p.*, c.name customer, c.phone from projects p join customers c on c.id = p.customer_id ${where} order by p.created_at desc`, ids ? [ids] : []);
  if (!projects.length) return [];
  const pids = projects.map(p => p.id);
  const [pays, acts, surveys, rooms, walls, obs, ritems, pdocs] = await Promise.all([
    many(q, 'select * from payment_milestones where project_id = any($1::text[]) order by sort, id', [pids]),
    many(q, 'select project_id, text, created_at from project_activity where project_id = any($1::text[]) order by created_at, id', [pids]),
    many(q, 'select * from surveys where project_id = any($1::text[])', [pids]),
    many(q, 'select * from rooms where project_id = any($1::text[]) order by sort, name', [pids]),
    many(q, 'select w.* from walls w join rooms r on r.id = w.room_id where r.project_id = any($1::text[]) order by w.label', [pids]),
    many(q, 'select o.* from wall_obstructions o join walls w on w.id = o.wall_id join rooms r on r.id = w.room_id where r.project_id = any($1::text[]) order by o.id', [pids]),
    many(q, 'select ri.* from room_items ri join rooms r on r.id = ri.room_id where r.project_id = any($1::text[]) order by ri.id', [pids]),
    many(q, `select * from project_docs where project_id = any($1::text[]) ${opts.customer ? 'and shared' : ''} ${opts.money ? '' : "and category not in ('pi','po','quotation')"} order by created_at desc, id desc`, [pids])
  ]);
  const docBy = group(pdocs, 'project_id'), payBy = group(pays, 'project_id'), actBy = group(acts, 'project_id'), roomBy = group(rooms, 'project_id'), wallBy = group(walls, 'room_id'), obsBy = group(obs, 'wall_id'), riBy = group(ritems, 'room_id');
  const survBy = new Map(surveys.map(s => [s.project_id, s]));
  return projects.map(p => {
    const s = survBy.get(p.id) || {};
    return {
      id: p.id, code: p.code, leadId: p.lead_id, customer: p.customer, phone: prettyPhone(p.phone), address: p.address, pm: p.pm_id,
      value: opts.money ? p.value : 0, created: ms(p.created_at), target: p.target, siteReady: p.site_ready, notes: p.notes,
      feedback: p.feedback_rating ? { rating: p.feedback_rating, comment: p.feedback_comment || '', at: ms(p.feedback_at) } : null,
      payments: opts.money ? (payBy.get(p.id) || []).map(m => ({ id: m.id, label: m.label, pct: m.pct, amount: m.amount, gate: m.gate, received: !!m.received_at })) : [],
      activity: (actBy.get(p.id) || []).map(a => ({ t: ms(a.created_at), text: a.text })),
      docs: (docBy.get(p.id) || []).map(d => ({ id: d.id, category: d.category, title: d.title, rev: d.rev, notes: d.notes, itemId: d.item_id, by: d.by_id, at: ms(d.created_at), url: signedFileUrl(d.file), shared: d.shared })),
      survey: {
        status: s.status || 'scheduled', assignee: s.assignee_id || null, scheduled: ms(s.scheduled_at), checkIn: ms(s.check_in_at), at: ms(s.submitted_at), mins: s.minutes ?? null, signed: !!s.signed,
        rooms: (roomBy.get(p.id) || []).map(r => ({
          id: r.id, name: r.name, code: r.code, ceiling: r.ceiling, floor: r.floor, shape: r.shape,
          walls: (wallBy.get(r.id) || []).map(w => ({ label: w.label, w: w.w ?? '', h: w.h ?? '', photo: w.photo, photoUrl: signedFileUrl(w.photo), notes: w.notes,
            obs: (obsBy.get(w.id) || []).map(o => ({ type: o.type, left: o.left_mm, floor: o.floor_mm, w: o.w, h: o.h })) })),
          items: (riBy.get(r.id) || []).map(x => ({ type: x.type, wall: x.wall, desc: x.descr }))
        }))
      }
    };
  });
}

async function loadItems(q: Q, where: string, params: unknown[]) {
  const items = await many(q, `select * from items ${where} order by created_at, id`, params);
  if (!items.length) return [];
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
    snags: (n.get(i.id) || []).map(x => ({ id: x.id, part: x.part, type: x.type, note: x.note, photo: signedFileUrl(x.photo), status: x.status, raisedBy: x.raised_by, at: ms(x.created_at) })),
    log: (l.get(i.id) || []).map(x => ({ stage: x.stage, in: ms(x.in_at), out: ms(x.out_at), by: x.by_id, override: x.override || undefined })),
    flags: i.flags || []
  }));
}

async function loadTasks(q: Q, where: string, params: unknown[]) {
  const tasks = await many(q, `select * from tasks ${where} order by created_at desc, id`, params);
  if (!tasks.length) return [];
  const ev = group(await many(q, 'select * from task_events where task_id = any($1::text[]) order by created_at, id', [tasks.map(t => t.id)]), 'task_id');
  return tasks.map(t => ({
    id: t.id, title: t.title, projectId: t.project_id, itemId: t.item_id, assignee: t.assignee_id, assigner: t.assigner_id, created: ms(t.created_at),
    deadline: t.deadline, priority: t.priority, status: t.status, blockedReason: t.blocked_reason, auto: t.auto, proof: t.proof, repeat: t.repeat, reminders: t.reminders,
    events: (ev.get(t.id) || []).map(e => ({ e: e.e, by: e.by_id, to: e.to_id || undefined, note: e.note || undefined, t: ms(e.created_at) }))
  }));
}

export async function loadLeads(q: Q) {
  const leads = await many(q, `select l.*, u.name owner_name from leads l left join users u on u.id = l.owner_id order by l.created_at desc`);
  const ids = leads.map(l => l.id);
  const msgs = group(await many(q, 'select * from lead_messages where lead_id = any($1::text[]) order by created_at, id', [ids]), 'lead_id');
  const tl = group(await many(q, 'select * from lead_timeline where lead_id = any($1::text[]) order by created_at, id', [ids]), 'lead_id');
  return leads.map(l => ({
    id: l.id, name: l.name, phone: prettyPhone(l.phone), source: l.source, sub: l.sub, ref: l.ref_partner_id || l.ref_lead_id || null, showroom: l.showroom,
    stage: l.stage, owner: l.owner_name || '', value: l.value, interest: l.interest, area: l.area, fu: l.follow_up, lastIn: ms(l.last_inbound_at),
    created: ms(l.created_at), lostReason: l.lost_reason, dup: l.dup_flag,
    meta: l.meta_leadgen_id ? { form: l.meta_form_id, ad: l.meta_ad_name, campaign: l.meta_campaign_name } : null,
    msgs: (msgs.get(l.id) || []).map(m => ({ from: m.from_kind, text: m.text, t: ms(m.created_at), tpl: m.tpl || undefined, status: m.status })),
    timeline: (tl.get(l.id) || []).map(t => ({ t: ms(t.created_at), text: t.text, auto: t.auto || undefined }))
  }));
}

/** Everything the signed-in staff member may see, in the shapes the web app renders. */
export async function staffState(p: Extract<Principal, { type: 'user' }>, q: Q = db) {
  const me = p.user.id, perms = p.perms;
  const seeAllProjects = perms.has('projects') || perms.has('ops') || perms.has('tasksAll') || perms.has('assign');
  const users = (await many(q, 'select id, name, role, title, phone, active, members, skills from users order by created_at, name'))
    .map(u => ({ id: u.id, name: u.name, role: u.role, title: u.title, phone: prettyPhone(u.phone), active: u.active, members: u.members, skills: u.skills.length ? u.skills : undefined }));
  const roleRows = await many(q, 'select role, perm, allowed from role_permissions');
  const roles: Record<string, Record<string, boolean>> = JSON.parse(JSON.stringify(DEFAULT_ROLES));
  for (const r of roleRows) (roles[r.role] ||= {})[r.perm] = r.allowed;
  for (const k of PERMS) roles.admin[k] = true;

  let items, projects;
  if (seeAllProjects) {
    items = await loadItems(q, '', []);
    projects = await loadProjects(q, null, { money: perms.has('payments') || perms.has('ops') || perms.has('crm') || perms.has('edit') });
  } else {
    items = await loadItems(q, 'where installer_id = $1', [me]);
    const pids = [...new Set(items.map(i => i.projectId))];
    projects = await loadProjects(q, pids, { money: false });
  }
  const tasks = perms.has('tasksAll') ? await loadTasks(q, '', []) : await loadTasks(q, 'where assignee_id = $1 or assigner_id = $1', [me]);
  const audit = perms.has('admin') ? (await many(q, 'select actor_id, text, created_at from audit_log order by id desc limit 100')).map(a => ({ t: ms(a.created_at), by: a.actor_id, text: a.text })) : [];
  const crm = perms.has('crm') ? {
    leads: await loadLeads(q),
    partners: (await many(q, 'select * from partners order by name')).map(x => ({ id: x.id, name: x.name, firm: x.firm, type: x.type, tier: x.tier, rate: x.rate, owner: x.owner_id ? users.find(u => u.id === x.owner_id)?.name : '' })),
    autos: (await many(q, 'select * from automations order by length(id), id')).map(a => ({ id: a.id, fam: a.fam, name: a.name, when: a.when_text, then: a.then_text, on: a.enabled, runs: a.runs }))
  } : { leads: [], partners: [], autos: [] };
  const wa = await one(q, `select count(*) filter (where status = 'simulated') sim, count(*) filter (where status in ('sent','delivered','read')) sent, count(*) filter (where status = 'failed') failed from wa_messages where created_at > now() - interval '30 days'`);
  return { erp: { me, projects, items, tasks, users, roles, audit }, crm, server: { wa } };
}

/** What a customer sees: only their own projects, in customer-friendly terms. */
export async function customerState(customerId: number, q: Q = db) {
  const pids = (await many(q, 'select id from projects where customer_id = $1', [customerId])).map(r => r.id);
  const projects = await loadProjects(q, pids, { money: true, customer: true });
  const items = await loadItems(q, 'where project_id = any($1::text[])', [pids]);
  const staffIds = [...new Set([...projects.map(p => p.pm), ...items.map(i => i.installer)].filter(Boolean))];
  const staff = await many(q, 'select id, name, phone from users where id = any($1::text[])', [staffIds]);
  return {
    projects: projects.map(p => ({ ...p, activity: [], notes: '' })),
    items: items.map(i => ({ ...i, customerStage: CUSTOMER_STAGE[i.stage as keyof typeof CUSTOMER_STAGE], sessions: [], log: [], boxes: [], flags: [], prodPiNo: '', prodPiAmount: null, prodPiDoc: null, hwVendor: '', hwPoDoc: null })),
    staff: staff.map(s => ({ id: s.id, name: s.name, phone: prettyPhone(s.phone) }))
  };
}
