import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../core/config.js';
import { db, one } from '../core/db.js';
import { parse, type Router } from '../core/http.js';
import { bad, HttpError, notFound, randomId } from '../core/util.js';
import { authenticate } from '../modules/auth.js';

/* Files (photos, drawings) are private. The API hands out short-lived signed URLs.
   STORAGE_DRIVER=local keeps files on disk (single server); s3 works with AWS S3, Cloudflare R2, MinIO, Hostinger object storage. */
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const sign = (s: string) => crypto.createHmac('sha256', config.JWT_SECRET).update(s).digest('base64url').slice(0, 32);

export function signedFileUrl(ref: string | null | undefined, ttlSec = 3600 * 24) {
  if (!ref || !ref.startsWith('upload:')) return ref || null;
  const id = ref.slice(7), exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `/api/v1/files/${id}?exp=${exp}&sig=${sign(id + ':' + exp)}`;
}

/* ---------- AWS Signature V4 presign (S3-compatible) ---------- */
function hmac(key: Buffer | string, s: string) { return crypto.createHmac('sha256', key).update(s).digest(); }
export function s3Presign(method: 'GET' | 'PUT', key: string, expires = 900, contentType?: string) {
  const host = new URL(config.S3_ENDPOINT || `https://s3.${config.S3_REGION}.amazonaws.com`).host;
  const now = new Date(); const amz = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); const date = amz.slice(0, 8);
  const scope = `${date}/${config.S3_REGION}/s3/aws4_request`;
  const pathPart = `/${config.S3_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const qs = new URLSearchParams({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${config.S3_ACCESS_KEY}/${scope}`, 'X-Amz-Date': amz, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host' });
  const canonQs = [...qs.entries()].sort().map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canon = [method, pathPart, canonQs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, crypto.createHash('sha256').update(canon).digest('hex')].join('\n');
  const k = hmac(hmac(hmac(hmac('AWS4' + config.S3_SECRET_KEY, date), config.S3_REGION), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', k).update(toSign).digest('hex');
  void contentType;
  return `https://${host}${pathPart}?${canonQs}&X-Amz-Signature=${sig}`;
}

export function storageRoutes(r: Router) {
  /** Step 1: ask for an upload slot. Step 2: PUT the bytes to uploadUrl. Step 3: save `ref` on the record. */
  r.post('/api/v1/uploads', async ctx => {
    const p = ctx.auth || await authenticate(ctx);
    if (!p) throw new HttpError(401, 'Please log in again.', 'unauthenticated');
    const b = parse(z.object({ contentType: z.enum(ALLOWED as [string, ...string[]]), size: z.number().int().positive().max(config.MAX_UPLOAD_MB * 1024 * 1024) }), ctx.body);
    const id = randomId(12) + (b.contentType === 'application/pdf' ? '.pdf' : b.contentType === 'image/png' ? '.png' : b.contentType === 'image/webp' ? '.webp' : '.jpg');
    const owner = p.type === 'user' ? p.user.id : String(p.customer.id);
    const key = `uploads/${new Date().toISOString().slice(0, 7)}/${id}`;
    await db.query('insert into uploads(id, owner_type, owner_id, content_type, size, path) values ($1,$2,$3,$4,$5,$6)', [id, p.type, owner, b.contentType, b.size, key]);
    const uploadUrl = config.STORAGE_DRIVER === 's3' ? s3Presign('PUT', key) : `/api/v1/uploads/local/${id}?exp=${Math.floor(Date.now() / 1000) + 900}&sig=${sign(id + ':put')}`;
    return { ref: 'upload:' + id, uploadUrl, method: 'PUT', viewUrl: signedFileUrl('upload:' + id) };
  });
  r.put('/api/v1/uploads/local/:id', async ctx => {
    if (config.STORAGE_DRIVER !== 'local') throw notFound();
    if (ctx.query.get('sig') !== sign(ctx.params.id + ':put') || Number(ctx.query.get('exp')) < Date.now() / 1000) throw new HttpError(403, 'Upload link expired', 'forbidden');
    const u = await one(db, 'select * from uploads where id = $1', [ctx.params.id]); if (!u) throw notFound();
    if (ctx.rawBody.length > u.size + 1024 || !ctx.rawBody.length) throw bad('File size does not match');
    const file = path.resolve(config.STORAGE_LOCAL_DIR, u.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ctx.rawBody);
    return { ok: true };
  });
  r.get('/api/v1/files/:id', async ctx => {
    const id = ctx.params.id, exp = Number(ctx.query.get('exp'));
    if (ctx.query.get('sig') !== sign(id + ':' + exp) || exp < Date.now() / 1000) throw new HttpError(403, 'Link expired', 'forbidden');
    const u = await one(db, 'select * from uploads where id = $1', [id]); if (!u) throw notFound();
    if (config.STORAGE_DRIVER === 's3') { ctx.res.writeHead(302, { Location: s3Presign('GET', u.path, 3600) }); ctx.res.end(); return; }
    const file = path.resolve(config.STORAGE_LOCAL_DIR, u.path);
    if (!fs.existsSync(file)) throw notFound();
    ctx.res.writeHead(200, { 'Content-Type': u.content_type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(ctx.res);
  });
}
