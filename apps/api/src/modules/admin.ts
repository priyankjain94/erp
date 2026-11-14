import { z } from 'zod';
import { config } from '../core/config.js';
import { db, one, tx, type Q } from '../core/db.js';
import { parse, type Ctx, type Router } from '../core/http.js';
import { bad, forbidden, normPhone, notFound, slug } from '../core/util.js';
import { DEFAULT_ROLES, PERMS, ROLE_IDS, ROLES, TYPE_IDS, WA_TEMPLATES } from '../domain.js';
import { syncTemplates, sendTemplate, templateMap, saveTemplateMap, metaTemplates, fetchMetaTemplates, DEFAULT_TEMPLATE_MAP } from '../integrations/whatsapp.js';
import { subscribePage, pollLeads } from '../integrations/metaLeads.js';
import { demoActive, metaLeadsLive, waVerifyToken } from '../core/config.js';
import { log } from '../core/util.js';
import { audit, invalidatePerms, revokeAllSessions, signupRules, staff, userOf } from './auth.js';
import { staffState } from './state.js';
import { bootstrap, seedDemo, wipe } from '../seed.js';
import { many } from '../core/db.js';
import { prettyPhone } from '../core/util.js';

const roleName = (r: string) => ROLES.find(x => x.id === r)?.name || r;
const done = async (ctx: Ctx, extra: Record<string, unknown> = {}) => ({ ok: true, ...extra, state: await staffState(userOf(ctx)) });

async function uniqueId(q: Q, name: string) {
  const base = slug(name); let id = base, n = 1;
  while (await one(q, 'select 1 from users where id = $1', [id])) id = base + (++n);
  return id;
}
async function phoneFree(q: Q, phone: string, exceptId?: string) {
  const u = await one(q, 'select id, name from users where phone = $1', [phone]);
  if (u && u.id !== exceptId) throw bad(`This number is already used by ${u.name}.`);
}
export async function createUser(q: Q, by: ReturnType<typeof userOf> | null, f: { name: string; phone: string; role: string; title?: string; members?: string[]; skills?: string[] }) {
  const phone = normPhone(f.phone); if (!phone) throw bad('Enter a 10-digit WhatsApp number.');
  await phoneFree(q, phone);
  const id = await uniqueId(q, f.name);
  await q.query('insert into users(id, name, phone, role, title, members, skills) values ($1,$2,$3,$4,$5,$6,$7)', [id, f.name.trim(), phone, f.role, f.title || '', f.members || [], f.skills || []]);
  await sendTemplate(phone, 'staff_invite', [f.name.trim(), roleName(f.role), config.APP_BASE_URL], { q, related: { type: 'user', id } });
  if (by) await audit(q, by, 'user.create', `Added ${f.name.trim()} as ${roleName(f.role)}`, 'user', id);
  return id;
}

const UserZ = z.object({ name: z.string().trim().min(2).max(80), phone: z.string(), role: z.enum(ROLE_IDS), title: z.string().max(80).default('') });
const TeamZ = z.object({ name: z.string().trim().min(2).max(80), phone: z.string(), members: z.array(z.string().trim().min(1).max(60)).max(20).default([]), skills: z.array(z.enum(TYPE_IDS)).min(1).default([...TYPE_IDS]) });
const teamTitle = (members: string[]) => `Installation lead · team of ${members.length + 1}`;

export function adminRoutes(r: Router) {
  r.get('/api/v1/state', staff(), async ctx => staffState(userOf(ctx)));

  r.post('/api/v1/users', staff('admin'), async ctx => {
    const b = parse(UserZ, ctx.body);
    await tx(q => createUser(q, userOf(ctx), b));
    return done(ctx);
  });
  r.patch('/api/v1/users/:id', staff('admin'), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ role: z.enum(ROLE_IDS).optional(), active: z.boolean().optional(), name: z.string().trim().min(2).max(80).optional(), title: z.string().max(80).optional(), phone: z.string().optional(), email: z.string().trim().toLowerCase().max(120).regex(/^$|^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Enter a valid email.').optional() }).strict(), ctx.body);
    await tx(async q => {
      const u = await one(q, 'select * from users where id = $1 for update', [ctx.params.id]); if (!u) throw notFound();
      const self = u.id === p.user.id;
      if ((b.role && b.role !== u.role || b.active === false) && (self || u.id === 'owner' || u.id === 'superadmin' || u.phone === normPhone(config.ADMIN_PHONE))) throw forbidden('You cannot change your own role or deactivate yourself, the owner or the super admin.');
      if (b.role && b.role !== u.role) { await q.query('update users set role = $2 where id = $1', [u.id, b.role]); await audit(q, p, 'user.role', `${u.name}: role ${roleName(u.role)} → ${roleName(b.role)}`, 'user', u.id); }
      if (b.active !== undefined && b.active !== u.active) {
        await q.query('update users set active = $2 where id = $1', [u.id, b.active]);
        if (!b.active) await revokeAllSessions(q, 'user', u.id);
        await audit(q, p, 'user.active', `${u.name} ${b.active ? 'reactivated' : 'deactivated'}`, 'user', u.id);
      }
      if (b.name || b.title !== undefined) await q.query('update users set name = coalesce($2, name), title = coalesce($3, title) where id = $1', [u.id, b.name || null, b.title ?? null]);
      if (b.email !== undefined) {
        if (b.email && await one(q, 'select 1 from users where lower(email) = $1 and id <> $2', [b.email, u.id])) throw bad('Another user already has this email.');
        await q.query('update users set email = $2, google_sub = case when lower(coalesce(email, \'\')) = $2 then google_sub else null end where id = $1', [u.id, b.email || null]);
        await audit(q, p, 'user.email', `${u.name}: Google sign-in email ${b.email ? 'set' : 'removed'}`, 'user', u.id);
      }
      if (b.phone) { const ph = normPhone(b.phone); if (!ph) throw bad('Enter a 10-digit number.'); await phoneFree(q, ph, u.id); await q.query('update users set phone = $2 where id = $1', [u.id, ph]); await revokeAllSessions(q, 'user', u.id); }
    });
    return done(ctx);
  });

  /* installation teams = installer users with helpers + skills */
  r.post('/api/v1/teams', staff('assign'), async ctx => {
    const b = parse(TeamZ, ctx.body);
    await tx(async q => {
      const id = await createUser(q, null, { name: b.name, phone: b.phone, role: 'installer', title: teamTitle(b.members), members: b.members, skills: b.skills.length === TYPE_IDS.length ? [] : b.skills });
      await audit(q, userOf(ctx), 'team.create', `Installation team ${b.name} added (${b.members.length + 1} people)`, 'user', id);
    });
    return done(ctx);
  });
  r.patch('/api/v1/teams/:id', staff('assign'), async ctx => {
    const p = userOf(ctx); const b = parse(TeamZ.partial().extend({ active: z.boolean().optional() }), ctx.body);
    await tx(async q => {
      const u = await one(q, `select * from users where id = $1 and role = 'installer' for update`, [ctx.params.id]); if (!u) throw notFound('Team not found');
      const members = b.members ?? u.members;
      let phone = u.phone;
      if (b.phone) { phone = normPhone(b.phone); if (!phone) throw bad('Enter a 10-digit number.'); await phoneFree(q, phone, u.id); }
      const skills = b.skills ? (b.skills.length === TYPE_IDS.length ? [] : b.skills) : u.skills;
      await q.query('update users set name = $2, phone = $3, members = $4, skills = $5, title = $6, active = coalesce($7, active) where id = $1', [u.id, b.name || u.name, phone, members, skills, teamTitle(members), b.active ?? null]);
      if (b.active === false) { await revokeAllSessions(q, 'user', u.id); await audit(q, p, 'team.deactivate', `Installation team ${u.name} deactivated`, 'user', u.id); }
      else await audit(q, p, 'team.update', `Installation team ${b.name || u.name} updated (${members.length + 1} people)`, 'user', u.id);
    });
    return done(ctx);
  });

  r.put('/api/v1/roles/:role/permissions', staff('admin'), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ perm: z.enum(PERMS), allowed: z.boolean() }), ctx.body);
    if (!ROLE_IDS.includes(ctx.params.role as any)) throw notFound('Unknown role');
    if (ctx.params.role === 'admin') throw bad('Owner / Admin always has full access.');
    await tx(async q => {
      await q.query('insert into role_permissions(role, perm, allowed) values ($1,$2,$3) on conflict (role, perm) do update set allowed = excluded.allowed', [ctx.params.role, b.perm, b.allowed]);
      await audit(q, p, 'role.perm', `${roleName(ctx.params.role)}: ${b.allowed ? 'allowed' : 'removed'} “${b.perm}”`, 'role', ctx.params.role);
    });
    invalidatePerms();
    return done(ctx);
  });
  r.post('/api/v1/roles/reset', staff('admin'), async ctx => {
    await tx(async q => {
      await q.query('delete from role_permissions');
      for (const [role, perms] of Object.entries(DEFAULT_ROLES)) for (const [perm, allowed] of Object.entries(perms)) await q.query('insert into role_permissions values ($1,$2,$3)', [role, perm, allowed]);
      await audit(q, userOf(ctx), 'role.reset', 'Access matrix reset to defaults');
    });
    invalidatePerms();
    return done(ctx);
  });

  r.get('/api/v1/settings/holidays', staff(), async () => ({ holidays: (await one(db, `select value from settings where key = 'holidays'`))?.value || [] }));
  r.put('/api/v1/settings/holidays', staff('admin'), async ctx => {
    const b = parse(z.object({ holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100) }), ctx.body);
    await db.query(`insert into settings(key, value) values ('holidays', $1) on conflict (key) do update set value = excluded.value`, [JSON.stringify(b.holidays)]);
    return { ok: true };
  });

  r.get('/api/v1/admin/integrations', staff('admin'), async () => {
    const wa = await one(db, `select count(*) filter (where status = 'failed') failed, count(*) filter (where status = 'simulated') simulated, count(*) filter (where status in ('sent','delivered','read')) sent, max(created_at) last from wa_messages where direction = 'out'`);
    const leads = await one(db, `select count(*) n, max(created_at) last from meta_leads_raw`);
    const jobs = await one(db, `select count(*) filter (where done_at is null) pending, count(*) filter (where done_at is not null and last_error is not null and attempts >= max_attempts) dead from jobs`);
    return {
      whatsapp: { live: !!config.WHATSAPP_ACCESS_TOKEN, phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID ? '…' + config.WHATSAPP_PHONE_NUMBER_ID.slice(-4) : '', wabaId: config.WHATSAPP_WABA_ID ? '…' + config.WHATSAPP_WABA_ID.slice(-4) : '', appSecret: !!config.META_APP_SECRET, verifyToken: waVerifyToken(), forwardUrl: config.WHATSAPP_FORWARD_URL, lang: config.WHATSAPP_TEMPLATE_LANG, webhook: `${config.APP_BASE_URL}/api/v1/webhooks/whatsapp`, last30: wa,
        recentFailures: await many(db, `select template, error, created_at from wa_messages where direction = 'out' and status = 'failed' order by id desc limit 5`) },
      metaLeads: { live: !!config.META_PAGE_ACCESS_TOKEN, pageId: config.META_PAGE_ID, webhook: `${config.APP_BASE_URL}/api/v1/webhooks/meta-leads`, received: leads },
      jobs, graphVersion: config.META_GRAPH_VERSION
    };
  });
  /* sign-up requests */
  /* sign-up rules (admins) */
  r.get('/api/v1/settings/signup', staff('people'), async () => ({ signup: await signupRules() }));
  r.put('/api/v1/settings/signup', staff('admin'), async ctx => {
    const b = parse(z.object({ mode: z.enum(['approval', 'open', 'closed']), defaultRole: z.enum(ROLE_IDS).refine(r => r !== 'admin', 'New sign-ups can never start as admin.'), domains: z.array(z.string().trim().toLowerCase().regex(/^@?[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter domains like makemyspace.in')).max(10).default([]) }), ctx.body);
    const domains = b.domains.map(d => d.replace(/^@/, '')).filter(d => !['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'].includes(d));
    await db.query(`insert into settings(key, value) values ('signup', $1) on conflict (key) do update set value = excluded.value`, [JSON.stringify({ ...b, domains })]);
    await audit(db, userOf(ctx), 'signup.rules', `Sign-up rules: ${b.mode}, new people start as ${roleName(b.defaultRole)}${domains.length ? ', auto-join for ' + domains.join(', ') : ''}`, 'settings', 'signup');
    return done(ctx, { signup: await signupRules() });
  });
  /* people with 'people' may give a role to a new member (never admin unless they are admin) */
  r.post('/api/v1/users/:id/assign-role', staff('people'), async ctx => {
    const b = parse(z.object({ role: z.enum(ROLE_IDS) }), ctx.body); const p = userOf(ctx);
    if (b.role === 'admin' && !p.perms.has('admin')) throw forbidden('Only an admin can make someone an admin.');
    await tx(async q => {
      const u = await one(q, 'select * from users where id = $1 for update', [ctx.params.id]); if (!u) throw notFound();
      if (u.role !== 'guest' && !p.perms.has('admin')) throw forbidden('You can only set the role of new members. Ask an admin to change other roles.');
      await q.query(`update users set role = $2, title = case when title like 'Wants: %' then '' else title end where id = $1`, [u.id, b.role]);
      await q.query(`update tasks set status = 'done', done_at = now() where auto and status <> 'done' and title like $1`, [`New member: ${u.name} (%`]);
      await audit(q, p, 'user.role', `${u.name}: role ${roleName(u.role)} → ${roleName(b.role)}`, 'user', u.id);
    });
    invalidatePerms();
    return done(ctx);
  });

  r.post('/api/v1/admin/access-requests/:id', staff('people'), async ctx => {
    const b = parse(z.object({ approve: z.boolean(), role: z.enum(ROLE_IDS).optional(), title: z.string().max(80).default('') }), ctx.body);
    await tx(async q => {
      const a = await one(q, `select * from access_requests where id = $1 for update`, [Number(ctx.params.id)]); if (!a) throw notFound();
      if (a.status !== 'pending') throw bad('This request was already handled.');
      let uid: string | null = null;
      if (b.approve) {
        if (!b.role) throw bad('Choose a role for this person.');
        if (b.role === 'admin' && !userOf(ctx).perms.has('admin')) throw forbidden('Only an admin can make someone an admin.');
        uid = await createUser(q, userOf(ctx), { name: a.name, phone: a.phone, role: b.role, title: b.title });
        if (a.email) await q.query('update users set email = $2, google_sub = $3 where id = $1', [uid, a.email, a.google_sub]);
      }
      await q.query(`update access_requests set status = $2, decided_by = $3, decided_at = now(), user_id = $4 where id = $1`, [a.id, b.approve ? 'approved' : 'rejected', userOf(ctx).user.id, uid]);
      await q.query(`update tasks set status = 'done', done_at = now() where auto and status <> 'done' and title like $1`, [`Access request: ${a.name} (%`]);
      if (!b.approve) await audit(q, userOf(ctx), 'access.reject', `Declined access request from ${a.name}`, 'user', String(a.id));
    });
    return done(ctx);
  });

  /* start fresh: delete all sample data and keep only the super admin (settings, roles, templates and company profile are kept) */
  r.post('/api/v1/admin/start-fresh', staff('admin'), async ctx => {
    const b = parse(z.object({ confirm: z.literal('START FRESH') }), ctx.body);
    const p = userOf(ctx);
    if (!(p.user.id === 'owner' || p.user.id === 'superadmin' || p.user.phone === normPhone(config.ADMIN_PHONE))) throw forbidden('Only the super admin can do this.');
    void b;
    await tx(async q => {
      const me = await one(q, 'select id, name, phone, email, google_sub from users where id = $1', [p.user.id]);
      await wipe(q);
      await q.query('truncate access_requests restart identity');
      await bootstrap(q);
      // whoever pressed the button always keeps access, even if ADMIN_PHONE is not set
      if (me && !(await one(q, 'select 1 from users where phone = $1', [me.phone])))
        await q.query(`insert into users(id, name, phone, role, title, email, google_sub) values ($5, $1, $2, 'admin', 'Super admin', $3, $4)`, [me.name, me.phone, me.email, me.google_sub, (await one(q, `select 1 from users where id = 'owner'`)) ? await uniqueId(q, me.name) : 'owner']);
      else if (me) await q.query('update users set email = coalesce(email, $2), google_sub = coalesce(google_sub, $3) where phone = $1', [me.phone, me.email, me.google_sub]);
    });
    log.warn('start-fresh: all sample data deleted by', p.user.name);
    return { ok: true, loggedOut: true };
  });

  /* demo-only helpers: never available unless DEMO_MODE=true and WhatsApp is not live yet */
  r.get('/api/v1/auth/demo-users', async ctx => {
    if (!demoActive()) return { users: [] };
    if (ctx.query.get('audience') === 'customer') return { users: (await many(db, 'select distinct c.name, c.phone from customers c join projects p on p.customer_id = c.id order by c.name')).map(c => ({ name: c.name, phone: prettyPhone(c.phone) })) };
    return { users: (await many(db, 'select name, role, phone from users where active order by created_at')).map(u => ({ name: u.name, role: u.role, phone: prettyPhone(u.phone) })) };
  });
  r.post('/api/v1/admin/demo-reset', staff('admin'), async () => {
    if (!demoActive()) throw forbidden('Only available in demo mode.');
    await tx(async q => { await wipe(q); await seedDemo(q); await bootstrap(q); });
    return { ok: true };
  });
  r.post('/api/v1/admin/whatsapp/sync-templates', staff('admin'), async ctx => ({ results: await syncTemplates({ create: (ctx.body as any)?.create !== false }) }));
  r.get('/api/v1/admin/whatsapp/templates', staff('admin'), async ctx => {
    if (ctx.query.get('refresh') === '1') await fetchMetaTemplates();
    const map = await templateMap(), meta = await metaTemplates();
    return { meta, defaults: DEFAULT_TEMPLATE_MAP, rows: Object.entries(WA_TEMPLATES).map(([internal, t]) => ({ internal, category: t.category, body: t.body, values: (t.body.match(/\{\{\d+\}\}/g) || []).length, map: map[internal], found: meta.filter(m => m.name === map[internal].name) })) };
  });
  r.put('/api/v1/admin/whatsapp/template-map', staff('admin'), async ctx => {
    const b = parse(z.object({ map: z.record(z.string(), z.object({ name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'Template names use lower-case letters, numbers and _'), params: z.array(z.union([z.number().int().min(0).max(9), z.string().max(200)])).max(10).optional(), buttons: z.boolean().optional() })) }), ctx.body);
    await saveTemplateMap(b.map);
    await audit(db, userOf(ctx), 'whatsapp.map', 'WhatsApp template mapping updated', 'settings', 'wa_template_map');
    return { ok: true };
  });
  r.post('/api/v1/admin/whatsapp/test', staff('admin'), async ctx => {
    const b = parse(z.object({ template: z.string(), phone: z.string() }), ctx.body);
    const t = WA_TEMPLATES[b.template]; if (!t || t.category === 'AUTHENTICATION') throw bad('Pick a non-login message to test.');
    const n = (t.body.match(/\{\{\d+\}\}/g) || []).length;
    const id = await sendTemplate(b.phone, b.template, Array.from({ length: n }, (_, i) => i === 0 ? 'Test' : 'sample ' + (i + 1)));
    if (!id) throw bad('Enter a valid WhatsApp number.');
    return { ok: true, id };
  });
  r.get('/api/v1/admin/whatsapp/messages', staff('admin'), async () => ({ messages: await many(db, `select id, direction, phone, kind, template, status, error, created_at from wa_messages order by id desc limit 40`) }));
  r.post('/api/v1/admin/meta/subscribe-page', staff('admin'), async () => { if (!metaLeadsLive()) throw bad('Set META_PAGE_ID and META_PAGE_ACCESS_TOKEN first'); return { result: await subscribePage() }; });
  r.post('/api/v1/admin/meta/poll-leads', staff('admin'), async () => { if (!metaLeadsLive()) throw bad('Set META_PAGE_ID and META_PAGE_ACCESS_TOKEN first'); return await pollLeads(); });
}
