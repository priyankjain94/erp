/* Business rules shared by every module. Ported 1:1 from the tested prototype. */
export const ROLES = [
    { id: 'admin', name: 'Owner / Admin' }, { id: 'ops_head', name: 'Operations head' }, { id: 'pm', name: 'Project coordinator' },
    { id: 'sales', name: 'Sales' }, { id: 'surveyor', name: 'Site surveyor' }, { id: 'designer', name: 'Designer' },
    { id: 'purchase', name: 'Purchase' }, { id: 'production', name: 'Production coordinator' }, { id: 'installer', name: 'Installer' },
    { id: 'guest', name: 'New member (no role yet)' }
];
export const ROLE_IDS = ROLES.map(r => r.id);
export const PERMS = ['crm', 'ops', 'projects', 'money', 'edit', 'assign', 'override', 'payments', 'tasksAll', 'survey', 'install', 'team', 'support', 'people', 'admin'];
const P = (list) => Object.fromEntries(PERMS.map(k => [k, list.includes(k)]));
export const DEFAULT_ROLES = {
    admin: P([...PERMS]),
    ops_head: P(['crm', 'ops', 'projects', 'money', 'edit', 'assign', 'payments', 'tasksAll', 'survey', 'install', 'team', 'support', 'people']),
    pm: P(['ops', 'projects', 'money', 'edit', 'assign', 'payments', 'tasksAll', 'survey', 'install', 'team', 'support']),
    sales: P(['crm', 'projects', 'money']),
    surveyor: P(['survey', 'projects']),
    designer: P(['projects', 'edit']),
    purchase: P(['projects', 'edit']),
    production: P(['projects', 'edit']),
    installer: P(['install']),
    guest: P([])
};
/** Who may create an account. approval: anyone can ask, someone with 'people' approves. open: they join at once as defaultRole. closed: only admins add people. */
export const TICKET_CATEGORIES = [
    { id: 'installation', name: 'Installation issue' }, { id: 'hardware', name: 'Hardware (hinge, channel, handle)' }, { id: 'damage', name: 'Damage / breakage' },
    { id: 'finish', name: 'Finish / colour / edge' }, { id: 'alignment', name: 'Alignment / gap / door sag' }, { id: 'missing', name: 'Missing part' },
    { id: 'service', name: 'General service / warranty' }, { id: 'other', name: 'Other' }
];
export const TICKET_CATEGORY_IDS = TICKET_CATEGORIES.map(c => c.id);
/** open → assigned → scheduled → in_progress → resolved (waiting for happy code) → closed; on_hold anytime */
export const TICKET_STATUS = { open: 'Registered', assigned: 'Technician assigned', scheduled: 'Visit scheduled', in_progress: 'Work in progress', on_hold: 'On hold', resolved: 'Work done, waiting for your happy code', closed: 'Closed' };
export const TICKET_SLA_HOURS = { urgent: 24, normal: 48, low: 96 };
export const SIGNUP_DEFAULT = { mode: 'approval', defaultRole: 'guest', domains: [] };
export const STAGES = [
    { id: 'survey', name: 'Site survey', short: 'Survey', owner: 'surveyor', days: 2 },
    { id: 'drawing', name: 'Production drawing and client approval', short: 'Drawing', owner: 'designer', days: 4 },
    { id: 'pi', name: 'Production PI (factory)', short: 'Factory PI', owner: 'purchase', days: 2 },
    { id: 'order', name: 'Hardware procurement and production', short: 'Hardware', owner: 'purchase', days: 10 },
    { id: 'dispatch', name: 'Dispatch and delivery', short: 'Dispatch', owner: 'production', days: 3 },
    { id: 'install', name: 'Installation', short: 'Install', owner: 'installer', days: 3 },
    { id: 'handover', name: 'Completion and handover', short: 'Handover', owner: 'pm', days: 2 },
    { id: 'closed', name: 'Completed', short: 'Done', owner: null, days: 0 }
];
export const STAGE_IDS = STAGES.map(s => s.id);
export const stageIdx = (s) => STAGES.findIndex(x => x.id === s);
export const stageById = Object.fromEntries(STAGES.map(s => [s.id, s]));
export const CUSTOMER_STAGE = { survey: 'Measurement', drawing: 'Design', pi: 'In production', order: 'In production', dispatch: 'On the way', install: 'Installing', handover: 'Installed', closed: 'Completed' };
export const ITEM_TYPES = [
    { id: 'WR', name: 'Wardrobe', std: 8 }, { id: 'TV', name: 'TV unit', std: 5 }, { id: 'VN', name: 'Vanity', std: 3 },
    { id: 'KT', name: 'Kitchen', std: 16 }, { id: 'DR', name: 'Dresser', std: 4 }, { id: 'ST', name: 'Study unit', std: 4 },
    { id: 'SR', name: 'Shoe rack', std: 2 }, { id: 'CU', name: 'Crockery unit', std: 5 }, { id: 'OT', name: 'Other', std: 4 }
];
export const TYPE_IDS = ITEM_TYPES.map(t => t.id);
export const typeName = (id) => ITEM_TYPES.find(t => t.id === id)?.name || id;
export const BOXES = {
    WR: ['Carcass panels', 'Shutters (set 1)', 'Shutters (set 2)', 'Hardware kit', 'Profiles and handles', 'Accessories'],
    TV: ['Carcass panels', 'Shutters and back panel', 'Hardware kit'], VN: ['Vanity carcass', 'Shutters and hardware'],
    KT: ['Base carcass (1)', 'Base carcass (2)', 'Wall carcass (1)', 'Wall carcass (2)', 'Tall unit', 'Shutters (1)', 'Shutters (2)', 'Shutters (3)', 'Baskets and accessories', 'Skirting and fillers', 'Profiles and handles', 'Hardware kit'],
    DR: ['Carcass', 'Shutters and mirror', 'Hardware kit'], CU: ['Carcass', 'Glass shutters', 'Hardware kit'], ST: ['Carcass', 'Shutters', 'Hardware kit'],
    SR: ['Carcass and shutters'], OT: ['Panels', 'Hardware kit']
};
export const CHECKLIST = ['Shutters aligned', 'Handles and knobs fixed', 'Soft-close and channels working', 'Edges and gaps finished', 'Site cleaned, debris removed'];
export const SNAG_TYPES = ['Missing part', 'Damaged', 'Wrong size', 'Site issue'];
export const SNAG_FLOW = ['open', 'reordered', 'dispatched', 'fixed'];
export const PAUSE_REASONS = ['Lunch / break', 'Material short', 'Site not ready', 'Customer request', 'End of day'];
export const BLOCK_REASONS = ['Waiting for customer', 'Waiting for material', 'Waiting for payment', 'Waiting for another team', 'Other'];
export const OBSTRUCTIONS = ['Window', 'Door', 'Switchboard', 'AC point', 'Plumbing / drain', 'Beam', 'Column', 'Gas pipe', 'Skirting'];
export const DEFAULT_PAYMENTS = [['Advance (booking)', 10, ''], ['Before order', 40, 'order'], ['Before dispatch', 40, ''], ['On handover', 10, '']];
export function stageTaskTitle(stage, code) {
    const t = { survey: 'Site survey', drawing: `Production drawing · ${code}`, pi: `Raise production PI with factory · ${code}`, order: `Procure hardware, track production · ${code}`, dispatch: `Dispatch and deliver · ${code}`, install: `Install ${code}`, handover: `Handover and sign-off · ${code}` };
    return t[stage] || code;
}
export const stageProof = (stage) => stage === 'drawing' ? 'file' : stage === 'install' ? 'photo' : '';
export function gatesFor(it, p) {
    const g = [];
    const add = (ok, text, hard) => g.push({ ok: !!ok, text, hard });
    const last = it.drawings[it.drawings.length - 1];
    switch (it.stage) {
        case 'survey':
            add(p.surveyStatus === 'submitted', 'Site survey submitted with every wall measured', false);
            break;
        case 'drawing':
            add(last && last.file !== false, 'Production drawing file uploaded (PDF or image)', true);
            add(specMissing(it.spec).length === 0, 'Material specification complete' + (specMissing(it.spec).length ? ` (missing: ${specMissing(it.spec).join(', ')})` : ''), true);
            add((it.boxes ?? 1) > 0, 'Packing list made', true);
            add(last && last.approved, 'Customer approved the latest drawing', true);
            break;
        case 'pi':
            add(it.prodPiNo || it.prodPI, 'Production PI raised with the factory (PI number)', true);
            add(p.orderPayment && p.orderPayment.received, `Payment received · ${p.orderPayment ? p.orderPayment.label + ' (' + p.orderPayment.pct + '%)' : 'before order'}`, true);
            break;
        case 'order':
            add(it.po, 'Hardware PO number entered', true);
            add(it.hwReceived, 'Hardware received', true);
            add(it.productionDone, 'Factory production complete', true);
            break;
        case 'dispatch':
            add(it.dispatch, 'Dispatch details entered (vehicle, boxes, date)', false);
            add(it.delivered, 'Material delivered at site', true);
            add(p.siteReady, 'Site ready: civil, electrical, painting, flooring done', true);
            break;
        case 'install':
            add(it.installDone, 'Installation completed with photos and checklist', true);
            add(!it.openSnags, 'No open snags', true);
            add(it.signedOff, 'Customer sign-off by WhatsApp OTP', true);
            break;
        case 'handover':
            add((it.handoverDocs ?? 0) > 0, 'Handover documents uploaded (warranty card, care guide, photos)', false);
            break;
    }
    return g;
}
/* ---------- CRM ---------- */
export const LEAD_STAGES = [
    { id: 'new', name: 'New', type: 'open' }, { id: 'contacted', name: 'Contacted', type: 'open' }, { id: 'qualified', name: 'Qualified', type: 'open' },
    { id: 'visit', name: 'Visit / Meeting', type: 'open' }, { id: 'proposal', name: 'Proposal sent', type: 'open' }, { id: 'negotiation', name: 'Negotiation', type: 'open' },
    { id: 'won', name: 'Won', type: 'won' }, { id: 'nurture', name: 'Nurture', type: 'nurture' }, { id: 'lost', name: 'Lost', type: 'lost' }
];
export const LEAD_STAGE_IDS = LEAD_STAGES.map(s => s.id);
export const leadStageName = (id) => LEAD_STAGES.find(s => s.id === id)?.name || id;
export const SOURCES = [
    { id: 'architect', name: 'Architect / Interior planner', family: 'partner' }, { id: 'contractor', name: 'Civil engineer / Contractor', family: 'partner' },
    { id: 'agent', name: 'Real estate agent', family: 'partner' }, { id: 'walkin', name: 'Showroom walk-in', family: 'direct' },
    { id: 'field', name: 'Field sales', family: 'direct' }, { id: 'online', name: 'Online', family: 'direct' }, { id: 'referral', name: 'Client referral', family: 'referral' }
];
export const SOURCE_IDS = SOURCES.map(s => s.id);
export const sourceOf = (id) => SOURCES.find(s => s.id === id);
export const LOST_REASONS = ['Budget', 'Timing', 'Bought elsewhere', 'Not reachable', 'Not interested'];
export const AUTOMATIONS = [
    { id: 'a1', fam: 'Every lead', name: 'Instant welcome', when: 'A new lead is added by hand or arrives from a Meta lead form', then: 'Send the welcome template to the client. Owner: the partner\'s relationship owner, else the person chosen, else the salesperson with the fewest leads this month. The owner gets an urgent "Call new lead" task.', on: true, tpl: 'welcome_catalogue', to: 'Client', built: true },
    { id: 'a2', fam: 'Every lead', name: 'Missed-response alert', when: 'A client\'s WhatsApp message has no reply for 15 minutes', then: 'Urgent task for the lead owner to reply (with a WhatsApp alert to the owner)', on: true, tpl: 'task_assigned', to: 'Lead owner', built: true },
    { id: 'a3', fam: 'Every lead', name: 'Follow-up nudge', when: 'An open lead has not replied for 2 days', then: 'Send the follow-up template (at most once a week). If they still don\'t reply 5 days after the nudge, move the lead to Nurture.', on: true, tpl: 'follow_up_gentle', to: 'Client', built: true },
    { id: 'a4', fam: 'Every lead', name: 'Visit reminder', when: '1 day and 2 hours before a showroom or site visit', then: 'Send the visit reminder template. Needs a visit date on the lead first.', on: false, tpl: 'visit_reminder', to: 'Client', built: false },
    { id: 'a5', fam: 'Every lead', name: 'Post-visit feedback', when: 'Lead moved to Visit / Meeting', then: 'After 3 hours, ask the client how the visit went', on: false, to: 'Client', built: false },
    { id: 'a6', fam: 'Every lead', name: 'Quote follow-up', when: 'Lead moved to Proposal sent', then: 'Task for the owner to call the client in 2 days', on: true, to: 'Lead owner', built: true },
    { id: 'a7', fam: 'Every lead', name: 'Won: start the project', when: 'Lead moved to Won', then: 'Task for the owner to convert the lead into a project the next day. The client gets the project welcome template when the project is created.', on: true, tpl: 'project_welcome', to: 'Client', built: true },
    { id: 'a8', fam: 'Every lead', name: 'Lost win-back', when: '60 days after Lost for Budget or Timing', then: 'Re-engagement (marketing) template, for opted-in contacts only', on: false, tpl: 'festive_offer', to: 'Client', built: false },
    { id: 'a9', fam: 'Every lead', name: 'Stale lead alert', when: 'A lead stays in the same open stage for 7 days', then: 'Task for the lead owner, once a week', on: true, to: 'Lead owner', built: true },
    { id: 'a10', fam: 'Every lead', name: 'Greetings', when: 'Birthday or anniversary', then: 'Greeting template for opted-in contacts. Needs dates on the lead first.', on: false, to: 'Client', built: false },
    { id: 'a11', fam: 'Partners', name: 'Partner lead received', when: 'A new lead comes from an architect, contractor or agent', then: 'Tell the partner the lead was received and which consultant will call', on: true, tpl: 'partner_update', to: 'Partner', built: true },
    { id: 'a12', fam: 'Partners', name: 'Partner progress updates', when: 'A partner\'s lead reaches Visit, Proposal sent or Won', then: 'Send the partner the new status', on: true, tpl: 'partner_update', to: 'Partner', built: true },
    { id: 'a13', fam: 'Partners', name: 'Commission on Won', when: 'A partner\'s lead moves to Won', then: 'Create a commission entry from the partner\'s rate, for the manager to approve', on: true, built: true },
    { id: 'a14', fam: 'Referrals', name: 'Referral reward', when: 'A client-referral lead is created, and again when it is Won', then: 'Note the referral on the timeline; on Won, a task for the owner to give the referring client their reward', on: true, to: 'Lead owner', built: true },
    { id: 'a15', fam: 'Partners', name: 'Dormant partner nudge', when: 'A partner has sent no lead for 60 days', then: 'Task for the partner\'s relationship owner to visit or call (once a month)', on: true, to: 'Relationship owner', built: true }
];
/* WhatsApp templates the system uses (name -> category + body with {{n}} params + optional quick-reply buttons) */
export const WA_TEMPLATES = {
    login_otp: { category: 'AUTHENTICATION', body: '{{1}} is your verification code.' },
    install_signoff_otp: { category: 'AUTHENTICATION', body: '{{1}} is your verification code.' },
    task_assigned: { category: 'UTILITY', body: 'Hello, a new task has been assigned to you in Make My Space by {{1}}. Task: {{2}}. Project: {{3}}. Please finish it by {{4}}. Tap Start when you begin, or Open to see the details.', buttons: ['Start', 'Open'] },
    task_reminder: { category: 'UTILITY', body: 'Reminder from Make My Space. Your task is {{1}}: {{2}}. Project: {{3}}. Tap Mark done once it is finished, or Blocked if something is stopping you.', buttons: ['Mark done', 'Blocked'] },
    task_escalation: { category: 'UTILITY', body: 'Escalation from Make My Space: {{1}} is now {{2}} days late on the task {{3}}. Please check with them and help them finish it today.', buttons: ['Open task', 'Nudge'] },
    task_blocked: { category: 'UTILITY', body: 'Update from Make My Space: {{1}} has marked the task "{{2}}" as blocked. Reason given: {{3}}. Please help them clear it.' },
    task_more_time: { category: 'UTILITY', body: 'Request from Make My Space: {{1}} is asking for more time on the task {{2}}. Current deadline {{3}}, new date asked for {{4}}. Reason given: {{5}}. Tap Approve or Reject.', buttons: ['Approve', 'Reject'] },
    task_update: { category: 'UTILITY', body: 'Update from Make My Space on your task {{1}}: {{2}}. Open the app to see the details.' },
    weekly_owner_report: { category: 'UTILITY', body: 'Your Make My Space weekly report. Tasks completed: {{1}}. Completed by the original deadline: {{2}} percent. Still overdue: {{3}}. Items over their stage target: {{4}}. Most late work: {{5}}. Open the app for the scorecards.' },
    daily_digest: { category: 'UTILITY', body: 'Good morning {{1}}. You have {{2}} overdue and {{3}} due today. Open the app to see them.' },
    owner_day_summary: { category: 'UTILITY', body: 'Your Make My Space summary for today. Tasks completed: {{1}}. Tasks overdue: {{2}}. Furniture items moved to the next stage: {{3}}. New snags raised: {{4}}. Open the app for the full picture.' },
    project_welcome: { category: 'UTILITY', body: 'Hello {{1}}, welcome to Make My Space! Your project {{2}} is booked. Our surveyor will visit on {{3}} to measure every wall.' },
    survey_done: { category: 'UTILITY', body: 'Hello {{1}}, the site survey for {{2}} is complete. Your designer will share production drawings for approval soon.' },
    approval_form: { category: 'UTILITY', body: 'Hello {{1}}, {{2}} production drawings for your project {{3}} are ready for your approval. Please open {{4}} to review each drawing with its materials, then approve them all or ask for a change. Thank you.' },
    drawing_for_approval: { category: 'UTILITY', body: 'Hello {{1}}, the drawing {{2}} for your {{3}} is ready. Please review and approve.', buttons: ['Approve', 'Ask for a change'] },
    installation_scheduled: { category: 'UTILITY', body: 'Hello {{1}}, good news from Make My Space. The installation of your {{2}} is planned for {{3}}. Our installation team led by {{4}} will reach your site; you can call them on {{5}}. Please make sure the site is ready and accessible.' },
    handover_feedback: { category: 'UTILITY', body: 'Hello {{1}}, your Make My Space project {{2}} is complete. How would you rate us?', buttons: ['5 Excellent', '4 Good', '3 Okay'] },
    partner_update: { category: 'UTILITY', body: 'Hello {{1}}, an update on your referral {{2}}: now at {{3}}. Thank you for trusting Make My Space.' },
    staff_invite: { category: 'UTILITY', body: 'Hello {{1}}, welcome to the Make My Space team. You have joined as {{2}}. Your tasks, site visits and project updates will now come to you on this WhatsApp number.' },
    support_ticket_raised: { category: 'UTILITY', body: 'Hello {{1}}, thank you for contacting Make My Space. Your complaint has been registered and your complaint number is {{2}}. Issue: {{3}}. We will update you on WhatsApp as it moves ahead, and you can track it any time in the Make My Space customer app.' },
    support_visit_scheduled: { category: 'UTILITY', body: 'Hello {{1}}, an update on complaint {{2}} from Make My Space. Our service visit is planned for {{3}}. Your technician is {{4}}, reachable on {{5}}. When the work is done to your satisfaction, please share your happy code with the technician to close the complaint.' },
    support_ticket_update: { category: 'UTILITY', body: 'Hello {{1}}, an update on your Make My Space complaint {{2}}. Current status: {{3}}. You can see the full details in the Make My Space customer app.' },
    support_ticket_closed: { category: 'UTILITY', body: 'Hello {{1}}, your Make My Space complaint {{2}} has been resolved and closed. Thank you for your patience. How happy are you with our service?', buttons: ['Very happy', 'Okay', 'Not happy'] },
    welcome_catalogue: { category: 'UTILITY', body: 'Hello {{1}}, thank you for your interest in Make My Space. Your consultant {{2}} will call you shortly. Our kitchen and wardrobe catalogue is attached.' },
    follow_up_gentle: { category: 'UTILITY', body: 'Hello {{1}}, just checking in on your {{2}} enquiry. Would you like an updated design, or shall we fix a showroom visit?' },
    visit_reminder: { category: 'UTILITY', body: 'Hello {{1}}, a reminder of your visit to our showroom. Reply 1 to confirm or 2 to reschedule.' },
    quote_followup: { category: 'UTILITY', body: 'Hello {{1}}, did you get a chance to review the itemised quote we sent? Happy to walk you through it on a call.' },
    festive_offer: { category: 'MARKETING', body: 'Hello {{1}}, complete home interiors in 45 days, with a 10-year warranty on modular kitchens and wardrobes. Reply YES to book a free consultation.' }
};
export function renderTemplate(name, params) {
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
];
export function specMissing(spec) {
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
];
export const DOC_CATEGORY_IDS = DOC_CATEGORIES.map(c => c.id);
/* ---------- money, factory, service ---------- */
export const PAY_MODES = ['UPI', 'Bank transfer', 'Cheque', 'Cash', 'Card'];
export const PRODUCTION_STEPS = [
    { id: 'cutting', name: 'Panel cutting' }, { id: 'edging', name: 'Edge banding' }, { id: 'drilling', name: 'Drilling and grooving' },
    { id: 'assembly', name: 'Assembly / dry fit' }, { id: 'packing', name: 'Packing and labelling' }
];
export const SNAG_PAYERS = ['Company', 'Factory', 'Vendor', 'Customer'];
export const COMPANY_DEFAULT = {
    name: 'Make My Space', legalName: '', gstin: '', address: 'Raipur, Chhattisgarh', phone: '+91 75838 37704', email: 'hello@makemyspace.in',
    website: 'makemyspace.in', bank: '', hsn: '9403', gstPct: 18, warrantyYears: 10, quoteValidityDays: 15,
    quoteTerms: '50% advance to start production. Balance before dispatch. Prices include installation. Civil, electrical and plumbing work are not included.'
};
/** Financial year label for invoice numbers, e.g. 2026-27 (April to March). */
export function fyLabel(d = new Date()) { const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; }
export function quoteTotals(lines, discount, gstPct) {
    const subtotal = Math.round(lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0) * 100) / 100;
    const taxable = Math.max(0, subtotal - (Number(discount) || 0));
    const total = Math.round(taxable * (1 + (Number(gstPct) || 0) / 100));
    return { subtotal, taxable, total };
}
/* stage targets (days) — editable in Settings; these are the defaults */
export const STAGE_TARGETS_DEFAULT = Object.fromEntries(STAGES.filter(s => s.id !== 'closed').map(s => [s.id, s.days]));
export const WAITING_REASONS = ['', 'client_approval', 'client_payment', 'site_not_ready', 'client_other'];
/* reusable task templates for the New task form — editable in Settings */
export const TASK_TEMPLATES_DEFAULT = [
    { title: 'Share revised drawing with the client', days: 1, proof: 'file', verify: false, priority: 'normal' },
    { title: 'Collect payment from the client', days: 2, proof: 'comment', verify: true, priority: 'urgent' },
    { title: 'Site readiness check (civil, electrical, paint, flooring)', days: 2, proof: 'photo', verify: true, priority: 'normal' },
    { title: 'Call the client about pending approval', days: 1, proof: 'comment', verify: false, priority: 'normal' },
    { title: 'Follow up factory on production status', days: 1, proof: 'comment', verify: false, priority: 'normal' },
    { title: 'Daily site visit report', days: 1, proof: 'photo', verify: false, priority: 'normal' }
];
/* room names offered when building the scope (code is used in item codes, e.g. MBR-WR-01) */
export const ROOM_PRESETS = [['Master Bedroom', 'MBR'], ['Bedroom 2', 'BR2'], ['Bedroom 3', 'BR3'], ['Kids Room', 'KID'], ['Guest Room', 'GBR'], ['Living', 'LIV'], ['Kitchen', 'KIT'], ['Pantry', 'PAN'], ['Dining', 'DIN'], ['Dresser', 'DRS'], ['Puja', 'PUJ'], ['Utility', 'UTL'], ['Study', 'STD'], ['Foyer', 'FOY'], ['Bathroom', 'BTH']];
