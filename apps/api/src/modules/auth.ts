import crypto from 'node:crypto';
import { z } from 'zod';
import { config, demoActive } from '../core/config.js';
import { db, many, one, tx, type Q } from '../core/db.js';
import { parse, rateLimit, type Ctx, type Router } from '../core/http.js';
import { forbidden, HttpError, normPhone, prettyPhone, randomId, safeEqual, sha256 } from '../core/util.js';
import { DEFAULT_ROLES, PERMS, type Perm } from '../domain.js';
import { sendTemplate } from '../integrations/whatsapp.js';

export type Principal =
  | { type: 'user'; sid: string; user: { id: string; name: string; role: string; phone: string }; perms: Set<Perm> }
  | { type: 'customer'; sid: string; customer: { id: number; name: string; phone: string } };

/* ---------- JWT (HS256) ---------- */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function signJwt(payload: Record<string, unknown>, secret: string, ttlSec: number) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ ...payload, iat: now, exp: now + ttlSec });
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
export function verifyJwt(token: string, secret: string): any | null {
  const [h, b, s] = token.split('.');
  if (!h || !b || !s) return null;
  const expect = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  if (!safeEqual(expect, s)) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url').toString()); return p.exp > Date.now() / 1000 ? p : null; } catch { return null; }
}

/* ---------- permissions (cached, invalidated on change) ---------- */
let permCache: { at: number; map: Map<string, Set<Perm>> } | null = null;
export function invalidatePerms() { permCache = null; }
export async function permsFor(role: string, q: Q = db): Promise<Set<Perm>> {
  if (role === 'admin') return new Set(PERMS);
  if (!permCache || Date.now() - permCache.at > 30_000) {
    const rows = await many<{ role: string; perm: Perm; allowed: boolean }>(q, 'select role, perm, allowed from role_permissions');
    const map = new Map<string, Set<Perm>>();
    for (const r of rows) { if (!map.has(r.role)) map.set(r.role, new Set()); if (r.allowed) map.get(r.role)!.add(r.perm); }
    permCache = { at: Date.now(), map };
  }
  return permCache.map.get(role) || new Set();
}
export async function seedRolePermissions(q: Q) {
  for (const [role, perms] of Object.entries(DEFAULT_ROLES)) for (const [perm, allowed] of Object.entries(perms))
    await q.query('insert into role_permissions(role, perm, allowed) values ($1,$2,$3) on conflict do nothing', [role, perm, allowed]);
}

/* ---------- audit ---------- */
export async function audit(q: Q, p: Principal | { type: 'system' }, action: string, text: string, entity?: string, entityId?: string, data?: unknown) {
  const actorId = p.type === 'user' ? p.user.id : p.type === 'customer' ? String(p.customer.id) : null;
  await q.query('insert into audit_log(actor_type, actor_id, action, entity, entity_id, text, data) values ($1,$2,$3,$4,$5,$6,$7)',
    [p.type, actorId, action, entity || null, entityId || null, text, data ?? null]);
}

/* ---------- middleware ---------- */
function bearer(ctx: Ctx) {
  const h = String(ctx.req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
export async function authenticate(ctx: Ctx): Promise<Principal | null> {
  const p = verifyJwt(bearer(ctx), config.JWT_SECRET);
  if (!p) return null;
  const s = await one(db, 'select revoked_at, expires_at from sessions where id = $1', [p.sid]);
  if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) return null;
  if (p.typ === 'user') {
    const u = await one(db, 'select id, name, role, phone, active from users where id = $1', [p.sub]);
    if (!u || !u.active) return null;
    return { type: 'user', sid: p.sid, user: { id: u.id, name: u.name, role: u.role, phone: u.phone }, perms: await permsFor(u.role) };
  }
  if (p.typ === 'customer') {
    const c = await one(db, 'select id, name, phone from customers where id = $1', [Number(p.sub)]);
    return c ? { type: 'customer', sid: p.sid, customer: c } : null;
  }
  return null;
}
/** Staff only; optionally require one permission. */
export const staff = (perm?: Perm) => async (ctx: Ctx) => {
  const p = ctx.auth || (ctx.auth = (await authenticate(ctx)) || undefined);
  if (!p) throw new HttpError(401, 'Please log in again.', 'unauthenticated');
  if (p.type !== 'user') throw forbidden();
  if (perm && !p.perms.has(perm)) throw forbidden();
};
/** Customers, or staff previewing the customer app (needs tasksAll). */
export const customerOrPreview = async (ctx: Ctx) => {
  const p = ctx.auth || (ctx.auth = (await authenticate(ctx)) || undefined);
  if (!p) throw new HttpError(401, 'Please log in again.', 'unauthenticated');
  if (p.type === 'user' && !p.perms.has('tasksAll')) throw forbidden();
};
export const userOf = (ctx: Ctx) => { if (ctx.auth?.type !== 'user') throw forbidden(); return ctx.auth; };
export const can = (ctx: Ctx, perm: Perm) => ctx.auth?.type === 'user' && ctx.auth.perms.has(perm);

/* ---------- sessions ---------- */
async function createSession(q: Q, subjectType: 'user' | 'customer', subjectId: string, ua: string) {
  const sid = randomId(18), refresh = randomId(32);
  await q.query(`insert into sessions(id, subject_type, subject_id, refresh_hash, user_agent, expires_at) values ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)`,
    [sid, subjectType, subjectId, sha256(refresh), ua.slice(0, 200), String(config.REFRESH_TTL_DAYS)]);
  return { sid, refresh };
}
function issue(ctx: Ctx, subjectType: 'user' | 'customer', subjectId: string, sid: string, refresh: string) {
  const accessToken = signJwt({ sub: subjectId, typ: subjectType, sid }, config.JWT_SECRET, config.ACCESS_TTL_MIN * 60);
  const secure = config.APP_BASE_URL.startsWith('https') ? '; Secure' : '';
  ctx.res.setHeader('Set-Cookie', `mms_rt_${subjectType}=${sid}.${refresh}; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=${config.REFRESH_TTL_DAYS * 86400}${secure}`);
  return { accessToken, refreshToken: `${sid}.${refresh}`, expiresIn: config.ACCESS_TTL_MIN * 60 };
}
function readCookie(ctx: Ctx, name: string) {
  const m = String(ctx.req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : '';
}

/* ---------- Google ID token check (Google Identity Services, no client secret needed) ---------- */
export async function verifyGoogle(credential: string) {
  if (!config.GOOGLE_CLIENT_ID) throw new HttpError(400, 'Google sign-in is not set up yet.', 'google_off');
  const res = await fetch(`${config.GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  const t: any = res && res.ok ? await res.json().catch(() => null) : null;
  if (!t || t.aud !== config.GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(t.iss) || Number(t.exp) * 1000 < Date.now())
    throw new HttpError(401, 'Google sign-in failed. Please try again.', 'google_bad');
  if (String(t.email_verified) !== 'true') throw new HttpError(401, 'This Google account email is not verified.', 'google_unverified');
  return { sub: String(t.sub), email: String(t.email).toLowerCase(), name: String(t.name || t.email.split('@')[0]) };
}

/* ---------- OTP ---------- */
const otpHash = (phone: string, code: string) => sha256(`${config.JWT_SECRET}:${phone}:${code}`);
const genCode = () => String(crypto.randomInt(10 ** (config.OTP_LENGTH - 1), 10 ** config.OTP_LENGTH));

/** Create and send an OTP. Returns the code only in DEMO_MODE (shown on screen for demos). */
export async function issueOtp(q: Q, phone: string, audience: 'staff' | 'customer' | 'signoff', ip: string, ref?: string) {
  rateLimit('otp-phone:' + phone, 5, 3600_000);
  rateLimit('otp-ip:' + ip, 30, 3600_000);
  const code = genCode();
  await q.query(`update otp_requests set consumed_at = now() where phone = $1 and audience = $2 and consumed_at is null`, [phone, audience]);
  await q.query(`insert into otp_requests(phone, audience, ref, code_hash, expires_at, ip) values ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval, $6)`,
    [phone, audience, ref || null, otpHash(phone, code), String(config.OTP_TTL_MIN), ip]);
  await sendTemplate(phone, audience === 'signoff' ? 'install_signoff_otp' : 'login_otp', [code], { q, related: { type: 'otp', id: audience } });
  return demoActive() ? code : undefined;
}
/** Check an OTP. Throws a friendly error when wrong/expired/too many attempts. */
export async function checkOtp(q: Q, phone: string, audience: 'staff' | 'customer' | 'signoff', code: string, ref?: string) {
  const r = await one(q, `select id, code_hash, expires_at, attempts from otp_requests where phone = $1 and audience = $2 and consumed_at is null ${ref ? 'and ref = $3' : ''} order by id desc limit 1`,
    ref ? [phone, audience, ref] : [phone, audience]);
  if (!r) throw new HttpError(400, 'Please request a new code.', 'otp_missing');
  if (new Date(r.expires_at) < new Date()) throw new HttpError(400, 'That code has expired. Please request a new one.', 'otp_expired');
  if (r.attempts >= 5) throw new HttpError(429, 'Too many wrong attempts. Please request a new code.', 'otp_locked');
  if (!safeEqual(r.code_hash, otpHash(phone, String(code)))) {
    await q.query('update otp_requests set attempts = attempts + 1 where id = $1', [r.id]);
    throw new HttpError(400, 'That code does not match.', 'otp_wrong');
  }
  await q.query('update otp_requests set consumed_at = now() where id = $1', [r.id]);
}

const OtpReq = z.object({ phone: z.string(), audience: z.enum(['staff', 'customer']) });
const OtpVerify = OtpReq.extend({ code: z.string().regex(/^\d{4,8}$/) });

export function authRoutes(r: Router) {
  r.post('/api/v1/auth/otp/request', async ctx => {
    const b = parse(OtpReq, ctx.body);
    const phone = normPhone(b.phone);
    if (!phone) throw new HttpError(400, 'Enter your 10-digit mobile number.', 'bad_phone');
    if (b.audience === 'staff') {
      const u = await one(db, 'select name, active from users where phone = $1', [phone]);
      if (!u) throw new HttpError(404, 'This number is not registered. Ask your admin to add you in Users and access.', 'not_registered');
      if (!u.active) throw new HttpError(403, 'This account is deactivated. Contact your admin.', 'inactive');
      const devCode = await tx(q => issueOtp(q, phone, 'staff', ctx.ip));
      return { sent: true, name: u.name, phone: prettyPhone(phone), devCode };
    }
    const c = await one(db, `select c.name from customers c where c.phone = $1 and exists (select 1 from projects p where p.customer_id = c.id)`, [phone]);
    if (!c) throw new HttpError(404, 'No project found for this number. Please call your project manager.', 'not_registered');
    const devCode = await tx(q => issueOtp(q, phone, 'customer', ctx.ip));
    return { sent: true, name: c.name, phone: prettyPhone(phone), devCode };
  });

  r.post('/api/v1/auth/otp/verify', async ctx => {
    const b = parse(OtpVerify, ctx.body);
    const phone = normPhone(b.phone);
    rateLimit('verify-ip:' + ctx.ip, 60, 3600_000);
    return tx(async q => {
      await checkOtp(q, phone, b.audience, b.code);
      if (b.audience === 'staff') {
        const u = await one(q, 'select id, name, role, active from users where phone = $1', [phone]);
        if (!u?.active) throw forbidden('This account is deactivated.');
        const s = await createSession(q, 'user', u.id, String(ctx.req.headers['user-agent'] || ''));
        await audit(q, { type: 'user', sid: s.sid, user: { ...u, phone }, perms: new Set() }, 'login', `${u.name} logged in`, 'user', u.id);
        return { ...issue(ctx, 'user', u.id, s.sid, s.refresh), user: { id: u.id, name: u.name, role: u.role } };
      }
      const c = await one(q, 'select id, name from customers where phone = $1', [phone]);
      const s = await createSession(q, 'customer', String(c.id), String(ctx.req.headers['user-agent'] || ''));
      return { ...issue(ctx, 'customer', String(c.id), s.sid, s.refresh), customer: { id: c.id, name: c.name } };
    });
  });

  r.post('/api/v1/auth/refresh', async ctx => {
    const type = ctx.body?.audience === 'customer' ? 'customer' : 'user';
    const raw = String(ctx.body?.refreshToken || readCookie(ctx, 'mms_rt_' + type));
    const [sid, secret] = raw.split('.');
    if (!sid || !secret) throw new HttpError(401, 'Please log in again.', 'unauthenticated');
    return tx(async q => {
      const s = await one(q, 'select * from sessions where id = $1 for update', [sid]);
      if (!s || s.revoked_at || new Date(s.expires_at) < new Date() || s.subject_type !== type) throw new HttpError(401, 'Please log in again.', 'unauthenticated');
      if (!safeEqual(s.refresh_hash, sha256(secret))) {
        await q.query('update sessions set revoked_at = now() where id = $1', [sid]); // token reuse: kill the session
        throw new HttpError(401, 'Please log in again.', 'unauthenticated');
      }
      if (type === 'user') {
        const u = await one(q, 'select active from users where id = $1', [s.subject_id]);
        if (!u?.active) throw new HttpError(401, 'Please log in again.', 'unauthenticated');
      }
      const refresh = randomId(32);
      await q.query('update sessions set refresh_hash = $2 where id = $1', [sid, sha256(refresh)]);
      return issue(ctx, type, s.subject_id, sid, refresh);
    });
  });

  r.post('/api/v1/auth/logout', async ctx => {
    const p = await authenticate(ctx);
    if (p) await db.query('update sessions set revoked_at = now() where id = $1', [p.sid]);
    ctx.res.setHeader('Set-Cookie', [`mms_rt_user=; Path=/api/v1/auth; Max-Age=0`, `mms_rt_customer=; Path=/api/v1/auth; Max-Age=0`]);
    return { ok: true };
  });

  r.get('/api/v1/auth/config', async () => ({ demoMode: demoActive(), whatsappLive: !!config.WHATSAPP_ACCESS_TOKEN, googleClientId: config.GOOGLE_CLIENT_ID || null }));

  /* ---------- Google sign-in (staff) ---------- */
  r.post('/api/v1/auth/google', async ctx => {
    const b = parse(z.object({ credential: z.string().min(20).max(4096) }), ctx.body);
    rateLimit('google-ip:' + ctx.ip, 60, 3600_000);
    const g = await verifyGoogle(b.credential);
    return tx(async q => {
      const u = await one(q, `select id, name, role, active, phone, google_sub from users where google_sub = $1 or lower(email) = $2 order by (google_sub = $1) desc nulls last limit 1`, [g.sub, g.email]);
      if (!u) {
        const pending = await one(q, `select id from access_requests where status = 'pending' and (google_sub = $1 or lower(email) = $2)`, [g.sub, g.email]);
        return { needsAccess: true, pending: !!pending, name: g.name, email: g.email };
      }
      if (!u.active) throw forbidden('This account is deactivated. Contact your admin.');
      if (u.google_sub !== g.sub) await q.query('update users set google_sub = $2 where id = $1', [u.id, g.sub]);
      const s = await createSession(q, 'user', u.id, String(ctx.req.headers['user-agent'] || ''));
      await audit(q, { type: 'user', sid: s.sid, user: u, perms: new Set() }, 'login', `${u.name} logged in with Google`, 'user', u.id);
      return { ...issue(ctx, 'user', u.id, s.sid, s.refresh), user: { id: u.id, name: u.name, role: u.role } };
    });
  });

  /* ---------- sign up: anyone can ask for access; an admin approves and picks the role ---------- */
  r.post('/api/v1/auth/access-request', async ctx => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(80), phone: z.string(), roleWanted: z.string().max(40).default(''), note: z.string().max(300).default(''), credential: z.string().max(4096).optional() }), ctx.body);
    rateLimit('access-ip:' + ctx.ip, 10, 3600_000);
    const phone = normPhone(b.phone);
    if (!phone) throw new HttpError(400, 'Enter your 10-digit WhatsApp number.', 'bad_phone');
    const g = b.credential ? await verifyGoogle(b.credential) : null;
    return tx(async q => {
      if (await one(q, 'select 1 from users where phone = $1', [phone])) throw new HttpError(400, 'This number already has an account. Log in instead.', 'exists');
      if (g && await one(q, 'select 1 from users where lower(email) = $1 or google_sub = $2', [g.email, g.sub])) throw new HttpError(400, 'This Google account already has access. Log in instead.', 'exists');
      const dup = await one(q, `select id from access_requests where status = 'pending' and phone = $1`, [phone]);
      if (dup) await q.query('update access_requests set name = $2, role_wanted = $3, note = $4, email = coalesce($5, email), google_sub = coalesce($6, google_sub), created_at = now() where id = $1', [dup.id, b.name, b.roleWanted, b.note, g?.email || null, g?.sub || null]);
      else {
        await q.query('insert into access_requests(name, phone, email, google_sub, role_wanted, note) values ($1,$2,$3,$4,$5,$6)', [b.name, phone, g?.email || null, g?.sub || null, b.roleWanted, b.note]);
        const admins = await many(q, `select id from users where role = 'admin' and active order by (phone = $1) desc limit 1`, [normPhone(config.ADMIN_PHONE) || '']);
        if (admins[0]) { const { pushTask } = await import('./tasks.js'); const { addDays } = await import('../core/util.js');
          await pushTask(q, { title: `Access request: ${b.name} (${prettyPhone(phone)})${b.roleWanted ? ' · wants ' + b.roleWanted : ''} — approve in Users and access`, assignee: admins[0].id, assigner: admins[0].id, deadline: addDays(1), auto: true }); }
      }
      return { ok: true };
    });
  });

  /** Demo only: switch to another user without OTP (the prototype's "Switch user" box). Disabled unless DEMO_MODE. */
  r.post('/api/v1/auth/demo-switch', staff(), async ctx => {
    if (!demoActive()) throw forbidden('Demo user switching is disabled.');
    const id = String(ctx.body?.userId || '');
    return tx(async q => {
      const u = await one(q, 'select id, name, role, active from users where id = $1', [id]);
      if (!u?.active) throw forbidden('That user is not active.');
      await q.query('update sessions set revoked_at = now() where id = $1', [ctx.auth!.sid]);
      const s = await createSession(q, 'user', u.id, 'demo-switch');
      return { ...issue(ctx, 'user', u.id, s.sid, s.refresh), user: u };
    });
  });
}

export async function revokeAllSessions(q: Q, subjectType: 'user' | 'customer', id: string) {
  await q.query('update sessions set revoked_at = now() where subject_type = $1 and subject_id = $2 and revoked_at is null', [subjectType, id]);
}
