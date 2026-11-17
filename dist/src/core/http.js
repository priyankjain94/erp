import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError, log } from './util.js';
export class Router {
    routes = [];
    add(method, pattern, ...handlers) {
        const keys = [];
        const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_m, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
        this.routes.push({ method, re, keys, handlers });
    }
    get = (p, ...h) => this.add('GET', p, ...h);
    post = (p, ...h) => this.add('POST', p, ...h);
    put = (p, ...h) => this.add('PUT', p, ...h);
    patch = (p, ...h) => this.add('PATCH', p, ...h);
    delete = (p, ...h) => this.add('DELETE', p, ...h);
    match(method, p) {
        for (const r of this.routes) {
            if (r.method !== method)
                continue;
            const m = p.match(r.re);
            if (m)
                return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
        }
        return null;
    }
}
export function parse(schema, data) {
    const r = schema.safeParse(data);
    if (!r.success)
        throw new HttpError(400, 'Please check the highlighted fields.', 'validation', r.error.flatten());
    return r.data;
}
/* ---------- simple in-memory rate limiter (per process) ---------- */
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.reset < now) {
        buckets.set(key, { n: 1, reset: now + windowMs });
        return;
    }
    b.n++;
    if (b.n > max) {
        const mins = Math.max(1, Math.ceil((b.reset - now) / 60000));
        const at = new Date(b.reset).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
        throw new HttpError(429, mins <= 2 ? 'Too many tries. Please wait a minute and try again.' : `Too many tries. Please try again after ${at} (in ${mins} minutes).`, 'rate_limited', { retryAt: b.reset });
    }
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets)
    if (b.reset < now)
        buckets.delete(k); }, 60_000).unref();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain' };
function securityHeaders(res, isHtml) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
    if (config.NODE_ENV === 'production')
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (isHtml)
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://accounts.google.com/gsi/client",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
            "frame-src https://accounts.google.com/gsi/",
            "font-src 'self' https://fonts.gstatic.com data:",
            "img-src 'self' data: blob: https:",
            "connect-src 'self' https://accounts.google.com/gsi/",
            "worker-src 'self'",
            "frame-ancestors 'none'"
        ].join('; '));
}
function cors(ctx) {
    const origin = ctx.req.headers.origin;
    const allowed = config.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
    if (origin && allowed.includes(origin)) {
        ctx.res.setHeader('Access-Control-Allow-Origin', origin);
        ctx.res.setHeader('Access-Control-Allow-Credentials', 'true');
        ctx.res.setHeader('Vary', 'Origin');
        ctx.res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-State-Have');
        ctx.res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
}
const gzipOk = (req) => !!req && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
export function send(res, status, body, headers = {}, req) {
    if (res.headersSent)
        return;
    const isStr = typeof body === 'string';
    const text = isStr ? body : JSON.stringify(body);
    const h = { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...headers };
    if (text.length > 1024 && gzipOk(req)) {
        res.writeHead(status, { ...h, 'Content-Encoding': 'gzip' });
        res.end(zlib.gzipSync(text, { level: 6 }));
        return;
    }
    res.writeHead(status, h);
    res.end(text);
}
/**
 * The app's data comes in sections (erp.projects, crm.leads, ...). The browser sends the fingerprints of the sections it
 * already has (X-State-Have); unchanged sections are left out of the reply, so a save sends back only what changed.
 */
const fp = (v) => createHash('sha1').update(JSON.stringify(v) ?? '').digest('base64url').slice(0, 12);
function compactState(st, req) {
    if (!st || typeof st !== 'object' || !st.erp || !st.crm)
        return st;
    let have = {};
    try {
        have = JSON.parse(String(req.headers['x-state-have'] || '{}')) || {};
    }
    catch {
        have = {};
    }
    const out = { __h: {} };
    for (const top of Object.keys(st)) {
        const sec = st[top];
        if (!sec || typeof sec !== 'object' || Array.isArray(sec)) {
            out[top] = sec;
            continue;
        }
        out[top] = {};
        for (const k of Object.keys(sec)) {
            const key = top + '.' + k, h = fp(sec[k]);
            out.__h[key] = h;
            if (have[key] !== h)
                out[top][k] = sec[k];
        }
    }
    return out;
}
function withCompactState(out, req) {
    if (!req.headers['x-state-have'] || !out || typeof out !== 'object')
        return out;
    if (out.erp && out.crm)
        return compactState(out, req);
    if (out.state && out.state.erp && out.state.crm)
        return { ...out, state: compactState(out.state, req) };
    return out;
}
async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > limit)
            throw new HttpError(413, 'Request is too large.', 'too_large');
        chunks.push(c);
    }
    return Buffer.concat(chunks);
}
function serveStatic(ctx, webDir) {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD')
        return false;
    let rel = decodeURIComponent(ctx.path);
    if (rel === '/' || rel === '/c' || rel === '/c/' || rel.startsWith('/c/'))
        rel = '/index.html';
    if (rel === '/privacy' || rel === '/terms' || rel === '/data-deletion')
        rel = '/privacy.html';
    const file = path.resolve(webDir, '.' + rel);
    if (!file.startsWith(path.resolve(webDir)))
        return false;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        return false;
    const ext = path.extname(file);
    securityHeaders(ctx.res, ext === '.html');
    const head = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || rel === '/sw.js' ? 'no-cache' : 'public, max-age=3600', Vary: 'Accept-Encoding' };
    if (COMPRESSIBLE.has(ext) && gzipOk(ctx.req)) {
        const st = fs.statSync(file), key = file + ':' + st.mtimeMs;
        let z = gzCache.get(key);
        if (!z) {
            z = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
            gzCache.set(key, z);
        }
        const etag = '"' + key.length.toString(36) + '-' + Math.round(st.mtimeMs).toString(36) + '-' + st.size.toString(36) + '"';
        if (ctx.req.headers['if-none-match'] === etag) {
            ctx.res.writeHead(304, { ...head, ETag: etag });
            ctx.res.end();
            return true;
        }
        ctx.res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', 'Content-Length': String(z.length), ETag: etag });
        ctx.res.end(ctx.method === 'HEAD' ? undefined : z);
        return true;
    }
    ctx.res.writeHead(200, head);
    fs.createReadStream(file).pipe(ctx.res);
    return true;
}
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.txt']);
const gzCache = new Map();
export function createServer(router) {
    const webDir = path.resolve(process.cwd(), config.WEB_DIR);
    return http.createServer(async (req, res) => {
        const started = Date.now();
        const url = new URL(req.url || '/', 'http://x');
        const ctx = { req, res, method: req.method || 'GET', path: url.pathname, params: {}, query: url.searchParams, rawBody: Buffer.alloc(0), body: {},
            ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() };
        try {
            cors(ctx);
            if (ctx.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }
            const m = router.match(ctx.method, ctx.path);
            if (!m) {
                if (!ctx.path.startsWith('/api/') && serveStatic(ctx, webDir))
                    return;
                throw new HttpError(404, 'Not found', 'not_found');
            }
            ctx.params = m.params;
            if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method)) {
                const isUpload = ctx.path.startsWith('/api/v1/uploads/local');
                ctx.rawBody = await readBody(req, (isUpload ? config.MAX_UPLOAD_MB : 2) * 1024 * 1024);
                const ct = String(req.headers['content-type'] || '');
                if (ctx.rawBody.length && ct.includes('application/json')) {
                    try {
                        ctx.body = JSON.parse(ctx.rawBody.toString('utf8'));
                    }
                    catch {
                        throw new HttpError(400, 'Invalid JSON body', 'bad_json');
                    }
                }
            }
            securityHeaders(res, false);
            let out;
            for (const h of m.route.handlers) {
                out = await h(ctx);
                if (res.headersSent)
                    break;
            }
            if (!res.headersSent)
                send(res, out === undefined ? 204 : 200, out === undefined ? '' : withCompactState(out, req), {}, req);
        }
        catch (e) {
            if (e instanceof HttpError)
                send(res, e.status, { error: e.code, message: e.message, details: e.details }, {}, req);
            else if (e instanceof ZodError)
                send(res, 400, { error: 'validation', message: 'Invalid input', details: e.flatten() }, {}, req);
            else if (e && e.code === '23505')
                send(res, 409, { error: 'duplicate', message: 'That already exists.', details: e.detail }, {}, req);
            else {
                log.error(ctx.method, ctx.path, e?.stack || e);
                send(res, 500, { error: 'server_error', message: 'Something went wrong on our side. Please try again.' }, {}, req);
            }
        }
        finally {
            if (ctx.path.startsWith('/api/'))
                log.debug(ctx.method, ctx.path, res.statusCode, Date.now() - started + 'ms');
        }
    });
}
