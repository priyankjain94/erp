import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './core/config.js';
import { many, one, pool, tx, type Q } from './core/db.js';
import { migrate } from './core/migrate.js';
import { addDays, log, normPhone } from './core/util.js';
import { AUTOMATIONS, BOXES, CHECKLIST, DEFAULT_PAYMENTS, ITEM_TYPES, STAGES, stageIdx, stageProof, stageTaskTitle } from './domain.js';
import { seedRolePermissions } from './modules/auth.js';

/** Always safe to run: roles, automations, settings, and the first admin (from ADMIN_PHONE). */
export async function bootstrap(q: Q) {
  await seedRolePermissions(q);
  for (const [id, fam, name, when, then, on] of AUTOMATIONS)
    await q.query('insert into automations(id, fam, name, when_text, then_text, enabled) values ($1,$2,$3,$4,$5,$6) on conflict do nothing', [id, fam, name, when, then, on]);
  await q.query(`insert into settings(key, value) values ('holidays', '[]') on conflict do nothing`);
  await ensureSuperAdmin(q);
}

/** The ADMIN_PHONE number is the super admin: on every start it is made sure to exist, be active and be an admin,
    so the business can never be locked out. In the app it cannot be deactivated or have its role changed. */
export const SUPER_ADMIN_ID = 'superadmin';
async function ensureSuperAdmin(q: Q) {
  if (!config.ADMIN_PHONE) return;
  const phone = normPhone(config.ADMIN_PHONE);
  if (!phone) throw new Error('ADMIN_PHONE is not a valid mobile number');
  const existing = await one(q, 'select id from users where phone = $1', [phone]);
  const email = config.ADMIN_EMAIL.trim().toLowerCase() || null;
  if (existing) {
    await q.query(`update users set role = 'admin', active = true, email = coalesce($2, email) where id = $1`, [existing.id, email]);
    return;
  }
  const users = Number((await one(q, 'select count(*) n from users'))!.n);
  const id = users ? SUPER_ADMIN_ID : 'owner';
  await q.query(`insert into users(id, name, phone, role, title) values ($1, $2, $3, 'admin', 'Super admin') on conflict (id) do update set phone = excluded.phone, role = 'admin', active = true`, [id, config.ADMIN_NAME, phone]);
  if (email) await q.query('update users set email = $2 where id = $1', [id, email]);
  log.info('super admin ready', config.ADMIN_NAME, phone.slice(0, 5) + '•••••' + phone.slice(-2));
}

/* ---------------- demo data (same company as the tested prototype) ---------------- */
const DAY = 864e5, HR = 36e5;
const USERS: [string, string, string, string][] = [
  ['owner', 'Owner', 'admin', ''], ['meera', 'Meera', 'ops_head', ''], ['vikram', 'Vikram', 'pm', ''], ['ankit', 'Ankit', 'sales', ''], ['priya', 'Priya', 'sales', ''], ['rahul', 'Rahul', 'sales', ''],
  ['sana', 'Sana', 'surveyor', ''], ['deepa', 'Deepa', 'designer', ''], ['arjun', 'Arjun', 'designer', ''], ['manish', 'Manish', 'purchase', ''], ['kiran', 'Kiran', 'production', ''],
  ['ravi', 'Ravi', 'installer', 'Installation lead · team of 3'], ['suresh', 'Suresh', 'installer', 'Installation lead · team of 2'], ['imran', 'Imran', 'installer', 'Installation lead · team of 2']];
const CREW: Record<string, { members: string[]; skills: string[] }> = { ravi: { members: ['Raju', 'Mohan'], skills: ['WR', 'TV', 'DR', 'ST', 'SR', 'CU', 'VN', 'OT'] }, suresh: { members: ['Ajay'], skills: [] }, imran: { members: ['Salim'], skills: ['KT', 'CU', 'VN', 'OT'] } };
const SAMPLE_SPEC: Record<string, Record<string, string>> = {
  WR: { size: '2400 × 2400 × 600', carcass: 'BWP plywood 18 mm', shutter: 'HDHMR 18 mm', finish: 'Laminate 1 mm, Merino 22001 SUD', hardware: 'Hettich soft-close hinges and channels', inner: 'Frosty white 0.8 mm', edge: '2 mm PVC, matching' },
  TV: { size: '2400 × 500 × 400', carcass: 'BWP plywood 18 mm', shutter: 'HDHMR 18 mm', finish: 'Acrylic gloss, Rehau RAUVISIO white', hardware: 'Hettich push-to-open', edge: '2 mm PVC, matching' },
  VN: { size: '900 × 600 × 500', carcass: 'BWP plywood 18 mm (waterproof)', shutter: 'HDHMR 18 mm', finish: 'Laminate 1 mm, Greenlam anti-fingerprint', hardware: 'Hettich soft-close hinges' },
  KT: { size: 'L-shape 3200 + 2400, base 850 × 560, wall 700 × 350', carcass: 'BWP plywood 18 mm', shutter: 'HDHMR 18 mm', finish: 'Acrylic gloss, Rehau RAUVISIO', hardware: 'Hettich InnoTech drawers, soft-close hinges', accessories: 'Tall pull-out, corner carousel, cutlery tray', edge: '2 mm PVC, matching' },
  OT: { size: 'As per drawing', carcass: 'BWP plywood 18 mm', shutter: 'HDHMR 18 mm', finish: 'Laminate 1 mm', hardware: 'Hettich soft-close' }
};
export const demoPhone = (i: number) => '+9190000000' + String(i + 1).padStart(2, '0');

const PARTNERS = [['p1', 'Ar. Neha Agrawal', 'Studio Kaya', 'architect', 'Gold', 5, 'priya'], ['p2', 'Rohit Sahu', 'Sahu Constructions', 'contractor', 'Silver', 3, 'rahul'], ['p3', 'Vikas Jain', 'Jain Realty', 'agent', 'Silver', 2, 'ankit'],
  ['p4', 'Ar. Pooja Verma', 'Verma Design Atelier', 'architect', 'Platinum', 6, 'priya'], ['p5', 'Er. Sandeep Tiwari', 'Tiwari Builders', 'contractor', 'Silver', 3, 'rahul'], ['p6', 'Arjun Khanna', 'Khanna Estates', 'agent', 'Silver', 2, 'ankit']] as const;
const STAGE_NAME: Record<string, string> = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', visit: 'Visit / Meeting', proposal: 'Proposal sent', negotiation: 'Negotiation', won: 'Won', nurture: 'Nurture', lost: 'Lost' };
const SRC: Record<string, string> = { architect: 'Architect / Interior planner', contractor: 'Civil engineer / Contractor', agent: 'Real estate agent', walkin: 'Showroom walk-in', field: 'Field sales', online: 'Online', referral: 'Client referral' };
type L = { id: string; name: string; phone: string; source: string; sub?: string; ref?: string; refName?: string; showroom?: string; stage: string; owner: string; value: number; interest: string; area: string; fu: number | null; lastIn: number | null; created: number; lostReason?: string; reply?: string; msgs?: [string, string, number, string?][] };
const LEADS: L[] = [
  { id: 'L01', name: 'Aarav Mehta', phone: '+91 98271 22014', source: 'architect', ref: 'p1', stage: 'visit', owner: 'priya', value: 680000, interest: 'Modular kitchen + wardrobes', area: 'Avanti Vihar', fu: 0, lastIn: 90, created: 6, msgs: [
    ['auto', 'Hello Aarav, thank you for your interest in Make My Space. Ar. Neha Agrawal shared your details. Your consultant Priya will call you today.', 6 * 1440, 'welcome_partner'],
    ['us', 'Hi Aarav, Priya here. Sharing 3 kitchen layouts for your Avanti Vihar flat. Would Saturday 11 am work for a showroom visit?', 5 * 1440],
    ['them', 'Saturday works. Can we see the walnut and sage shutter finishes in person?', 2 * 1440], ['us', 'Yes, both are on display at Shankar Nagar. See you Saturday.', 2 * 1440 - 20],
    ['them', 'Also please include a quote for the master bedroom wardrobe.', 90]] },
  { id: 'L02', name: 'Kavya Sharma', phone: '+91 99070 51833', source: 'walkin', showroom: 'Shankar Nagar', stage: 'new', owner: 'ankit', value: 350000, interest: 'Modular kitchen', area: 'Shankar Nagar', fu: 0, lastIn: 30, created: 0.03, msgs: [
    ['auto', 'Hello Kavya, thank you for visiting our Shankar Nagar showroom today. Here is the modular kitchen catalogue you asked for.', 35, 'walkin_thanks'], ['them', 'Thank you. What is the starting price for an L-shaped kitchen?', 30]] },
  { id: 'L03', name: 'Rajesh Agrawal', phone: '+91 94252 60718', source: 'contractor', ref: 'p2', stage: 'proposal', owner: 'rahul', value: 1250000, interest: 'Full home interiors, 4 BHK', area: 'Kamal Vihar', fu: -2, lastIn: 3000, created: 20 },
  { id: 'L04', name: 'Sneha Patel', phone: '+91 70003 41926', source: 'online', sub: 'Instagram ad', stage: 'contacted', owner: 'priya', value: 420000, interest: 'Wardrobes', area: 'Telibandha', fu: 1, lastIn: 300, created: 3, reply: 'Do you have sliding wardrobes with a mirror finish?' },
  { id: 'L05', name: 'Manoj Verma', phone: '+91 98930 77451', source: 'agent', ref: 'p3', stage: 'qualified', owner: 'ankit', value: 900000, interest: '3 BHK interiors', area: 'Saddu', fu: -1, lastIn: 2000, created: 9 },
  { id: 'L07', name: 'Deepak Sinha', phone: '+91 97541 33012', source: 'field', sub: 'Site visit', stage: 'won', owner: 'rahul', value: 780000, interest: 'Full home interiors', area: 'Mowa', fu: null, lastIn: 4320, created: 58 },
  { id: 'L06', name: 'Ishita Gupta', phone: '+91 88171 20945', source: 'referral', ref: 'L07', refName: 'Deepak Sinha', stage: 'new', owner: 'rahul', value: 550000, interest: 'Kitchen + TV unit', area: 'Devendra Nagar', fu: 0, lastIn: 15, created: 0.1, msgs: [['them', 'Hi, Deepak Sinha gave me your number. He is very happy with his kitchen. I am looking for something similar.', 15]] },
  { id: 'L08', name: 'Neelam Chandrakar', phone: '+91 99261 84570', source: 'architect', ref: 'p4', stage: 'negotiation', owner: 'priya', value: 1600000, interest: 'Villa interiors', area: 'Labhandi', fu: 2, lastIn: 600, created: 24, reply: 'Can you match the earlier quote if we add the puja unit?' },
  { id: 'L09', name: 'Harsh Dewangan', phone: '+91 62650 19873', source: 'online', sub: 'Website', stage: 'new', owner: 'ankit', value: 300000, interest: 'Wardrobes', area: 'Tatibandh', fu: 0, lastIn: 5, created: 0.01, msgs: [['them', 'Hi, I filled the form on your website. I need wardrobes for 2 bedrooms.', 5]] },
  { id: 'L10', name: 'Pooja Sahu', phone: '+91 70240 66381', source: 'walkin', showroom: 'VIP Road', stage: 'visit', owner: 'ankit', value: 460000, interest: 'Modular kitchen', area: 'VIP Road', fu: 1, lastIn: 1500, created: 5 },
  { id: 'L11', name: 'Amit Tiwari', phone: '+91 94060 11297', source: 'contractor', ref: 'p5', stage: 'contacted', owner: 'rahul', value: 720000, interest: 'Kitchen + wardrobes', area: 'Amlidih', fu: -3, lastIn: 6000, created: 12 },
  { id: 'L12', name: 'Ritu Jain', phone: '+91 98264 50310', source: 'field', sub: 'Exhibition', stage: 'qualified', owner: 'priya', value: 380000, interest: 'Wardrobes + study', area: 'Pandri', fu: 3, lastIn: null, created: 7 },
  { id: 'L13', name: 'Siddharth Rao', phone: '+91 99935 72214', source: 'online', sub: 'Meta lead form', stage: 'nurture', owner: 'ankit', value: 500000, interest: 'Modular kitchen', area: 'Bhatagaon', fu: 30, lastIn: 20000, created: 40 },
  { id: 'L14', name: 'Anjali Thakur', phone: '+91 70007 13652', source: 'agent', ref: 'p3', stage: 'lost', owner: 'rahul', value: 400000, interest: '2 BHK interiors', area: 'Daldal Seoni', fu: null, lastIn: 15000, created: 35, lostReason: 'Budget' },
  { id: 'L15', name: 'Vivek Soni', phone: '+91 98278 90116', source: 'architect', ref: 'p1', stage: 'won', owner: 'priya', value: 1100000, interest: 'Full home interiors', area: 'Civil Lines', fu: null, lastIn: 2880, created: 46 },
  { id: 'L16', name: 'Megha Pandey', phone: '+91 89894 32705', source: 'referral', ref: 'L15', refName: 'Vivek Soni', stage: 'contacted', owner: 'priya', value: 600000, interest: 'Kitchen + wardrobes', area: 'Shailendra Nagar', fu: 0, lastIn: 200, created: 4, reply: 'Vivek suggested your team. When can someone visit the site?' },
  { id: 'L17', name: 'Kunal Bhatia', phone: '+91 93009 25481', source: 'walkin', showroom: 'Shankar Nagar', stage: 'proposal', owner: 'rahul', value: 820000, interest: 'Kitchen + living room', area: 'Fafadih', fu: 1, lastIn: 1400, created: 10 },
  { id: 'L18', name: 'Tanvi Mishra', phone: '+91 97700 48219', source: 'online', sub: 'Google search', stage: 'qualified', owner: 'ankit', value: 450000, interest: 'Modular kitchen', area: 'Mowa', fu: -1, lastIn: 4000, created: 8 }];

async function seedCrm(q: Q, now: number) {
  for (const [id, name, firm, type, tier, rate, owner] of PARTNERS) await q.query('insert into partners(id, name, firm, type, tier, rate, owner_id) values ($1,$2,$3,$4,$5,$6,$7)', [id, name, firm, type, tier, rate, owner]);
  const partnerName = Object.fromEntries(PARTNERS.map(p => [p[0], p[1]]));
  const ownerName: Record<string, string> = { ankit: 'Ankit', priya: 'Priya', rahul: 'Rahul' };
  for (const o of LEADS) {
    const created = new Date(now - o.created * DAY);
    const isPartner = ['architect', 'contractor', 'agent'].includes(o.source);
    await q.query(`insert into leads(id, name, phone, source, sub, ref_partner_id, ref_lead_id, showroom, stage, owner_id, value, interest, area, follow_up, last_inbound_at, lost_reason, created_at, stage_changed_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
      [o.id, o.name, normPhone(o.phone), o.source, o.sub || '', isPartner ? o.ref : null, o.source === 'referral' ? o.ref : null, o.showroom || '', o.stage, o.owner, o.value, o.interest, o.area,
       o.fu === null ? null : addDays(o.fu), o.lastIn === null ? null : new Date(now - o.lastIn * 60000), o.lostReason || '', created]);
    const by = isPartner ? partnerName[o.ref!] : o.refName;
    await q.query('insert into lead_timeline(lead_id, text, created_at) values ($1,$2,$3)', [o.id, `Lead created · ${SRC[o.source]}${by ? ' · referred by ' + by : ''}${o.showroom ? ' · ' + o.showroom + ' showroom' : ''}`, created]);
    if (isPartner) await q.query('insert into lead_timeline(lead_id, text, auto, created_at) values ($1,$2,true,$3)', [o.id, `${by} thanked on WhatsApp`, new Date(created.getTime() + 60000)]);
    if (o.stage !== 'new') await q.query('insert into lead_timeline(lead_id, text, created_at) values ($1,$2,$3)', [o.id, `Moved to ${STAGE_NAME[o.stage]}`, new Date(created.getTime() + DAY / 2)]);
    const first = o.name.split(' ')[0];
    const msgs = o.msgs || [
      ['auto', `Hello ${first}, thank you for your interest in Make My Space. Your consultant ${ownerName[o.owner]} will call you shortly. Our kitchen and wardrobe catalogue is attached.`, o.created * 1440 - 3, 'welcome_catalogue'],
      ...(o.created > 1 ? [['us', `Hi ${first}, ${ownerName[o.owner]} here. Could you share your floor plan so we can prepare a layout for your ${o.interest.toLowerCase()}?`, o.created * 1440 - 200] as [string, string, number]] : []),
      ...(o.lastIn !== null ? [['them', o.reply || `Sent the plan. What would the budget look like for ${o.interest.toLowerCase()}?`, o.lastIn] as [string, string, number]] : [])] as [string, string, number, string?][];
    for (const [from, text, m, tpl] of msgs) await q.query(`insert into lead_messages(lead_id, from_kind, text, tpl, status, created_at) values ($1,$2,$3,$4,'delivered',$5)`, [o.id, from, text, tpl || null, new Date(now - m * 60000)]);
  }
}

function rectWalls(w: number, d: number) {
  return [{ label: 'A', w, obs: [['Door', 150, 0, 900, 2100]] }, { label: 'B', w: d, obs: [['Switchboard', 300, 1200, 150, 100]] }, { label: 'C', w: w + 6, obs: [['Window', Math.round(w / 2 - 600), 900, 1200, 1200]] }, { label: 'D', w: d - 4, obs: [] }] as { label: string; w: number; obs: [string, number, number, number, number][] }[];
}

async function seedOps(q: Q, now: number) {
  const P = [
    { id: 'P101', code: 'P-101', lead: 'L15', name: 'Vivek Soni', phone: '+91 98278 90116', address: 'Civil Lines, Raipur', value: 1100000, created: 40, target: 18, siteReady: true, paid: [true, true, false, false], survey: 'submitted', notes: 'Customer prefers morning installation slots. Lift available, park in basement B1.',
      rooms: [['Master Bedroom', 'MBR', 4200, 3600], ['Bedroom 2', 'BR2', 3600, 3300], ['Bedroom 3', 'BR3', 3300, 3000], ['Kids Room', 'KID', 3300, 3000], ['Guest Room', 'GBR', 3000, 3000], ['Living', 'LIV', 5400, 4200], ['Kitchen', 'KIT', 3200, 2100], ['Bath 1', 'BT1', 2400, 1800], ['Bath 2', 'BT2', 2200, 1600], ['Bath 3', 'BT3', 2200, 1600], ['Bath 4', 'BT4', 2000, 1500], ['Bath 5', 'BT5', 2000, 1500]] },
    { id: 'P102', code: 'P-102', lead: 'L07', name: 'Deepak Sinha', phone: '+91 97541 33012', address: 'Mowa, Raipur', value: 780000, created: 56, target: -1, siteReady: true, paid: [true, true, true, false], survey: 'submitted', notes: '',
      rooms: [['Kitchen', 'KIT', 3000, 2400], ['Master Bedroom', 'MBR', 4000, 3500], ['Bedroom 2', 'BR2', 3400, 3200], ['Living', 'LIV', 5000, 4000], ['Dining', 'DIN', 3600, 3000]] },
    { id: 'P103', code: 'P-103', lead: null, name: 'Rakesh Sharma', phone: '+91 98261 44720', address: 'Vedanta City, Raipur', value: 950000, created: 2, target: 45, siteReady: false, paid: [true, false, false, false], survey: 'scheduled', notes: 'G+1 duplex. Ask for the architect’s furniture layout PDF at site.', rooms: [] }
  ] as const;
  const projCreated: Record<string, number> = {};
  for (const p of P) {
    const created = now - p.created * DAY; projCreated[p.id] = created;
    const c = await one(q, 'insert into customers(name, phone) values ($1,$2) returning id', [p.name, normPhone(p.phone)]);
    await q.query('insert into projects(id, code, lead_id, customer_id, pm_id, address, value, target, site_ready, notes, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [p.id, p.code, p.lead, c!.id, 'vikram', p.address, p.value, addDays(p.target), p.siteReady, p.notes, new Date(created)]);
    let i = 0; for (const [label, pct, gate] of DEFAULT_PAYMENTS) { await q.query('insert into payment_milestones(project_id, label, pct, amount, gate, received_at, received_by, sort) values ($1,$2,$3,$4,$5,$6,$7,$8)', [p.id, label, pct, Math.round(p.value * pct / 100), gate, p.paid[i] ? new Date(created + (i + 1) * DAY) : null, p.paid[i] ? 'vikram' : null, i]); i++; }
    const today1130 = (() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 6, 0)); })();
    await q.query('insert into surveys(project_id, status, assignee_id, scheduled_at, check_in_at, submitted_at, minutes) values ($1,$2,$3,$4,$5,$6,$7)',
      [p.id, p.survey, 'sana', p.survey === 'submitted' ? new Date(created + 4 * DAY) : today1130, p.survey === 'submitted' ? new Date(created + 4 * DAY) : null, p.survey === 'submitted' ? new Date(created + 4 * DAY + 2.2 * HR) : null, p.survey === 'submitted' ? (p.id === 'P101' ? 132 : 88) : null]);
    let sort = 0;
    for (const [name, code, w, d] of p.rooms) {
      const rid = `R-${p.id}-${code}`;
      await q.query('insert into rooms(id, project_id, name, code, ceiling, floor, shape, sort) values ($1,$2,$3,$4,2900,$5,$6,$7)', [rid, p.id, name, code, 'Tiled, finished', 'rect', sort++]);
      for (const wall of rectWalls(w, d)) {
        const wr = await one(q, 'insert into walls(room_id, label, w, h, photo) values ($1,$2,$3,2900,$4) returning id', [rid, wall.label, wall.w, 'sample']);
        for (const [type, left, floor, ow, oh] of wall.obs) await q.query('insert into wall_obstructions(wall_id, type, left_mm, floor_mm, w, h) values ($1,$2,$3,$4,$5,$6)', [wr!.id, type, left, floor, ow, oh]);
      }
    }
    await q.query('insert into project_activity(project_id, text, created_at) values ($1,$2,$3)', [p.id, p.lead ? 'Project created from CRM lead (won)' : 'Project created by Vikram (direct order)', new Date(created)]);
    if (p.survey === 'submitted') await q.query('insert into project_activity(project_id, text, created_at) values ($1,$2,$3)', [p.id, `Site survey submitted by Sana · ${p.rooms.length} rooms, ${p.rooms.length * 4} walls`, new Date(created + 4 * DAY)]);
  }

  let iseq = 1, tseq = 1;
  const task = async (t: { title: string; p?: string; i?: string; to: string; by?: string; due: number; status?: string; blocked?: string; auto?: boolean; urgent?: boolean; proof?: string; repeat?: string; ago?: number; rem?: number; events?: [string, string, string | null, string | null, number][] }) => {
    const id = 'T' + tseq++, created = new Date(now - (t.ago ?? 1) * DAY);
    await q.query(`insert into tasks(id, title, project_id, item_id, assignee_id, assigner_id, deadline, priority, status, blocked_reason, auto, proof, repeat, reminders, created_at, done_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, t.title, t.p || null, t.i || null, t.to, t.by || 'vikram', addDays(t.due), t.urgent ? 'urgent' : 'normal', t.status || 'todo', t.blocked || '', !!t.auto, t.proof || '', t.repeat || '', t.rem || 0, created, t.status === 'done' ? new Date(created.getTime() + DAY) : null]);
    const ev = t.events || [['assigned', t.by || 'vikram', t.to, null, 0], ['seen', t.to, null, null, 2 * HR],
      ...(t.status === 'progress' || t.status === 'done' ? [['started', t.to, null, null, 3 * HR]] : []), ...(t.status === 'blocked' ? [['blocked', t.to, null, t.blocked, (now - created.getTime()) - DAY]] : []),
      ...(t.status === 'done' ? [['done', t.to, null, null, DAY]] : [])] as [string, string, string | null, string | null, number][];
    for (const [e, by, to, note, off] of ev) await q.query('insert into task_events(task_id, e, by_id, to_id, note, created_at) values ($1,$2,$3,$4,$5,$6)', [id, e, by, to, note, new Date(created.getTime() + off)]);
    for (let r = 0; r < (t.rem || 0); r++) await q.query(`insert into task_events(task_id, e, by_id, created_at) values ($1, 'reminded', 'system', $2)`, [id, new Date(now - (r + 1) * DAY + HR)]);
  };

  const item = async (pid: string, rc: string, type: string, wall: string, stage: string, x: { installer?: string; designer?: string; target: number; due?: number; desc?: string; drawn?: boolean; hwPI?: boolean; prodPI?: boolean; dispatched?: boolean; delivered?: boolean; gotAll?: boolean; f?: number; sessions?: [number, number | null, string][]; snags?: [string, string, string, string][]; tstatus?: string }) => {
    const id = 'I' + iseq++, k = stageIdx(stage), pc = projCreated[pid], span = (now - pc) / (k + 1.6);
    const rn = (await one(q, 'select name from rooms where id = $1', [`R-${pid}-${rc}`]))?.name || rc;
    const code = `${rc}-${type}-01`, designer = x.designer || 'deepa', std = ITEM_TYPES.find(t => t.id === type)!.std, f = x.f || 1.1;
    const logIn = (i: number) => pc + i * span;
    const instAt = logIn(5);
    const owner = stage === 'install' ? x.installer : stage === 'drawing' ? designer : stage === 'handover' ? 'vikram' : ({ pi: 'manish', order: 'manish', dispatch: 'kiran' } as Record<string, string>)[stage] || null;
    await q.query(`insert into items(id, code, project_id, room_code, room_name, type, wall, descr, stage, owner_id, designer_id, installer_id, target, hw_pi, prod_pi, po, dispatch_vehicle, dispatch_boxes, dispatch_date, delivered, install_done, signed_off, after_photo, installed_at, checklist, created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [id, code, pid, rc, rn, type, wall, x.desc || '', stage, owner, designer, x.installer || null, addDays(x.target), k > 2 || !!x.hwPI, k > 2 || !!x.prodPI, k > 3 ? 'PO-' + (2400 + iseq) : '',
       k > 4 || x.dispatched ? 'CG04 MK ' + (2200 + iseq) : null, k > 4 || x.dispatched ? (BOXES[type] || BOXES.OT).length : null, k > 4 || x.dispatched ? new Date(logIn(Math.min(4, k)) + DAY).toISOString().slice(0, 10) : null,
       k > 4 || !!x.delivered, k > 5, k > 5, k > 5 ? 'sample' : null, k > 5 ? new Date(instAt + DAY + 6 * HR) : null, k > 5 ? Object.fromEntries(CHECKLIST.map(c => [c, true])) : {}, new Date(pc + 4 * DAY)]);
    if (k >= 2 || x.drawn) await q.query('update items set spec = $2 where id = $1', [id, JSON.stringify(SAMPLE_SPEC[type] || SAMPLE_SPEC.OT)]);
    if (k > 2) await q.query(`update items set prod_pi_no = $2, prod_pi_amount = $3 where id = $1`, [id, 'FPI-' + (5100 + iseq), 18000 + iseq * 2500]);
    if (k > 3) await q.query(`update items set hw_vendor = 'Hettich (Raipur dealer)', hw_received = true, production_done = true where id = $1`, [id]);
    for (let i = 0; i <= k; i++) {
      const st = STAGES[i].id;
      const by = i < k ? (st === 'install' ? x.installer : st === 'survey' ? 'sana' : st === 'drawing' ? designer : st === 'handover' ? 'vikram' : ({ pi: 'manish', order: 'manish', dispatch: 'kiran' } as Record<string, string>)[st]) : null;
      await q.query('insert into item_stage_log(item_id, stage, in_at, out_at, by_id) values ($1,$2,$3,$4,$5)', [id, st, new Date(logIn(i)), i < k ? new Date(logIn(i + 1)) : null, by || null]);
    }
    if (k >= 2) { await q.query(`insert into documents(item_id, kind, rev, by_id, created_at) values ($1,'drawing','R0',$2,$3)`, [id, designer, new Date(logIn(1) + DAY)]); await q.query(`insert into documents(item_id, kind, rev, by_id, created_at, approved_at, approved_via) values ($1,'drawing','R1',$2,$3,$4,'whatsapp')`, [id, designer, new Date(logIn(1) + 2 * DAY), new Date(logIn(1) + 2.5 * DAY)]); }
    else if (x.drawn) await q.query(`insert into documents(item_id, kind, rev, by_id, created_at) values ($1,'drawing','R0',$2,$3)`, [id, designer, new Date(now - 2 * DAY)]);
    let n = 1; for (const label of BOXES[type] || BOXES.OT) await q.query('insert into item_boxes(item_id, n, label, got) values ($1,$2,$3,$4)', [id, n++, label, k > 5 || x.gotAll ? true : null]);
    const sessions = x.sessions ? x.sessions.map(([a, b, r]) => [now - a * HR, b === null ? null : now - b * HR, r] as const)
      : k > 5 ? [[instAt + 2 * HR, instAt + 2 * HR + std * f * 0.55 * HR, 'End of day'], [instAt + DAY + HR, instAt + DAY + HR + std * f * 0.45 * HR, '']] as const : [];
    for (const [s, e, r] of sessions) await q.query('insert into work_sessions(item_id, start_at, end_at, reason, by_id) values ($1,$2,$3,$4,$5)', [id, new Date(s), e === null ? null : new Date(e), r, x.installer || null]);
    for (const [part, t2, note, status] of x.snags || []) await q.query('insert into snags(id, item_id, part, type, note, status, raised_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)', ['S' + id, id, part, t2, note, status, x.installer, new Date(now - 26 * HR)]);
    if (stage !== 'closed') await task({ title: stageTaskTitle(stage, code), p: pid, i: id, to: owner || 'vikram', by: 'vikram', due: x.due ?? 2, auto: true, status: x.tstatus, ago: (now - logIn(k)) / DAY, rem: (x.due ?? 0) < 0 ? -(x.due as number) : 0, proof: stageProof(stage) });
    return id;
  };
  // P-101 · Vivek Soni · 5 wardrobes, 3 TV units, 5 vanities, 1 kitchen
  await item('P101', 'MBR', 'WR', 'B', 'install', { installer: 'ravi', target: 1, due: 1, tstatus: 'progress', desc: 'Sliding wardrobe 2400 mm, lacquered glass', gotAll: true, sessions: [[26, 20.5, 'End of day'], [2.2, null, '']] });
  await item('P101', 'BR2', 'WR', 'B', 'install', { installer: 'ravi', target: 3, due: 3, desc: 'Hinged wardrobe 1800 mm with loft' });
  await item('P101', 'BR3', 'WR', 'C', 'dispatch', { installer: 'ravi', target: 8, due: 2, dispatched: true, desc: 'Hinged wardrobe 1800 mm' });
  await item('P101', 'KID', 'WR', 'B', 'dispatch', { installer: 'suresh', target: 9, due: -1, desc: 'Wardrobe with study ledge' });
  await item('P101', 'GBR', 'WR', 'A', 'drawing', { drawn: true, designer: 'arjun', target: 16, due: -2, desc: 'Hinged wardrobe 1500 mm' });
  await item('P101', 'LIV', 'TV', 'C', 'order', { target: 12, due: 0, desc: 'Wall-mounted TV unit 2700 mm with back panel' });
  await item('P101', 'MBR', 'TV', 'D', 'pi', { hwPI: true, target: 14, due: 1, desc: 'TV unit 1800 mm' });
  await item('P101', 'BR2', 'TV', 'D', 'handover', { installer: 'ravi', target: -1, due: 1, f: 0.9, desc: 'TV unit 1500 mm' });
  await item('P101', 'BT1', 'VN', 'A', 'dispatch', { installer: 'suresh', target: 6, due: 3, dispatched: true, delivered: true, desc: 'Wall-hung vanity 900 mm' });
  await item('P101', 'BT2', 'VN', 'A', 'dispatch', { installer: 'suresh', target: 6, due: 3, dispatched: true, desc: 'Wall-hung vanity 750 mm' });
  await item('P101', 'BT3', 'VN', 'A', 'pi', { prodPI: true, target: 11, due: 0, desc: 'Vanity 750 mm' });
  await item('P101', 'BT4', 'VN', 'A', 'pi', { target: 11, due: 2, desc: 'Vanity 600 mm' });
  await item('P101', 'BT5', 'VN', 'A', 'drawing', { drawn: true, target: 15, due: 1, desc: 'Vanity 600 mm with mirror cabinet' });
  await item('P101', 'KIT', 'KT', 'A', 'install', { installer: 'suresh', target: 0, due: 0, tstatus: 'progress', gotAll: true, desc: 'L-shaped kitchen 3200 + 2100 mm, acrylic shutters', sessions: [[50, 43, 'End of day'], [26, 20, 'Material short']], snags: [['Tall unit shutter', 'Damaged', 'Corner chipped in transit', 'reordered']] });
  // P-102 · Deepak Sinha
  await item('P102', 'KIT', 'KT', 'A', 'closed', { installer: 'suresh', target: -12, f: 1.25, desc: 'Parallel kitchen' });
  await item('P102', 'MBR', 'WR', 'B', 'closed', { installer: 'ravi', target: -9, f: 1.0, desc: 'Sliding wardrobe 2700 mm' });
  await item('P102', 'BR2', 'WR', 'B', 'closed', { installer: 'ravi', target: -8, f: 0.95, desc: 'Hinged wardrobe 1800 mm' });
  await item('P102', 'LIV', 'TV', 'C', 'handover', { installer: 'ravi', target: -1, due: 0, f: 1.2, desc: 'TV unit 2400 mm' });
  await item('P102', 'DIN', 'CU', 'D', 'handover', { installer: 'suresh', target: -1, due: -1, f: 1.4, desc: 'Crockery unit with glass shutters' });
  // P-103 survey today + general tasks
  await task({ title: 'Site survey · Rakesh Sharma, Vedanta City', p: 'P103', to: 'sana', due: 0, auto: true, ago: 2 });
  await task({ title: 'Collect before-dispatch payment (40%) · Vivek Soni', p: 'P101', to: 'vikram', by: 'owner', due: -1, urgent: true, rem: 1, ago: 4 });
  await task({ title: 'Get customer sign-off on guest-room wardrobe finish', p: 'P101', to: 'arjun', due: -2, status: 'blocked', blocked: 'Waiting for customer', ago: 5 });
  await task({ title: 'Weekly vendor payment review', to: 'manish', by: 'owner', due: 0, repeat: 'weekly', ago: 6 });
  await task({ title: 'Update showroom display shutters (walnut, sage)', to: 'priya', by: 'owner', due: 4, ago: 1 });
  await task({ title: 'Confirm painting is complete before kitchen dispatch', p: 'P103', to: 'vikram', by: 'owner', due: 6, ago: 1 });
  await task({ title: 'Re-measure kitchen window, Mowa', p: 'P102', to: 'deepa', due: -30, status: 'done', ago: 50, events: [['assigned', 'vikram', 'arjun', null, 0], ['seen', 'arjun', null, null, HR], ['handover', 'arjun', 'deepa', 'Arjun on leave this week', DAY], ['started', 'deepa', null, null, DAY + 2 * HR], ['done', 'deepa', null, null, 2 * DAY]] });
  await task({ title: 'Share hardware price list with purchase', to: 'manish', due: -6, status: 'done', ago: 9 });
  await task({ title: 'Book site survey · Rakesh Sharma', p: 'P103', to: 'vikram', by: 'owner', due: -1, status: 'done', ago: 2 });
  await q.query(`select setval('item_seq', $1, false)`, [iseq]); await q.query(`select setval('task_seq', $1, false)`, [tseq]); await q.query(`select setval('project_seq', 104, false)`);
}

export async function seedDemo(q: Q) {
  const now = Date.now();
  for (const [i, [id, name, role, title]] of USERS.entries())
    await q.query('insert into users(id, name, phone, role, title, members, skills) values ($1,$2,$3,$4,$5,$6,$7)', [id, name, demoPhone(i), role, title, CREW[id]?.members || [], CREW[id]?.skills || []]);
  await seedCrm(q, now);
  await seedOps(q, now);
  await q.query(`insert into commissions(lead_id, partner_id, amount, status) select l.id, p.id, round(l.value * p.rate / 100), 'pending' from leads l join partners p on p.id = l.ref_partner_id where l.stage = 'won' and not exists (select 1 from commissions c where c.lead_id = l.id)`);
  // v1.5: warranty on handed-over pieces, receipts for milestones already received, one sample quotation and service request
  await q.query(`update items set warranty_until = (installed_at::date + interval '10 years')::date where stage = 'closed' and installed_at is not null`);
  await q.query(`update items set warranty_until = (current_date + interval '10 years')::date - 20 where stage = 'closed' and warranty_until is null`);
  const rec = await q.query(`select m.id, m.project_id, m.amount, m.received_at from payment_milestones m where m.received_at is not null and m.amount > 0 order by m.project_id, m.sort`);
  for (const [i, m] of rec.rows.entries())
    await q.query(`insert into payment_receipts(project_id, milestone_id, receipt_no, amount, paid_on, mode, reference, by_id) values ($1,$2,$3,$4,$5::date,$6,$7,'owner')`,
      [m.project_id, m.id, `RCPT/DEMO/${String(i + 1).padStart(4, '0')}`, m.amount, m.received_at, i % 2 ? 'Bank transfer' : 'UPI', i % 2 ? 'NEFT' + (40211 + i) : 'UPI' + (900311 + i)]);
  const ql = await q.query(`select id, value from leads where stage in ('proposal','negotiation') order by created_at limit 1`);
  if (ql.rows[0]) {
    const v = Math.round(ql.rows[0].value / 1.18 / 1000) * 1000;
    const lines = [{ room: 'Kitchen', item: 'Base and wall units', desc: 'BWP ply carcass, acrylic shutters', size: '3200 × 600', qty: 1, unit: 'set', rate: Math.round(v * 0.6) }, { room: 'Master bedroom', item: 'Sliding wardrobe', desc: 'HDHMR, laminate finish', size: '2400 × 2100', qty: 1, unit: 'nos', rate: v - Math.round(v * 0.6) }];
    await q.query(`insert into quotes(lead_id, rev, lines, discount, gst_pct, subtotal, total, status, by_id) values ($1, 0, $2, 0, 18, $3, $4, 'sent', 'priya')`, [ql.rows[0].id, JSON.stringify(lines), v, Math.round(v * 1.18)]);
  }
  const cl = await q.query(`select i.id, i.project_id from items i where i.stage = 'closed' limit 1`);
  if (cl.rows[0]) {
    const t = await q.query(`insert into service_requests(project_id, item_id, text, under_warranty, raised_by, ticket_no, category, priority, happy_code, due_at)
      values ($1,$2,'Drawer in the tall unit is not closing smoothly', true, 'customer app', 'SR-' || to_char(now(), 'YYMM') || '-' || lpad(nextval('ticket_seq')::text, 4, '0'), 'hardware', 'normal', '4821', now() + interval '30 hours') returning id`, [cl.rows[0].project_id, cl.rows[0].id]);
    await q.query(`insert into service_events(ticket_id, status, text, by_name) values ($1, 'open', 'Complaint registered from the customer app', 'customer app')`, [t.rows[0].id]);
  }
  // scope of work: what was sold. Submitted projects get one line per item; P-103 is waiting for its survey.
  const its = await many(q, `select i.id, i.project_id, i.room_code, i.room_name, i.type, i.descr from items i order by i.project_id, i.id`);
  let ss = 0;
  for (const it of its) {
    const val = ({ KT: 260000, WR: 95000, TV: 55000, VN: 28000, DR: 38000, ST: 42000, SR: 22000, CU: 48000, OT: 30000 } as Record<string, number>)[it.type] || 30000;
    await q.query(`insert into project_scope(project_id, room_name, room_code, type, descr, value, source, item_id, sort, created_by) values ($1,$2,$3,$4,$5,$6,'quote',$7,$8,'vikram')`, [it.project_id, it.room_name, it.room_code, it.type, it.descr || '', val, it.id, ++ss]);
    await q.query('update items set value = $2, scope_id = (select max(id) from project_scope) where id = $1', [it.id, val]);
  }
  for (const [room, code, type, descr, size, value] of [['Kitchen', 'KIT', 'KT', 'L-shape, acrylic shutters', '3.2 m + 2.1 m', 285000], ['Master Bedroom', 'MBR', 'WR', 'Sliding, 3 doors, with loft', '2400 × 2700', 135000], ['Master Bedroom', 'MBR', 'TV', 'Wall-mounted with back panel', '1800', 60000], ['Bedroom 2', 'BR2', 'WR', 'Hinged, 2 doors', '1800 × 2400', 85000], ['Bedroom 2', 'BR2', 'ST', 'Study table with overhead shelf', '1200', 42000], ['Living', 'LIV', 'TV', 'Floor unit with fluted panel', '2400', 75000]] as const)
    await q.query(`insert into project_scope(project_id, room_name, room_code, type, descr, size, value, source, sort, created_by) values ('P103',$1,$2,$3,$4,$5,$6,'manual',$7,'vikram')`, [room, code, type, descr, size, value, ++ss]);
}

/** Wipe all business data (keeps schema). Used by the demo reset and tests. */
export async function wipe(q: Q) {
  await q.query(`truncate audit_log, sessions, otp_requests, wa_messages, wa_contacts, webhook_events, meta_leads_raw, jobs, reminder_log, uploads,
    task_events, tasks, snags, work_sessions, item_boxes, documents, item_stage_log, project_scope, items, room_items, wall_obstructions, walls, rooms, surveys,
    project_activity, payment_milestones, projects, customers, commissions, lead_timeline, lead_messages, leads, partners, users restart identity cascade`);
  await q.query(`select setval('project_seq', 101, false)`); await q.query(`select setval('item_seq', 1, false)`); await q.query(`select setval('task_seq', 1, false)`);
  await q.query(`select setval('receipt_seq', 1, false)`); await q.query(`select setval('partner_seq', 100, false)`); await q.query('delete from invoice_seq'); await q.query(`select setval('ticket_seq', 1, false)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    await migrate();
    await tx(async q => { await bootstrap(q); if (process.argv.includes('--demo')) { await wipe(q); await seedDemo(q); await bootstrap(q); } });
    log.info('seed complete'); await pool.end();
  })().catch(e => { console.error(e); process.exit(1); });
}
