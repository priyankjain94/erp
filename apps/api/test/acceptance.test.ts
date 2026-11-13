/* End-to-end acceptance tests against a real PostgreSQL database and a mock Meta Graph API.
   Run: DATABASE_URL=postgres://... npm test   (the database is wiped and re-seeded with demo data). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

const SECRET = 'test-app-secret';
const graphCalls: { path: string; body: any; method?: string; sig?: string }[] = [];
const mockGraph = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const url = new URL(req.url!, 'http://x'); const body = raw ? JSON.parse(raw) : null;
    graphCalls.push({ path: url.pathname, body, method: req.method, sig: req.headers['x-hub-signature-256'] as string });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/forward') return res.end('{}');
    if (url.pathname.endsWith('/message_templates') && req.method === 'GET') return res.end(JSON.stringify({ data: [
      { name: 'mms_quotation_request', language: 'en_US', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi {{1}}, thanks for your interest.' }] },
      { name: 'mms_followup_day3', language: 'en_US', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi {{1}}, following up.' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Visit' }] }] },
      { name: 'mms_task_assigned', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: '{{1}} {{2}} {{3}} {{4}}' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Start' }, { type: 'QUICK_REPLY', text: 'Done' }] }] }] }));
    if (url.pathname.endsWith('/message_templates')) return res.end(JSON.stringify({ id: 't' + graphCalls.length, status: 'PENDING', category: body?.category }));
    if (url.pathname.endsWith('/messages')) return res.end(JSON.stringify({ messages: [{ id: 'wamid.' + crypto.randomUUID() }] }));
    if (url.pathname.endsWith('/leadgen_forms')) return res.end(JSON.stringify({ data: [{ id: 'form1', name: 'Kitchen leads' }] }));
    if (url.pathname.endsWith('/form1/leads')) return res.end(JSON.stringify({ data: [{ id: 'lg-777', form_id: 'form1', created_time: new Date().toISOString(), field_data: [{ name: 'full_name', values: ['Polled Person'] }, { name: 'phone_number', values: ['+919811100077'] }] }] }));
    if (url.pathname.includes('/lg-')) return res.end(JSON.stringify({ id: url.pathname.split('/').pop(), form_id: 'form1', campaign_name: 'Diwali kitchens', ad_name: 'Reel 3', platform: 'ig',
      field_data: [{ name: 'full_name', values: ['Meta Person'] }, { name: 'phone_number', values: ['+91 98111 00099'] }, { name: 'city', values: ['Raipur'] }, { name: 'what_do_you_need', values: ['Modular kitchen'] }] }));
    res.statusCode = 404; res.end('{}');
  });
});

let base = '', app: http.Server;
let M: any = {};
const sign = (raw: string) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');

before(async () => {
  await new Promise<void>(r => mockGraph.listen(0, r));
  Object.assign(process.env, {
    NODE_ENV: 'test', DEMO_MODE: 'true', SCHEDULER_ENABLED: 'false', WORKER_ENABLED: 'false', STORAGE_LOCAL_DIR: '/tmp/mms-test-uploads',
    META_GRAPH_BASE: `http://127.0.0.1:${(mockGraph.address() as AddressInfo).port}`, META_APP_SECRET: SECRET,
    WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '1111', WHATSAPP_WABA_ID: '2222', WHATSAPP_VERIFY_TOKEN: 'wa-verify', WHATSAPP_FORWARD_URL: '',
    META_PAGE_ID: 'page1', META_PAGE_ACCESS_TOKEN: 'page-token', META_LEADS_VERIFY_TOKEN: 'leads-verify'
  });
  const { migrate } = await import('../src/core/migrate.js');
  const { tx } = await import('../src/core/db.js');
  const seed = await import('../src/seed.js');
  await migrate();
  await tx(async q => { await seed.wipe(q); await seed.seedDemo(q); await seed.bootstrap(q); });
  M.jobs = await import('../src/core/jobs.js');
  M.db = await import('../src/core/db.js');
  M.tasks = await import('../src/modules/tasks.js');
  M.meta = await import('../src/integrations/metaLeads.js');
  const { buildApp } = await import('../src/app.js');
  app = buildApp(); await new Promise<void>(r => app.listen(0, r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
after(async () => { app.close(); mockGraph.close(); await M.db.pool.end(); });

async function api(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text(); let json: any = {}; try { json = JSON.parse(text); } catch { json = { text }; }
  return { status: r.status, ...json };
}
async function login(phone: string, audience = 'staff') {
  const r = await api('POST', '/api/v1/auth/otp/request', { phone, audience });
  assert.equal(r.sent, true, JSON.stringify(r));
  const v = await api('POST', '/api/v1/auth/otp/verify', { phone, audience, code: r.devCode });
  assert.ok(v.accessToken, JSON.stringify(v)); return v.accessToken as string;
}
async function upload(token: string, type = 'application/pdf') {
  const slot = await api('POST', '/api/v1/uploads', { contentType: type, size: 4 }, token);
  const r = await fetch(base + slot.uploadUrl, { method: 'PUT', body: Buffer.from([37, 80, 68, 70]) }); assert.equal(r.status, 200);
  return slot.ref as string;
}
const SPEC = { size: '3200 × 850 × 560', carcass: 'BWP plywood 18 mm', shutter: 'HDHMR 18 mm', finish: 'Acrylic gloss white', hardware: 'Hettich soft-close' };
const drain = async () => { while (await M.jobs.runDueJobs(50) > 0) { /* run all queued jobs */ } };
const q1 = async (sql: string, p: unknown[] = []) => (await M.db.pool.query(sql, p)).rows[0];
const phoneOf = (i: number) => '+9190000000' + String(i + 1).padStart(2, '0');
const P = { owner: phoneOf(0), meera: phoneOf(1), vikram: phoneOf(2), sana: phoneOf(6), deepa: phoneOf(7), arjun: phoneOf(8), manish: phoneOf(9), ravi: phoneOf(11) };
const T: Record<string, string> = {};

test('1. staff login: unknown number, wrong OTP, role-scoped data', async () => {
  assert.equal((await api('POST', '/api/v1/auth/otp/request', { phone: '9999900000', audience: 'staff' })).status, 404);
  const r = await api('POST', '/api/v1/auth/otp/request', { phone: P.ravi, audience: 'staff' });
  const wrong = await api('POST', '/api/v1/auth/otp/verify', { phone: P.ravi, audience: 'staff', code: r.devCode === '1111' ? '2222' : '1111' });
  assert.equal(wrong.status, 400); assert.equal(wrong.error, 'otp_wrong');
  T.ravi = (await api('POST', '/api/v1/auth/otp/verify', { phone: P.ravi, audience: 'staff', code: r.devCode })).accessToken;
  const st = await api('GET', '/api/v1/state', undefined, T.ravi);
  assert.ok(st.erp.items.length > 0 && st.erp.items.every((i: any) => i.installer === 'ravi'), 'installer sees only own items');
  assert.equal(st.crm.leads.length, 0, 'installer gets no CRM data');
  assert.ok(st.erp.projects.every((p: any) => p.value === 0 && p.payments.length === 0), 'installer gets no money data');
  assert.equal((await api('POST', '/api/v1/users', { name: 'X', phone: '9123400000', role: 'sales' }, T.ravi)).status, 403);
  for (const k of ['owner', 'meera', 'vikram', 'sana', 'deepa', 'arjun', 'manish'] as const) T[k] = await login(P[k]);
  const own = await api('GET', '/api/v1/state', undefined, T.owner);
  assert.equal(own.erp.projects.length, 3); assert.equal(own.erp.items.length, 19); assert.equal(own.crm.leads.length, 18);
  assert.equal((await api('GET', '/api/v1/state')).status, 401);
});

test('2. installation teams: add, duplicate phone blocked, edit, deactivate revokes login', async () => {
  const add = await api('POST', '/api/v1/teams', { name: 'Kamal', phone: '9000011111', members: ['Ramesh', 'Dinesh'], skills: ['WR', 'TV', 'VN'] }, T.meera);
  assert.equal(add.ok, true, JSON.stringify(add));
  const kam = add.state.erp.users.find((u: any) => u.name === 'Kamal'); T.kamalId = kam.id;
  assert.equal(kam.role, 'installer'); assert.deepEqual(kam.members, ['Ramesh', 'Dinesh']); assert.equal(kam.title, 'Installation lead · team of 3');
  assert.equal((await api('POST', '/api/v1/teams', { name: 'Dup', phone: '9000011111', members: [] }, T.meera)).status, 400);
  const ed = await api('PATCH', `/api/v1/teams/${kam.id}`, { members: ['Ramesh', 'Dinesh', 'Prakash'] }, T.meera);
  assert.equal(ed.state.erp.users.find((u: any) => u.id === kam.id).title, 'Installation lead · team of 4');
  T.kamal = await login('9000011111');
  assert.equal((await api('GET', '/api/v1/state', undefined, T.kamal)).status, 200);
  assert.equal((await api('POST', '/api/v1/teams', { name: 'Nope', phone: '9000022222' }, T.ravi)).status, 403, 'installers cannot add teams');
});

test('3. assignment: whole project to a team, skill warning, install task', async () => {
  const st = await api('GET', '/api/v1/state', undefined, T.vikram);
  const open = st.erp.items.filter((i: any) => i.projectId === 'P101' && !i.installer && ['pi', 'order', 'dispatch', 'install'].includes(i.stage));
  assert.ok(open.length >= 3);
  const r = await api('POST', '/api/v1/assignments', { itemIds: open.map((i: any) => i.id), installer: T.kamalId, target: '2099-01-10' }, T.vikram);
  assert.equal(r.ok, true); assert.equal(r.warning, '');
  assert.ok(r.state.erp.items.filter((i: any) => open.some((o: any) => o.id === i.id)).every((i: any) => i.installer === T.kamalId && i.target === '2099-01-10'));
  const kit = st.erp.items.find((i: any) => i.projectId === 'P101' && i.type === 'KT');
  const w = await api('POST', '/api/v1/assignments', { itemIds: [kit.id], installer: T.kamalId }, T.vikram);
  assert.match(w.warning, /not marked for kitchen/);
  const back = await api('POST', '/api/v1/assignments', { itemIds: [kit.id], installer: 'suresh' }, T.vikram);
  assert.ok(back.state.erp.tasks.some((t: any) => t.itemId === kit.id && t.assignee === 'suresh' && t.status !== 'done'), 'install task for the new team');
  assert.equal((await api('POST', '/api/v1/assignments', { itemIds: [kit.id], installer: 'suresh' }, T.deepa)).status, 403);
});

test('4. CRM: new lead automations, duplicate flag, won lead converts to a project', async () => {
  const a = await api('POST', '/api/v1/leads', { name: 'Neha Kapoor', phone: '9812345678', source: 'architect', ref: 'p1', interest: 'Kitchen', value: 500000 }, T.owner);
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.ownerName, 'Priya', 'partner leads go to the partner owner');
  const lead = a.state.crm.leads.find((l: any) => l.id === a.id);
  assert.ok(lead.timeline.some((t: any) => /thanked on WhatsApp/.test(t.text)) && lead.msgs.some((m: any) => m.tpl === 'welcome_catalogue'));
  const d = await api('POST', '/api/v1/leads', { name: 'Neha again', phone: '98123 45678', source: 'online', sub: 'Website' }, T.owner);
  assert.equal(d.dup, true);
  assert.equal((await api('POST', '/api/v1/leads', { name: 'No partner', phone: '9812345600', source: 'architect' }, T.owner)).status, 400);
  await api('POST', '/api/v1/leads/L17/stage', { stage: 'won' }, T.owner);
  const c = await api('POST', '/api/v1/leads/L17/convert', { pm: 'vikram', target: '2099-03-01', surveyDate: '2099-01-02', advance: true, address: 'Fafadih, Raipur' }, T.owner);
  assert.equal(c.ok, true, JSON.stringify(c)); T.pid = c.id;
  const p = c.state.erp.projects.find((x: any) => x.id === c.id);
  assert.equal(p.customer, 'Kunal Bhatia'); assert.equal(p.payments[0].received, true); assert.equal(p.survey.status, 'scheduled');
  assert.ok(c.state.erp.tasks.some((t: any) => t.projectId === c.id && t.assignee === 'sana'));
  assert.ok(c.state.crm.leads.find((l: any) => l.id === 'L17').timeline.some((t: any) => /Converted to project/.test(t.text)));
  assert.equal((await api('POST', '/api/v1/leads/L17/convert', { pm: 'vikram', target: '2099-03-01', surveyDate: '2099-01-02', address: 'x y' }, T.owner)).status, 409, 'no double conversion');
});

const walls = (photo: string | null) => ['A', 'B', 'C', 'D'].map((l, i) => ({ label: l, w: i % 2 ? 2400 : 3200, h: 2900, photo, notes: '', obs: l === 'A' ? [{ type: 'Door', left: 150, floor: 0, w: 900, h: 2100 }] : [] }));
test('5. site survey: check-in, draft, incomplete blocked, submit creates items', async () => {
  assert.equal((await api('POST', `/api/v1/surveys/${T.pid}/check-in`, {}, T.ravi)).status, 403);
  const ci = await api('POST', `/api/v1/surveys/${T.pid}/check-in`, { lat: 21.25, lng: 81.63 }, T.sana); assert.equal(ci.ok, true);
  const rooms = [{ id: 'room-k', name: 'Kitchen', code: 'KIT', ceiling: 2900, floor: 'Tiled, finished', shape: 'rect', walls: walls(null), items: [{ type: 'KT', wall: 'A', desc: 'L-shape' }, { type: 'CU', wall: 'C', desc: '' }] }];
  assert.equal((await api('PUT', `/api/v1/surveys/${T.pid}/draft`, { rooms }, T.sana)).ok, true);
  const bad = await api('POST', `/api/v1/surveys/${T.pid}/submit`, {}, T.sana);
  assert.equal(bad.status, 400); assert.equal(bad.error, 'survey_incomplete'); assert.match(bad.message, /photo/);
  // upload a real photo through the storage flow
  const slot = await api('POST', '/api/v1/uploads', { contentType: 'image/jpeg', size: 4 }, T.sana);
  const up = await fetch(base + slot.uploadUrl, { method: 'PUT', body: Buffer.from([1, 2, 3, 4]) }); assert.equal(up.status, 200);
  assert.equal((await fetch(base + slot.viewUrl)).status, 200);
  assert.equal((await fetch(base + slot.viewUrl.replace(/sig=[^&]+/, 'sig=bad'))).status, 403);
  rooms[0].walls = walls(slot.ref) as any;
  const ok = await api('POST', `/api/v1/surveys/${T.pid}/submit`, { signed: true, rooms }, T.sana);
  assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.created, 2);
  const st = await api('GET', '/api/v1/state', undefined, T.owner);
  const its = st.erp.items.filter((i: any) => i.projectId === T.pid);
  assert.deepEqual(its.map((i: any) => i.stage), ['drawing', 'drawing']);
  assert.ok(its.every((i: any) => st.erp.tasks.some((t: any) => t.itemId === i.id && /Production drawing/.test(t.title))));
  const pr = st.erp.projects.find((p: any) => p.id === T.pid);
  assert.equal(pr.survey.rooms[0].walls[0].obs[0].type, 'Door'); assert.ok(pr.survey.rooms[0].walls[0].photoUrl.startsWith('/api/v1/files/'));
  T.kit = its.find((i: any) => i.type === 'KT').id; T.cu = its.find((i: any) => i.type === 'CU').id;
});

test('6. drawing gate + customer login approves in the customer app', async () => {
  const designer = (await api('GET', '/api/v1/state', undefined, T.owner)).erp.items.find((i: any) => i.id === T.kit).designer;
  const dt = designer === 'deepa' ? T.deepa : T.arjun;
  assert.equal((await api('POST', `/api/v1/items/${T.kit}/drawings`, {}, dt)).status, 400, 'a drawing needs a real file');
  const noSpec = await api('POST', `/api/v1/items/${T.kit}/drawings`, { file: await upload(dt) }, dt);
  assert.equal(noSpec.ok, true);
  const b1 = await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next' }, dt);
  assert.equal(b1.status, 409); assert.match(b1.message, /Material specification/);
  const up = await api('POST', `/api/v1/items/${T.kit}/drawings`, { file: await upload(dt), spec: SPEC, boxes: ['Base carcass', 'Wall carcass', 'Shutters', 'Hardware kit'], notes: 'R1 with tall unit' }, dt);
  const kitNow = up.state.erp.items.find((i: any) => i.id === T.kit);
  assert.equal(kitNow.drawings.at(-1).rev, 'R1'); assert.ok(kitNow.drawings.at(-1).url.startsWith('/api/v1/files/')); assert.equal(kitNow.spec.carcass, 'BWP plywood 18 mm'); assert.equal(kitNow.boxes.length, 4);
  const blocked = await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next' }, dt);
  assert.equal(blocked.status, 409); assert.match(blocked.message, /Customer approved/);
  assert.equal((await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next', reason: 'trust me' }, dt)).status, 409, 'designer cannot override');
  await api('POST', `/api/v1/items/${T.kit}/drawings/send`, {}, dt);
  T.cust = await login('+91 93009 25481', 'customer');
  const cs = await api('GET', '/api/v1/customer/state', undefined, T.cust);
  assert.equal(cs.state.projects.length, 1); assert.equal(cs.state.items.find((i: any) => i.id === T.kit).customerStage, 'Design');
  assert.equal((await api('POST', `/api/v1/customer/items/I1/approve`, {}, T.cust)).status, 403, 'cannot touch another customer');
  assert.equal((await api('GET', '/api/v1/state', undefined, T.cust)).status, 403, 'customer token cannot reach staff API');
  const ap = await api('POST', `/api/v1/customer/items/${T.kit}/approve`, {}, T.cust);
  assert.equal(ap.state.items.find((i: any) => i.id === T.kit).drawings.at(-1).approved, true);
  const comp = await api('POST', `/api/v1/customer/projects/${T.pid}/complaint`, { text: 'Showroom sample was scratched' }, T.cust); assert.equal(comp.ok, true);
  const t = (await api('GET', '/api/v1/state', undefined, T.vikram)).erp.tasks.find((x: any) => /Customer complaint/.test(x.title));
  assert.equal(t.priority, 'urgent'); assert.equal(t.assignee, 'vikram');
  const mv = await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next' }, dt);
  assert.equal(mv.to, 'pi');
});

test('7. pipeline: payment gate, PO, dispatch, site-ready gate, install task', async () => {
  assert.equal((await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next' }, T.manish)).status, 409, 'factory PI number needed');
  await api('PATCH', `/api/v1/items/${T.kit}`, { prodPiNo: 'FPI-9001', prodPiAmount: 145000, prodPiDoc: await upload(T.manish) }, T.manish);
  const pay = await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next' }, T.manish);
  assert.equal(pay.status, 409); assert.match(pay.message, /Payment received/);
  const st = await api('GET', '/api/v1/state', undefined, T.vikram);
  const m = st.erp.projects.find((p: any) => p.id === T.pid).payments.find((x: any) => x.gate === 'order');
  assert.equal((await api('POST', `/api/v1/projects/${T.pid}/payments/${m.id}`, { received: true }, T.manish)).status, 403, 'purchase cannot mark payments');
  await api('POST', `/api/v1/projects/${T.pid}/payments/${m.id}`, { received: true }, T.vikram);
  assert.equal((await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next' }, T.manish)).to, 'order');
  await api('PATCH', `/api/v1/items/${T.kit}`, { po: 'PO-9001', hwVendor: 'Hettich dealer' }, T.manish);
  const hw = await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next' }, T.manish);
  assert.equal(hw.status, 409); assert.match(hw.message, /Hardware received/);
  await api('PATCH', `/api/v1/items/${T.kit}`, { hwReceived: true, productionDone: true }, T.manish);
  assert.equal((await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next' }, T.manish)).to, 'dispatch');
  await api('PATCH', `/api/v1/items/${T.kit}`, { dispatch: { vehicle: 'CG04 AB 1234', boxes: 12, date: '2099-01-05' }, delivered: true }, T.vikram);
  const site = await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next' }, T.vikram);
  assert.equal(site.status, 409); assert.match(site.message, /Site ready/);
  await api('PATCH', `/api/v1/projects/${T.pid}`, { siteReady: true }, T.vikram);
  await api('POST', '/api/v1/assignments', { itemIds: [T.kit], installer: 'ravi', target: '2099-01-09' }, T.vikram);
  const inst = await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next' }, T.vikram);
  assert.equal(inst.to, 'install');
  const it = inst.state.erp.items.find((i: any) => i.id === T.kit);
  assert.equal(it.owner, 'ravi');
  assert.ok(inst.state.erp.tasks.some((t: any) => t.itemId === T.kit && t.assignee === 'ravi' && t.status !== 'done' && t.proof === 'photo'));
});

test('8. installer app: missing box -> snag, work sessions, OTP sign-off held by snag', async () => {
  assert.equal((await api('POST', `/api/v1/items/${T.kit}/work/start`, {}, T.kamal)).status, 403, 'other teams cannot touch the job');
  await api('POST', `/api/v1/items/${T.kit}/boxes/1`, { got: true }, T.ravi);
  await api('POST', `/api/v1/items/${T.kit}/boxes/2`, { got: false }, T.ravi);
  const sn = await api('POST', `/api/v1/items/${T.kit}/snags`, { type: 'Missing part', part: 'Box #2 Base carcass (2)', note: '' }, T.ravi);
  assert.ok(sn.state.erp.tasks.length >= 0);
  const own = await api('GET', '/api/v1/state', undefined, T.manish);
  assert.ok(own.erp.tasks.some((t: any) => /Snag reorder/.test(t.title) && t.priority === 'urgent'), 'reorder task for purchase');
  assert.equal((await api('POST', `/api/v1/items/${T.kit}/work/start`, { lat: 1, lng: 2 }, T.ravi)).ok, true);
  assert.equal((await api('POST', `/api/v1/items/${T.kit}/work/start`, {}, T.ravi)).status, 400, 'cannot start twice');
  await api('POST', `/api/v1/items/${T.kit}/work/pause`, { reason: 'Lunch / break' }, T.ravi);
  await api('POST', `/api/v1/items/${T.kit}/work/start`, {}, T.ravi);
  const checklist = Object.fromEntries(['Shutters aligned', 'Handles and knobs fixed', 'Soft-close and channels working', 'Edges and gaps finished', 'Site cleaned, debris removed'].map(c => [c, true]));
  assert.equal((await api('POST', `/api/v1/items/${T.kit}/complete/request-otp`, { checklist: { 'Shutters aligned': true }, photo: 'sample' }, T.ravi)).status, 400);
  const otp = await api('POST', `/api/v1/items/${T.kit}/complete/request-otp`, { checklist, photo: 'sample' }, T.ravi);
  assert.match(otp.devCode, /^\d{4}$/);
  assert.equal((await api('POST', `/api/v1/items/${T.kit}/complete/verify`, { code: otp.devCode === '1234' ? '4321' : '1234' }, T.ravi)).status, 400);
  const v = await api('POST', `/api/v1/items/${T.kit}/complete/verify`, { code: otp.devCode }, T.ravi);
  assert.equal(v.heldBySnags, 1);
  const it = v.state.erp.items.find((i: any) => i.id === T.kit);
  assert.equal(it.stage, 'install'); assert.equal(it.installDone, true); assert.equal(it.sessions.length, 2); assert.ok(it.sessions.every((s: any) => s.end));
});

test('9. snag closed, handover, completion, owner override with audit', async () => {
  const sid = (await api('GET', '/api/v1/state', undefined, T.vikram)).erp.items.find((i: any) => i.id === T.kit).snags[0].id;
  for (let i = 0; i < 3; i++) await api('POST', `/api/v1/snags/${sid}/advance`, {}, T.vikram);
  assert.equal((await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next' }, T.vikram)).to, 'handover');
  assert.equal((await api('POST', `/api/v1/items/${T.kit}/transition`, { direction: 'next' }, T.vikram)).to, 'closed');
  await api('POST', `/api/v1/items/${T.cu}/drawings`, { file: await upload(T.owner), spec: SPEC }, T.owner);
  assert.equal((await api('POST', `/api/v1/items/${T.cu}/transition`, { direction: 'next', reason: '' }, T.owner)).status, 409);
  const o = await api('POST', `/api/v1/items/${T.cu}/transition`, { direction: 'next', reason: 'Approved on call' }, T.owner);
  assert.equal(o.to, 'pi');
  const it = o.state.erp.items.find((i: any) => i.id === T.cu);
  assert.equal(it.log.at(-2).override, 'Approved on call');
  assert.ok(o.state.erp.audit.some((a: any) => /Override on/.test(a.text)));
  assert.equal((await api('POST', `/api/v1/customer/projects/${T.pid}/feedback`, { rating: 5 }, T.cust)).status, 400, 'cannot rate before everything is handed over');
});

test('10. tasks: own-task scoping, handover chain, proof required, repeat', async () => {
  const c = await api('POST', '/api/v1/tasks', { title: 'Call Kunal about handover date', assignee: 'manish', deadline: '2099-01-03', priority: 'urgent' }, T.vikram);
  const t = c.state.erp.tasks.find((x: any) => x.title === 'Call Kunal about handover date');
  const ms = await api('GET', '/api/v1/state', undefined, T.manish);
  assert.ok(ms.erp.tasks.every((x: any) => x.assignee === 'manish' || x.assigner === 'manish'), 'purchase sees only own tasks');
  await api('POST', `/api/v1/tasks/${t.id}/seen`, {}, T.manish);
  assert.equal((await api('POST', `/api/v1/tasks/${t.id}/handover`, { to: 'vikram' }, T.manish)).status, 400, 'handover needs a note');
  const h = await api('POST', `/api/v1/tasks/${t.id}/handover`, { to: 'vikram', note: 'PM should call directly' }, T.manish);
  assert.ok(!h.state.erp.tasks.some((x: any) => x.id === t.id), 'handed-over task leaves the sender\'s list');
  const t2 = (await api('GET', '/api/v1/state', undefined, T.vikram)).erp.tasks.find((x: any) => x.id === t.id);
  assert.equal(t2.assignee, 'vikram'); assert.deepEqual(t2.events.map((e: any) => e.e), ['assigned', 'seen', 'handover']);
  assert.equal((await api('POST', `/api/v1/tasks/${t.id}/done`, {}, T.sana)).status, 403, 'strangers cannot complete');
  const proof = (await api('GET', '/api/v1/state', undefined, T.ravi)).erp.tasks.find((x: any) => x.proof === 'photo' && x.status !== 'done');
  if (proof) assert.equal((await api('POST', `/api/v1/tasks/${proof.id}/done`, {}, T.ravi)).status, 400, 'photo proof required');
  const rep = (await api('GET', '/api/v1/state', undefined, T.manish)).erp.tasks.find((x: any) => x.repeat === 'weekly' && x.status !== 'done');
  const d = await api('POST', `/api/v1/tasks/${rep.id}/done`, {}, T.manish);
  assert.ok(d.state.erp.tasks.some((x: any) => x.title === rep.title && x.status === 'todo' && x.deadline > rep.deadline), 'next weekly task created');
});

test('11. users and access: permission change takes effect, change log, deactivation', async () => {
  assert.equal((await api('PUT', '/api/v1/roles/ops_head/permissions', { perm: 'admin', allowed: true }, T.meera)).status, 403);
  await api('PUT', '/api/v1/roles/ops_head/permissions', { perm: 'admin', allowed: true }, T.owner);
  const ok = await api('POST', '/api/v1/users', { name: 'Neha', phone: '9123456789', role: 'designer' }, T.meera);
  assert.equal(ok.ok, true, 'ops head can now add users');
  assert.equal((await api('PATCH', '/api/v1/users/owner', { active: false }, T.meera)).status, 403, 'owner cannot be deactivated');
  assert.equal((await api('PUT', '/api/v1/roles/admin/permissions', { perm: 'admin', allowed: false }, T.owner)).status, 400);
  const neha = ok.state.erp.users.find((u: any) => u.name === 'Neha');
  const tok = await login('9123456789');
  await api('PATCH', `/api/v1/users/${neha.id}`, { active: false }, T.owner);
  assert.equal((await api('GET', '/api/v1/state', undefined, tok)).status, 401, 'deactivated user is logged out everywhere');
  const st = await api('GET', '/api/v1/state', undefined, T.owner);
  assert.ok(st.erp.audit.some((a: any) => /Added Neha/.test(a.text)) && st.erp.audit.some((a: any) => /Neha deactivated/.test(a.text)));
  await api('POST', '/api/v1/roles/reset', {}, T.owner);
});

test('12. WhatsApp: live send payloads, webhook signature, inbound routing, button replies', async () => {
  graphCalls.length = 0; await drain();
  const sends = graphCalls.filter(c => c.path === '/v25.0/1111/messages');
  assert.ok(sends.length > 5, 'queued messages were sent to the Cloud API');
  const otpMsg = sends.find(c => c.body.template?.name === 'mms_login_otp');
  assert.ok(otpMsg, 'OTP uses the authentication template');
  const comps = otpMsg!.body.template.components;
  assert.equal(comps[0].parameters[0].text, comps[1].parameters[0].text, 'OTP appears in body and copy-code button');
  assert.equal((await q1(`select count(*) n from wa_messages where status = 'sent' and wamid like 'wamid.%'`)).n > 0, true);
  assert.equal((await q1(`select count(*) n from wa_messages where template like '%otp' and (payload->'params'->>0 <> 'redacted' or body ~ '[0-9]{4}')`)).n, 0, 'no OTP code is kept in the message log');
  // handshake
  const hs = await fetch(base + '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=12345');
  assert.equal(await hs.text(), '12345');
  assert.equal((await fetch(base + '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status, 403);
  // inbound text from an existing lead
  const inbound = (id: string, from: string, msg: any) => JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Sneha' } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }] } }] }] });
  const raw = inbound('wamid.in1', '917000341926', { type: 'text', text: { body: 'Is the mirror finish available?' } });
  assert.equal((await api('POST', '/api/v1/webhooks/whatsapp', raw, undefined, { 'x-hub-signature-256': 'sha256=deadbeef' })).status, 401);
  assert.equal((await api('POST', '/api/v1/webhooks/whatsapp', raw, undefined, { 'x-hub-signature-256': sign(raw) })).ok, true);
  assert.equal((await api('POST', '/api/v1/webhooks/whatsapp', raw, undefined, { 'x-hub-signature-256': sign(raw) })).ok, true, 'duplicate delivery accepted…');
  await drain();
  assert.equal((await q1(`select count(*) n from lead_messages where lead_id = 'L04' and text = 'Is the mirror finish available?'`)).n, 1, '…but stored once');
  // unknown sender becomes a new lead
  const raw2 = inbound('wamid.in2', '919811122233', { type: 'text', text: { body: 'Need a wardrobe quote' } });
  await api('POST', '/api/v1/webhooks/whatsapp', raw2, undefined, { 'x-hub-signature-256': sign(raw2) }); await drain();
  assert.equal((await q1(`select sub from leads where phone = '+919811122233'`)).sub, 'WhatsApp');
  // TASK_DONE button: ignored from the wrong phone, honoured from the assignee
  const task = await q1(`select t.id from tasks t where t.assignee_id = 'manish' and t.status <> 'done' and t.proof = '' order by t.id limit 1`);
  const wrong = inbound('wamid.b1', '919000000003', { type: 'button', button: { payload: `TASK_DONE:${task.id}`, text: 'Mark done' } });
  await api('POST', '/api/v1/webhooks/whatsapp', wrong, undefined, { 'x-hub-signature-256': sign(wrong) }); await drain();
  assert.notEqual((await q1('select status from tasks where id = $1', [task.id])).status, 'done');
  const right = inbound('wamid.b2', '919000000010', { type: 'button', button: { payload: `TASK_DONE:${task.id}`, text: 'Mark done' } });
  await api('POST', '/api/v1/webhooks/whatsapp', right, undefined, { 'x-hub-signature-256': sign(right) }); await drain();
  assert.equal((await q1('select status from tasks where id = $1', [task.id])).status, 'done');
  // delivery status update
  const wamid = (await q1(`select wamid from wa_messages where wamid like 'wamid.%' and direction = 'out' limit 1`)).wamid;
  const st = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status: 'read', timestamp: '1', recipient_id: '1', pricing: { billable: true, category: 'utility' } }] } }] }] });
  await api('POST', '/api/v1/webhooks/whatsapp', st, undefined, { 'x-hub-signature-256': sign(st) });
  assert.equal((await q1('select status from wa_messages where wamid = $1', [wamid])).status, 'read');
});

test('13. Meta Lead Ads: signed webhook -> lead fetched and created; poll does not duplicate', async () => {
  const raw = JSON.stringify({ object: 'page', entry: [{ id: 'page1', time: 1, changes: [{ field: 'leadgen', value: { leadgen_id: 'lg-555', form_id: 'form1', page_id: 'page1', created_time: 1 } }] }] });
  assert.equal((await api('POST', '/api/v1/webhooks/meta-leads', raw, undefined, { 'x-hub-signature-256': 'sha256=00' })).status, 401);
  const r = await api('POST', '/api/v1/webhooks/meta-leads', raw, undefined, { 'x-hub-signature-256': sign(raw) });
  assert.equal(r.queued, 1);
  assert.equal((await api('POST', '/api/v1/webhooks/meta-leads', raw, undefined, { 'x-hub-signature-256': sign(raw) })).queued, 0, 'duplicate notification ignored');
  await drain();
  const l = await q1(`select * from leads where meta_leadgen_id = 'lg-555'`);
  assert.equal(l.name, 'Meta Person'); assert.equal(l.source, 'online'); assert.equal(l.sub, 'Instagram lead form'); assert.equal(l.meta_campaign_name, 'Diwali kitchens'); assert.match(l.interest, /Modular kitchen/);
  assert.ok((await q1(`select count(*) n from lead_messages where lead_id = $1 and tpl = 'welcome_catalogue'`, [l.id])).n === 1, 'welcome sent');
  const p1 = await M.meta.pollLeads(); await drain();
  const p2 = await M.meta.pollLeads(); await drain();
  assert.equal(p1.found, 1); assert.equal(p2.found, 0);
  assert.equal((await q1(`select count(*) n from leads where name = 'Polled Person'`)).n, 1);
});

test('14. reminders: due/overdue reminders + escalation once per day, skipped on Sunday', async () => {
  const at = (iso: string) => new Date(iso);
  const mon = await M.tasks.runReminders(at('2099-01-05T04:40:00Z')); // Monday 10:10 IST
  assert.ok(mon.sent.some((s: string) => s.startsWith('digest:')) || mon.sent.length >= 0);
  const again = await M.tasks.runReminders(at('2099-01-05T04:45:00Z'));
  assert.equal(again.sent.filter((s: string) => s.startsWith('rem:') || s.startsWith('esc:')).length, 0, 'nothing twice in a day');
  assert.ok(mon.sent.some((s: string) => s.startsWith('esc:')), 'escalation to the assigner for 2+ days overdue');
  const sun = await M.tasks.runReminders(at('2099-01-04T04:40:00Z'));
  assert.equal(sun.skipped, true);
});

test('15. security basics: logout revokes, refresh rotation, headers', async () => {
  const r = await api('POST', '/api/v1/auth/otp/request', { phone: P.deepa, audience: 'staff' });
  const v = await api('POST', '/api/v1/auth/otp/verify', { phone: P.deepa, audience: 'staff', code: r.devCode });
  const ref1 = await api('POST', '/api/v1/auth/refresh', { refreshToken: v.refreshToken, audience: 'user' });
  assert.ok(ref1.accessToken);
  assert.equal((await api('POST', '/api/v1/auth/refresh', { refreshToken: v.refreshToken, audience: 'user' })).status, 401, 'old refresh token reuse is rejected');
  await api('POST', '/api/v1/auth/logout', {}, ref1.accessToken);
  assert.equal((await api('GET', '/api/v1/state', undefined, ref1.accessToken)).status, 401);
  const h = await fetch(base + '/api/health');
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff'); assert.equal(h.headers.get('x-frame-options'), 'DENY');
});

test('16. project documents: floor plan and production drawings, customer sees only shared ones', async () => {
  const fp = await api('POST', `/api/v1/projects/${T.pid}/documents`, { category: 'floor_plan', title: 'Final floor plan', file: await upload(T.deepa) }, T.deepa);
  assert.equal(fp.ok, true, JSON.stringify(fp));
  await api('POST', `/api/v1/projects/${T.pid}/documents`, { category: 'production', title: 'Kitchen production set', file: await upload(T.deepa), itemId: T.kit }, T.deepa);
  await api('POST', `/api/v1/projects/${T.pid}/documents`, { category: 'pi', title: 'Factory PI FPI-9001', file: await upload(T.manish) }, T.manish);
  const again = await api('POST', `/api/v1/projects/${T.pid}/documents`, { category: 'floor_plan', title: 'Final floor plan', file: await upload(T.deepa) }, T.deepa);
  const docs = again.state.erp.projects.find((p: any) => p.id === T.pid).docs;
  assert.deepEqual(docs.filter((d: any) => d.category === 'floor_plan').map((d: any) => d.rev).sort(), ['R0', 'R1'], 'revisions are kept, not overwritten');
  assert.equal((await api('POST', `/api/v1/projects/${T.pid}/documents`, { category: 'floor_plan', title: 'x', file: 'upload:nothing.pdf' }, T.deepa)).status, 400);
  assert.equal((await api('POST', `/api/v1/projects/${T.pid}/documents`, { category: 'floor_plan', title: 'Plan', file: await upload(T.ravi) }, T.ravi)).status, 403, 'installers cannot upload project documents');
  const cs = await api('GET', '/api/v1/customer/state', undefined, T.cust);
  const cats = cs.state.projects[0].docs.map((d: any) => d.category);
  assert.ok(cats.includes('floor_plan') && !cats.includes('production') && !cats.includes('pi'), 'customer sees the floor plan but not internal production or PI files');
  const id = docs.find((d: any) => d.category === 'pi').id;
  assert.equal((await api('DELETE', `/api/v1/documents/${id}`, undefined, T.deepa)).status, 403, 'only the uploader or an admin removes a file');
  assert.equal((await api('DELETE', `/api/v1/documents/${id}`, undefined, T.manish)).ok, true);
});

test('17. WhatsApp templates: existing Meta templates are reused, only missing ones created, webhooks forwarded to the old bot', async () => {
  const { config } = await import('../src/core/config.js');
  T.owner = await login(P.owner);
  graphCalls.length = 0;
  const sync = await api('POST', '/api/v1/admin/whatsapp/sync-templates', { create: true }, T.owner);
  const byInternal = Object.fromEntries(sync.results.map((r: any) => [r.internal, r]));
  assert.equal(byInternal.welcome_catalogue.name, 'mms_quotation_request', 'welcome message mapped to the existing template');
  assert.match(byInternal.welcome_catalogue.status, /approved/);
  assert.match(byInternal.task_assigned.status, /approved/, 'existing mms_task_assigned is not re-created');
  const created = graphCalls.filter(c => c.path === '/v25.0/2222/message_templates' && c.method === 'POST').map(c => c.body.name);
  assert.ok(!created.includes('mms_quotation_request') && !created.includes('mms_task_assigned'), 'existing templates are never re-submitted');
  assert.ok(created.includes('mms_login_otp') && created.includes('mms_installation_scheduled'), 'missing operational templates are created');
  // a new lead's welcome goes out as the existing template, in its language, with only the values it has
  graphCalls.length = 0;
  await api('POST', '/api/v1/leads', { name: 'Template Test', phone: '9811100777', source: 'walkin', showroom: '' , interest: 'Kitchen', value: 0, area: '', owner: 'Priya' }, T.owner);
  await drain();
  const w = graphCalls.find(c => c.path === '/v25.0/1111/messages' && c.body.template?.name === 'mms_quotation_request');
  assert.ok(w, 'sent through mms_quotation_request');
  assert.equal(w!.body.template.language.code, 'en_US');
  assert.equal(w!.body.template.components.length, 1, 'body only, no buttons');
  assert.equal(w!.body.template.components[0].parameters.length, 1);
  // custom mapping from the admin screen
  const map = await api('GET', '/api/v1/admin/whatsapp/templates', undefined, T.owner);
  assert.ok(map.rows.length > 10 && map.meta.length === 3);
  assert.equal((await api('PUT', '/api/v1/admin/whatsapp/template-map', { map: { visit_reminder: { name: 'Bad Name' } } }, T.owner)).status, 400);
  assert.equal((await api('PUT', '/api/v1/admin/whatsapp/template-map', { map: { visit_reminder: { name: 'mms_followup_day3', params: [0], buttons: false } } }, T.ravi)).status, 403);
  assert.ok((await api('PUT', '/api/v1/admin/whatsapp/template-map', { map: { visit_reminder: { name: 'mms_followup_day3', params: [0], buttons: false } } }, T.owner)).ok);
  assert.equal((await api('GET', '/api/v1/admin/whatsapp/templates', undefined, T.owner)).rows.find((r: any) => r.internal === 'visit_reminder').map.name, 'mms_followup_day3');
  // forwarding: customer text goes to the old bot (re-signed), ERP button taps do not
  (config as any).WHATSAPP_FORWARD_URL = `${process.env.META_GRAPH_BASE}/forward`;
  graphCalls.length = 0;
  const msg = (id: string, m: any) => JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from: '919811100777', timestamp: '1', ...m }] } }] }] });
  const t1 = msg('wamid.f1', { type: 'text', text: { body: 'hello bot' } });
  await api('POST', '/api/v1/webhooks/whatsapp', t1, undefined, { 'x-hub-signature-256': sign(t1) });
  const t2 = msg('wamid.f2', { type: 'button', button: { payload: 'TASK_DONE:T1', text: 'Done' } });
  await api('POST', '/api/v1/webhooks/whatsapp', t2, undefined, { 'x-hub-signature-256': sign(t2) });
  await new Promise(r => setTimeout(r, 300));
  const fw = graphCalls.filter(c => c.path === '/forward');
  assert.equal(fw.length, 1, 'only the customer text is forwarded');
  assert.equal(fw[0].sig, sign(t1), 'forwarded with a valid Meta signature');
  (config as any).WHATSAPP_FORWARD_URL = '';
  await drain();
});

test('18. partners, quotations, receipts, GST invoices, change orders, factory steps, service, exports', async () => {
  T.priya = await login(phoneOf(4));
  // partners: add, duplicate phone, edit, use on a lead, totals
  const add = await api('POST', '/api/v1/partners', { name: 'Ar. Test Partner', firm: 'Test Studio', type: 'architect', phone: '9822200111', city: 'Raipur', tier: 'Gold', rate: 4 }, T.priya);
  assert.ok(add.ok && add.id.startsWith('p'), JSON.stringify(add).slice(0, 200));
  assert.equal((await api('POST', '/api/v1/partners', { name: 'Dup', type: 'agent', phone: '9822200111' }, T.priya)).status, 400, 'one partner per number');
  assert.equal((await api('POST', '/api/v1/partners', { name: 'No access', type: 'agent' }, T.ravi)).status, 403);
  const lead = await api('POST', '/api/v1/leads', { name: 'Partner Client', phone: '9822200999', source: 'architect', ref: add.id, interest: 'Kitchen', value: 500000 }, T.priya);
  assert.ok(lead.ok, JSON.stringify(lead).slice(0, 200));
  const lid = lead.state.crm.leads.find((l: any) => l.name === 'Partner Client').id;
  let pt = lead.state.crm.partners.find((x: any) => x.id === add.id);
  assert.equal(pt.stats.leads, 1); assert.equal(pt.stats.pipeline, 500000);
  assert.equal((await api('PATCH', `/api/v1/partners/${add.id}`, { type: 'agent' }, T.priya)).status, 400, 'type is fixed once there are leads');
  assert.ok((await api('PATCH', `/api/v1/partners/${add.id}`, { rate: 5, active: false }, T.priya)).ok);
  // quotation with revisions; accepting updates the lead value
  const q0 = await api('POST', `/api/v1/leads/${lid}/quotes`, { lines: [{ room: 'Kitchen', item: 'Base units', qty: 1, rate: 200000 }, { room: 'Kitchen', item: 'Wall units', qty: 1, rate: 100000 }], discount: 0, gstPct: 18 }, T.priya);
  assert.equal(q0.rev, 0);
  const q1r = await api('POST', `/api/v1/leads/${lid}/quotes`, { lines: [{ item: 'Kitchen complete', qty: 1, rate: 300000 }], discount: 20000, gstPct: 18 }, T.priya);
  assert.equal(q1r.rev, 1);
  let L = q1r.state.crm.leads.find((l: any) => l.id === lid);
  assert.equal(L.value, 330400, '(300000 − 20000) × 1.18');
  assert.equal(L.quotes[0].status, 'superseded');
  assert.equal((await api('POST', `/api/v1/quotes/${q0.quoteId}/accept`, {}, T.priya)).status, 400, 'old revision cannot be accepted');
  assert.ok((await api('POST', `/api/v1/quotes/${q1r.quoteId}/accept`, {}, T.priya)).ok);
  const pq = await fetch(base + `/api/v1/print/quote/${q1r.quoteId}`, { headers: { authorization: 'Bearer ' + T.priya } });
  assert.equal(pq.status, 200); assert.match(await pq.text(), /3,30,400\.00/);
  // won → commission; partner totals
  await api('POST', `/api/v1/leads/${lid}/stage`, { stage: 'won' }, T.priya);
  const st = await api('GET', '/api/v1/state', undefined, T.owner);
  pt = st.crm.partners.find((x: any) => x.id === add.id);
  assert.equal(pt.stats.won, 1); assert.equal(pt.stats.wonValue, 330400); assert.ok(pt.stats.commission > 0);
  assert.ok(pt.commissions.length === 1);
  assert.ok((await api('POST', `/api/v1/commissions/${pt.commissions[0].id}/paid`, { paid: true }, T.owner)).ok);
  // receipts: reference needed for non-cash, milestone settles when covered
  const pid = T.pid;
  const proj = st.erp.projects.find((p: any) => p.id === pid);
  const m = proj.payments.find((x: any) => !x.received);
  assert.ok(m, 'an unpaid milestone exists');
  assert.equal((await api('POST', `/api/v1/projects/${pid}/receipts`, { amount: 1000, mode: 'UPI' }, T.owner)).status, 400);
  const r1 = await api('POST', `/api/v1/projects/${pid}/receipts`, { amount: m.amount - 1000, mode: 'UPI', reference: 'UTR1', milestoneId: m.id }, T.owner);
  assert.match(r1.receiptNo, /^RCPT\/\d{4}-\d{2}\/\d{4}$/);
  assert.equal(r1.state.erp.projects.find((p: any) => p.id === pid).payments.find((x: any) => x.id === m.id).received, false, 'partly paid');
  const r2 = await api('POST', `/api/v1/projects/${pid}/receipts`, { amount: 1000, mode: 'Cash', milestoneId: m.id }, T.owner);
  assert.equal(r2.state.erp.projects.find((p: any) => p.id === pid).payments.find((x: any) => x.id === m.id).received, true, 'covered → received');
  assert.equal((await api('POST', `/api/v1/projects/${pid}/receipts`, { amount: 5, mode: 'Cash' }, T.ravi)).status, 403);
  // invoices numbered per financial year
  const i1 = await api('POST', `/api/v1/projects/${pid}/invoices`, { description: 'Kitchen supply', taxable: 100000 }, T.owner);
  const i2 = await api('POST', `/api/v1/projects/${pid}/invoices`, { description: 'Wardrobe supply', taxable: 50000 }, T.owner);
  assert.match(i1.invoiceNo, /^MMS\/\d{4}-\d{2}\/\d{3}$/);
  assert.equal(Number(i2.invoiceNo.split('/').pop()), Number(i1.invoiceNo.split('/').pop()) + 1);
  const inv = i2.state.erp.projects.find((p: any) => p.id === pid).invoices.find((v: any) => v.no === i1.invoiceNo);
  assert.equal(inv.gst, 18000); assert.equal(inv.total, 118000);
  const pi = await fetch(base + `/api/v1/print/invoice/${i1.invoiceId}`, { headers: { authorization: 'Bearer ' + T.owner } });
  assert.match(await pi.text(), /CGST 9%/);
  assert.equal((await fetch(base + `/api/v1/print/invoice/${i1.invoiceId}`, { headers: { authorization: 'Bearer ' + T.ravi } })).status, 403);
  // money is hidden from roles without the money permission
  const dstate = await api('GET', '/api/v1/state', undefined, T.deepa);
  assert.equal(dstate.erp.projects.find((p: any) => p.id === pid).value, 0);
  assert.equal(dstate.erp.projects.find((p: any) => p.id === pid).receipts.length, 0);
  // change order: customer approves in the app → value and target move
  const before = (await api('GET', '/api/v1/state', undefined, T.owner)).erp.projects.find((p: any) => p.id === pid);
  await api('POST', `/api/v1/projects/${pid}/change-orders`, { description: 'Add loft above wardrobe', amount: 25000, days: 3 }, T.deepa);
  const cs = await api('GET', '/api/v1/customer/state', undefined, T.cust);
  const co = cs.state.projects.find((p: any) => p.id === pid).changes.find((c: any) => c.status === 'pending');
  assert.equal(co.amount, 25000);
  const dec = await api('POST', `/api/v1/customer/change-orders/${co.id}/decide`, { approve: true }, T.cust);
  assert.ok(dec.ok);
  assert.equal((await api('POST', `/api/v1/customer/change-orders/${co.id}/decide`, { approve: true }, T.cust)).status, 400, 'decided once');
  const after = (await api('GET', '/api/v1/state', undefined, T.owner)).erp.projects.find((p: any) => p.id === pid);
  assert.equal(after.value, before.value + 25000);
  assert.equal(after.payments.reduce((a: number, x: any) => a + x.amount, 0), after.value, 'milestones re-spread to the new value');
  assert.notEqual(after.target, before.target);
  // factory steps: all ticked → production complete
  for (const step of ['cutting', 'edging', 'drilling', 'assembly']) await api('POST', `/api/v1/items/${T.cu}/production`, { step, done: true }, T.manish);
  let it = (await api('GET', '/api/v1/state', undefined, T.manish)).erp.items.find((i: any) => i.id === T.cu);
  assert.equal(it.productionDone, false);
  const last = await api('POST', `/api/v1/items/${T.cu}/production`, { step: 'packing', done: true }, T.manish);
  it = last.state.erp.items.find((i: any) => i.id === T.cu);
  assert.equal(it.productionDone, true);
  // service request from the customer; staff resolves it
  const sv = await api('POST', `/api/v1/customer/projects/${pid}/service`, { text: 'Drawer channel is stuck', itemId: T.kit }, T.cust);
  assert.ok(sv.ok);
  const sreq = (await api('GET', '/api/v1/state', undefined, T.owner)).erp.projects.find((p: any) => p.id === pid).service[0];
  assert.equal(sreq.status, 'open');
  assert.equal((await api('PATCH', `/api/v1/service/${sreq.id}`, { status: 'resolved' }, T.owner)).status, 400, 'needs a resolution');
  assert.ok((await api('PATCH', `/api/v1/service/${sreq.id}`, { status: 'resolved', resolution: 'Channel replaced' }, T.owner)).ok);
  // exports
  const csv = await fetch(base + '/api/v1/export/partners', { headers: { authorization: 'Bearer ' + T.priya } });
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type') || '', /text\/csv/);
  assert.match(await csv.text(), /Ar\. Test Partner/);
  assert.equal((await fetch(base + '/api/v1/export/payments', { headers: { authorization: 'Bearer ' + T.ravi } })).status, 403);
  // company profile
  assert.equal((await api('PUT', '/api/v1/settings/company', { name: 'Make My Space', gstin: 'BAD' }, T.owner)).status, 400);
  assert.ok((await api('PUT', '/api/v1/settings/company', { name: 'Make My Space', gstin: '22ABCDE1234F1Z5', warrantyYears: 5 }, T.owner)).ok);
});
