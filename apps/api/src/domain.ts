/* Business rules shared by every module. Ported 1:1 from the tested prototype. */

export const ROLES = [
  { id: 'admin', name: 'Owner / Admin' }, { id: 'ops_head', name: 'Operations head' }, { id: 'pm', name: 'Project coordinator' },
  { id: 'sales', name: 'Sales' }, { id: 'surveyor', name: 'Site surveyor' }, { id: 'designer', name: 'Designer' },
  { id: 'purchase', name: 'Purchase' }, { id: 'production', name: 'Production coordinator' }, { id: 'installer', name: 'Installer' },
  { id: 'guest', name: 'New member (no role yet)' }
] as const;
export type Role = typeof ROLES[number]['id'];
export const ROLE_IDS = ROLES.map(r => r.id) as [Role, ...Role[]];

export const PERMS = ['crm', 'ops', 'projects', 'money', 'edit', 'assign', 'override', 'payments', 'tasksAll', 'survey', 'install', 'team', 'people', 'admin'] as const;
export type Perm = typeof PERMS[number];
const P = (list: Perm[]) => Object.fromEntries(PERMS.map(k => [k, list.includes(k)])) as Record<Perm, boolean>;
export const DEFAULT_ROLES: Record<Role, Record<Perm, boolean>> = {
  admin: P([...PERMS]),
  ops_head: P(['crm', 'ops', 'projects', 'money', 'edit', 'assign', 'payments', 'tasksAll', 'survey', 'install', 'team', 'people']),
  pm: P(['ops', 'projects', 'money', 'edit', 'assign', 'payments', 'tasksAll', 'survey', 'install', 'team']),
  sales: P(['crm', 'projects', 'money']),
  surveyor: P(['survey', 'projects']),
  designer: P(['projects', 'edit']),
  purchase: P(['projects', 'edit']),
  production: P(['projects', 'edit']),
  installer: P(['install']),
  guest: P([])
};

/** Who may create an account. approval: anyone can ask, someone with 'people' approves. open: they join at once as defaultRole. closed: only admins add people. */
export const SIGNUP_DEFAULT = { mode: 'approval' as 'approval' | 'open' | 'closed', defaultRole: 'guest' as Role, domains: [] as string[] };

export const STAGES = [
  { id: 'survey', name: 'Site survey', short: 'Survey', owner: 'surveyor', days: 2 },
  { id: 'drawing', name: 'Production drawing and client approval', short: 'Drawing', owner: 'designer', days: 4 },
  { id: 'pi', name: 'Production PI (factory)', short: 'Factory PI', owner: 'purchase', days: 2 },
  { id: 'order', name: 'Hardware procurement and production', short: 'Hardware', owner: 'purchase', days: 10 },
  { id: 'dispatch', name: 'Dispatch and delivery', short: 'Dispatch', owner: 'production', days: 3 },
  { id: 'install', name: 'Installation', short: 'Install', owner: 'installer', days: 3 },
  { id: 'handover', name: 'Completion and handover', short: 'Handover', owner: 'pm', days: 2 },
  { id: 'closed', name: 'Completed', short: 'Done', owner: null, days: 0 }
] as const;
export type Stage = typeof STAGES[number]['id'];
export const STAGE_IDS = STAGES.map(s => s.id) as [Stage, ...Stage[]];
export const stageIdx = (s: string) => STAGES.findIndex(x => x.id === s);
export const stageById = Object.fromEntries(STAGES.map(s => [s.id, s])) as Record<Stage, typeof STAGES[number]>;
export const CUSTOMER_STAGE: Record<Stage, string> = { survey: 'Measurement', drawing: 'Design', pi: 'In production', order: 'In production', dispatch: 'On the way', install: 'Installing', handover: 'Installed', closed: 'Completed' };

export const ITEM_TYPES = [
  { id: 'WR', name: 'Wardrobe', std: 8 }, { id: 'TV', name: 'TV unit', std: 5 }, { id: 'VN', name: 'Vanity', std: 3 },
  { id: 'KT', name: 'Kitchen', std: 16 }, { id: 'DR', name: 'Dresser', std: 4 }, { id: 'ST', name: 'Study unit', std: 4 },
  { id: 'SR', name: 'Shoe rack', std: 2 }, { id: 'CU', name: 'Crockery unit', std: 5 }, { id: 'OT', name: 'Other', std: 4 }
] as const;
export const TYPE_IDS = ITEM_TYPES.map(t => t.id) as unknown as [string, ...string[]];
export const typeName = (id: string) => ITEM_TYPES.find(t => t.id === id)?.name || id;

export const BOXES: Record<string, string[]> = {
  WR: ['Carcass panels', 'Shutters (set 1)', 'Shutters (set 2)', 'Hardware kit', 'Profiles and handles', 'Accessories'],
  TV: ['Carcass panels', 'Shutters and back panel', 'Hardware kit'], VN: ['Vanity carcass', 'Shutters and hardware'],
  KT: ['Base carcass (1)', 'Base carcass (2)', 'Wall carcass (1)', 'Wall carcass (2)', 'Tall unit', 'Shutters (1)', 'Shutters (2)', 'Shutters (3)', 'Baskets and accessories', 'Skirting and fillers', 'Profiles and handles', 'Hardware kit'],
  DR: ['Carcass', 'Shutters and mirror', 'Hardware kit'], CU: ['Carcass', 'Glass shutters', 'Hardware kit'], ST: ['Carcass', 'Shutters', 'Hardware kit'],
  SR: ['Carcass and shutters'], OT: ['Panels', 'Hardware kit']
};
export const CHECKLIST = ['Shutters aligned', 'Handles and knobs fixed', 'Soft-close and channels working', 'Edges and gaps finished', 'Site cleaned, debris removed'];
export const SNAG_TYPES = ['Missing part', 'Damaged', 'Wrong size', 'Site issue'];
export const SNAG_FLOW = ['open', 'reordered', 'dispatched', 'fixed'] as const;
export const PAUSE_REASONS = ['Lunch / break', 'Material short', 'Site not ready', 'Customer request', 'End of day'];
export const BLOCK_REASONS = ['Waiting for customer', 'Waiting for material', 'Waiting for payment', 'Waiting for another team', 'Other'];
export const OBSTRUCTIONS = ['Window', 'Door', 'Switchboard', 'AC point', 'Plumbing / drain', 'Beam', 'Column', 'Gas pipe', 'Skirting'];
export const DEFAULT_PAYMENTS: [string, number, string][] = [['Advance (booking)', 10, ''], ['Before order', 40, 'order'], ['Before dispatch', 40, ''], ['On handover', 10, '']];

export function stageTaskTitle(stage: string, code: string) {
  const t: Record<string, string> = { survey: 'Site survey', drawing: `Production drawing · ${code}`, pi: `Raise production PI with factory · ${code}`, order: `Procure hardware, track production · ${code}`, dispatch: `Dispatch and deliver · ${code}`, install: `Install ${code}`, handover: `Handover and sign-off · ${code}` };
  return t[stage] || code;
}
export const stageProof = (stage: string) => stage === 'drawing' ? 'file' : stage === 'install' ? 'photo' : '';

/* ---------- gates ---------- */
export interface GateItem { stage: string; drawings: { approved: boolean; file?: boolean }[]; spec?: Record<string, string>; boxes?: number; prodPiNo?: string; productionDone?: boolean; hwReceived?: boolean; handoverDocs?: number; hwPI: boolean; prodPI: boolean; po: string; dispatch: unknown; delivered: boolean; installDone: boolean; signedOff: boolean; openSnags: number }
export interface GateProject { surveyStatus: string; siteReady: boolean; orderPayment?: { label: string; pct: number; received: boolean } }
export interface Gate { ok: boolean; text: string; hard: boolean }
export function gatesFor(it: GateItem, p: GateProject): Gate[] {
  const g: Gate[] = []; const add = (ok: unknown, text: string, hard: boolean) => g.push({ ok: !!ok, text, hard });
  const last = it.drawings[it.drawings.length - 1];
  switch (it.stage) {
    case 'survey': add(p.surveyStatus === 'submitted', 'Site survey submitted with every wall measured', false); break;
    case 'drawing': add(last && last.file !== false, 'Production drawing file uploaded (PDF or image)', true);
      add(specMissing(it.spec).length === 0, 'Material specification complete' + (specMissing(it.spec).length ? ` (missing: ${specMissing(it.spec).join(', ')})` : ''), true);
      add((it.boxes ?? 1) > 0, 'Packing list made', true); add(last && last.approved, 'Customer approved the latest drawing', true); break;
    case 'pi': add(it.prodPiNo || it.prodPI, 'Production PI raised with the factory (PI number)', true);
      add(p.orderPayment && p.orderPayment.received, `Payment received · ${p.orderPayment ? p.orderPayment.label + ' (' + p.orderPayment.pct + '%)' : 'before order'}`, true); break;
    case 'order': add(it.po, 'Hardware PO number entered', true); add(it.hwReceived, 'Hardware received', true); add(it.productionDone, 'Factory production complete', true); break;
    case 'dispatch': add(it.dispatch, 'Dispatch details entered (vehicle, boxes, date)', false); add(it.delivered, 'Material delivered at site', true); add(p.siteReady, 'Site ready: civil, electrical, painting, flooring done', true); break;
    case 'install': add(it.installDone, 'Installation completed with photos and checklist', true); add(!it.openSnags, 'No open snags', true); add(it.signedOff, 'Customer sign-off by WhatsApp OTP', true); break;
    case 'handover': add((it.handoverDocs ?? 0) > 0, 'Handover documents uploaded (warranty card, care guide, photos)', false); break;
  }
  return g;
}

/* ---------- CRM ---------- */
export const LEAD_STAGES = [
  { id: 'new', name: 'New', type: 'open' }, { id: 'contacted', name: 'Contacted', type: 'open' }, { id: 'qualified', name: 'Qualified', type: 'open' },
  { id: 'visit', name: 'Visit / Meeting', type: 'open' }, { id: 'proposal', name: 'Proposal sent', type: 'open' }, { id: 'negotiation', name: 'Negotiation', type: 'open' },
  { id: 'won', name: 'Won', type: 'won' }, { id: 'nurture', name: 'Nurture', type: 'nurture' }, { id: 'lost', name: 'Lost', type: 'lost' }
] as const;
export const LEAD_STAGE_IDS = LEAD_STAGES.map(s => s.id) as unknown as [string, ...string[]];
export const leadStageName = (id: string) => LEAD_STAGES.find(s => s.id === id)?.name || id;
export const SOURCES = [
  { id: 'architect', name: 'Architect / Interior planner', family: 'partner' }, { id: 'contractor', name: 'Civil engineer / Contractor', family: 'partner' },
  { id: 'agent', name: 'Real estate agent', family: 'partner' }, { id: 'walkin', name: 'Showroom walk-in', family: 'direct' },
  { id: 'field', name: 'Field sales', family: 'direct' }, { id: 'online', name: 'Online', family: 'direct' }, { id: 'referral', name: 'Client referral', family: 'referral' }
] as const;
export const SOURCE_IDS = SOURCES.map(s => s.id) as unknown as [string, ...string[]];
export const sourceOf = (id: string) => SOURCES.find(s => s.id === id)!;
export const LOST_REASONS = ['Budget', 'Timing', 'Bought elsewhere', 'Not reachable', 'Not interested'];

export const AUTOMATIONS = [
  ['a1', 'Every lead', 'Instant welcome', 'New lead from any source', 'Send welcome template with catalogue, assign by source rule', true],
  ['a2', 'Every lead', 'Missed-response alert', 'Client message unanswered 15 min in working hours', 'Notify owner and manager', true],
  ['a3', 'Every lead', 'Follow-up nudge', 'No reply from lead for 2 days', 'Send follow_up_gentle; after 5 more days move to Nurture', true],
  ['a4', 'Every lead', 'Visit reminder', '1 day and 2 hours before visit date', 'Send visit_reminder with location pin', true],
  ['a5', 'Every lead', 'Post-visit feedback', 'Stage moved to Visit / Meeting done', 'After 3 hours, send feedback buttons that move the stage', true],
  ['a6', 'Every lead', 'Quote follow-up', 'Stage moved to Proposal sent', 'After 2 days, create a call task for the owner', true],
  ['a7', 'Every lead', 'Won welcome', 'Stage moved to Won', 'Thank-you template, tag Customer, onboarding task', true],
  ['a8', 'Every lead', 'Lost win-back', '60 days after Lost for Budget or Timing', 'Re-engagement template, opted-in contacts only', false],
  ['a9', 'Every lead', 'Stale lead alert', 'Lead idle in an open stage for 7 days', 'Notify the lead owner', true],
  ['a10', 'Every lead', 'Greetings', 'Birthday or anniversary date reached', 'Greeting template, opted-in contacts only', false],
  ['a11', 'Partners', 'Partner lead received', 'New lead with a partner source', 'Thank the partner and name the consultant', true],
  ['a12', 'Partners', 'Partner progress updates', 'Partner lead reaches Visit, Proposal sent or Won', 'Utility template to the partner with the new status', true],
  ['a13', 'Partners', 'Commission on Won', 'Partner lead moves to Won', 'Create commission entry from partner rule, ask manager to approve', true],
  ['a14', 'Referrals', 'Referral thank-you', 'Referral lead created, and again on Won', 'Thank the referring client, create reward on Won', true],
  ['a15', 'Partners', 'Dormant partner nudge', 'Partner has sent no lead in 60 days', 'Task for the relationship owner to visit or call', true]
] as const;

/* WhatsApp templates the system uses (name -> category + body with {{n}} params + optional quick-reply buttons) */
export const WA_TEMPLATES: Record<string, { category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'; body: string; buttons?: string[] }> = {
  login_otp: { category: 'AUTHENTICATION', body: '{{1}} is your verification code.' },
  install_signoff_otp: { category: 'AUTHENTICATION', body: '{{1}} is your verification code.' },
  task_assigned: { category: 'UTILITY', body: 'Hello, a new task has been assigned to you in Make My Space by {{1}}. Task: {{2}}. Project: {{3}}. Please finish it by {{4}}. Tap Start when you begin, or Open to see the details.', buttons: ['Start', 'Open'] },
  task_reminder: { category: 'UTILITY', body: 'Reminder from Make My Space. Your task is {{1}}: {{2}}. Project: {{3}}. Tap Mark done once it is finished, or Blocked if something is stopping you.', buttons: ['Mark done', 'Blocked'] },
  task_escalation: { category: 'UTILITY', body: 'Escalation from Make My Space: {{1}} is now {{2}} days late on the task {{3}}. Please check with them and help them finish it today.', buttons: ['Open task', 'Nudge'] },
  task_blocked: { category: 'UTILITY', body: 'Update from Make My Space: {{1}} has marked the task "{{2}}" as blocked. Reason given: {{3}}. Please help them clear it.' },
  daily_digest: { category: 'UTILITY', body: 'Good morning {{1}}. You have {{2}} overdue and {{3}} due today. Open the app to see them.' },
  owner_day_summary: { category: 'UTILITY', body: 'Your Make My Space summary for today. Tasks completed: {{1}}. Tasks overdue: {{2}}. Furniture items moved to the next stage: {{3}}. New snags raised: {{4}}. Open the app for the full picture.' },
  project_welcome: { category: 'UTILITY', body: 'Hello {{1}}, welcome to Make My Space! Your project {{2}} is booked. Our surveyor will visit on {{3}} to measure every wall.' },
  survey_done: { category: 'UTILITY', body: 'Hello {{1}}, the site survey for {{2}} is complete. Your designer will share production drawings for approval soon.' },
  drawing_for_approval: { category: 'UTILITY', body: 'Hello {{1}}, the drawing {{2}} for your {{3}} is ready. Please review and approve.', buttons: ['Approve', 'Ask for a change'] },
  installation_scheduled: { category: 'UTILITY', body: 'Hello {{1}}, good news from Make My Space. The installation of your {{2}} is planned for {{3}}. Our installation team led by {{4}} will reach your site; you can call them on {{5}}. Please make sure the site is ready and accessible.' },
  handover_feedback: { category: 'UTILITY', body: 'Hello {{1}}, your Make My Space project {{2}} is complete. How would you rate us?', buttons: ['5 Excellent', '4 Good', '3 Okay'] },
  partner_update: { category: 'UTILITY', body: 'Hello {{1}}, an update on your referral {{2}}: now at {{3}}. Thank you for trusting Make My Space.' },
  staff_invite: { category: 'UTILITY', body: 'Hello {{1}}, your Make My Space team account is ready and your role is {{2}}. Open the Make My Space app and log in with this WhatsApp number to see your work.' },
  welcome_catalogue: { category: 'UTILITY', body: 'Hello {{1}}, thank you for your interest in Make My Space. Your consultant {{2}} will call you shortly. Our kitchen and wardrobe catalogue is attached.' },
  follow_up_gentle: { category: 'UTILITY', body: 'Hello {{1}}, just checking in on your {{2}} enquiry. Would you like an updated design, or shall we fix a showroom visit?' },
  visit_reminder: { category: 'UTILITY', body: 'Hello {{1}}, a reminder of your visit to our showroom. Reply 1 to confirm or 2 to reschedule.' },
  quote_followup: { category: 'UTILITY', body: 'Hello {{1}}, did you get a chance to review the itemised quote we sent? Happy to walk you through it on a call.' },
  festive_offer: { category: 'MARKETING', body: 'Hello {{1}}, complete home interiors in 45 days, with a 10-year warranty on modular kitchens and wardrobes. Reply YES to book a free consultation.' }
};
export function renderTemplate(name: string, params: string[]) {
  const t = WA_TEMPLATES[name];
  return t ? t.body.replace(/\{\{(\d+)\}\}/g, (_m, i) => params[Number(i) - 1] ?? '') : params.join(' ');
}

/* ---------- materials and documents ---------- */
/** Material specification the designer fills for every item; the first five are required before client approval. */
export const MATERIAL_FIELDS = [
  { id: 'size', label: 'Overall size W × H × D (mm)', req: true, hint: '2400 × 2400 × 600' },
  { id: 'carcass', label: 'Carcass board and thickness', req: true, hint: 'BWP plywood 18 mm / HDHMR 18 mm' },
  { id: 'shutter', label: 'Shutter board and thickness', req: true, hint: 'HDHMR 18 mm' },
  { id: 'finish', label: 'Shutter finish, brand and code', req: true, hint: 'Laminate 1 mm, Merino 22001 SUD' },
  { id: 'hardware', label: 'Hardware brand and range', req: true, hint: 'Hettich soft-close hinges and channels' },
  { id: 'inner', label: 'Inner laminate', req: false, hint: 'Frosty white 0.8 mm' },
  { id: 'edge', label: 'Edge banding', req: false, hint: '2 mm PVC, matching' },
  { id: 'back', label: 'Back panel', req: false, hint: '8 mm plywood' },
  { id: 'handles', label: 'Handles / profiles', req: false, hint: 'G-profile, black' },
  { id: 'accessories', label: 'Accessories', req: false, hint: 'Pull-out basket, loft, mirror' },
  { id: 'notes', label: 'Production notes', req: false, hint: 'Grain direction, special cuts' }
] as const;
export function specMissing(spec?: Record<string, string>) {
  return MATERIAL_FIELDS.filter(f => f.req && !String(spec?.[f.id] || '').trim()).map(f => f.label.split(/[ ,(]/)[0].toLowerCase());
}
/** Project document categories. `customer: true` ones are visible in the customer app. */
export const DOC_CATEGORIES = [
  { id: 'floor_plan', name: 'Final floor plan', customer: true },
  { id: 'furniture', name: 'Furniture drawings', customer: true },
  { id: 'production', name: 'Final production drawings with materials', customer: false },
  { id: 'quotation', name: 'Quotation / BOQ', customer: true },
  { id: 'pi', name: 'Factory PI', customer: false },
  { id: 'po', name: 'Hardware PO', customer: false },
  { id: 'handover', name: 'Handover: warranty card, care guide, photos', customer: true },
  { id: 'other', name: 'Other', customer: false }
] as const;
export const DOC_CATEGORY_IDS = DOC_CATEGORIES.map(c => c.id) as unknown as [string, ...string[]];

/* ---------- money, factory, service ---------- */
export const PAY_MODES = ['UPI', 'Bank transfer', 'Cheque', 'Cash', 'Card'] as const;
export const PRODUCTION_STEPS = [
  { id: 'cutting', name: 'Panel cutting' }, { id: 'edging', name: 'Edge banding' }, { id: 'drilling', name: 'Drilling and grooving' },
  { id: 'assembly', name: 'Assembly / dry fit' }, { id: 'packing', name: 'Packing and labelling' }
] as const;
export const SNAG_PAYERS = ['Company', 'Factory', 'Vendor', 'Customer'] as const;
export const COMPANY_DEFAULT = {
  name: 'Make My Space', legalName: '', gstin: '', address: 'Raipur, Chhattisgarh', phone: '+91 75838 37704', email: 'hello@makemyspace.in',
  website: 'makemyspace.in', bank: '', hsn: '9403', gstPct: 18, warrantyYears: 10, quoteValidityDays: 15,
  quoteTerms: '50% advance to start production. Balance before dispatch. Prices include installation. Civil, electrical and plumbing work are not included.'
};
/** Financial year label for invoice numbers, e.g. 2026-27 (April to March). */
export function fyLabel(d = new Date()) { const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; }
export function quoteTotals(lines: { qty: number; rate: number }[], discount: number, gstPct: number) {
  const subtotal = Math.round(lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0) * 100) / 100;
  const taxable = Math.max(0, subtotal - (Number(discount) || 0));
  const total = Math.round(taxable * (1 + (Number(gstPct) || 0) / 100));
  return { subtotal, taxable, total };
}
