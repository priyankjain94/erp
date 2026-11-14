import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError, type ZodTypeAny, type infer as Infer } from 'zod';
import { config } from './config.js';
import { HttpError, log } from './util.js';

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  rawBody: Buffer;
  body: any;
  ip: string;
  auth?: import('../modules/auth.js').Principal;
}
export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
interface Route { method: string; re: RegExp; keys: string[]; handlers: Handler[] }

export class Router {
  routes: Route[] = [];
  add(method: string, pattern: string, ...handlers: Handler[]) {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_m, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get = (p: string, ...h: Handler[]) => this.add('GET', p, ...h);
  post = (p: string, ...h: Handler[]) => this.add('POST', p, ...h);
  put = (p: string, ...h: Handler[]) => this.add('PUT', p, ...h);
  patch = (p: string, ...h: Handler[]) => this.add('PATCH', p, ...h);
  delete = (p: string, ...h: Handler[]) => this.add('DELETE', p, ...h);
  match(method: string, p: string) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = p.match(r.re);
      if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): Infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'Please check the highlighted fields.', 'validation', r.error.flatten());
  return r.data;
}

/* ---------- simple in-memory rate limiter (per process) ---------- */
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return; }
  b.n++;
  if (b.n > max) throw new HttpError(429, 'Too many requests. Please wait a little and try again.', 'rate_limited');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain' };

function securityHeaders(res: http.ServerResponse, isHtml: boolean) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
  if (config.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (isHtml) res.setHeader('Content-Security-Policy', [
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

function cors(ctx: Ctx) {
  const origin = ctx.req.headers.origin;
  const allowed = config.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    ctx.res.setHeader('Access-Control-Allow-Origin', origin);
    ctx.res.setHeader('Access-Control-Allow-Credentials', 'true');
    ctx.res.setHeader('Vary', 'Origin');
    ctx.res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    ctx.res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }
}

export function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  const isStr = typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request is too large.', 'too_large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function serveStatic(ctx: Ctx, webDir: string): boolean {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return false;
  let rel = decodeURIComponent(ctx.path);
  if (rel === '/' || rel === '/c' || rel === '/c/' || rel.startsWith('/c/')) rel = '/index.html';
  if (rel === '/privacy' || rel === '/terms' || rel === '/data-deletion') rel = '/privacy.html';
  const file = path.resolve(webDir, '.' + rel);
  if (!file.startsWith(path.resolve(webDir))) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file);
  securityHeaders(ctx.res, ext === '.html');
  ctx.res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || rel === '/sw.js' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(ctx.res);
  return true;
}

export function createServer(router: Router) {
  const webDir = path.resolve(process.cwd(), config.WEB_DIR);
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url || '/', 'http://x');
    const ctx: Ctx = { req, res, method: req.method || 'GET', path: url.pathname, params: {}, query: url.searchParams, rawBody: Buffer.alloc(0), body: {},
      ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() };
    try {
      cors(ctx);
      if (ctx.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const m = router.match(ctx.method, ctx.path);
      if (!m) {
        if (!ctx.path.startsWith('/api/') && serveStatic(ctx, webDir)) return;
        throw new HttpError(404, 'Not found', 'not_found');
      }
      ctx.params = m.params;
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method)) {
        const isUpload = ctx.path.startsWith('/api/v1/uploads/local');
        ctx.rawBody = await readBody(req, (isUpload ? config.MAX_UPLOAD_MB : 2) * 1024 * 1024);
        const ct = String(req.headers['content-type'] || '');
        if (ctx.rawBody.length && ct.includes('application/json')) {
          try { ctx.body = JSON.parse(ctx.rawBody.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body', 'bad_json'); }
        }
      }
      securityHeaders(res, false);
      let out: unknown;
      for (const h of m.route.handlers) { out = await h(ctx); if (res.headersSent) break; }
      if (!res.headersSent) send(res, out === undefined ? 204 : 200, out === undefined ? '' : out);
    } catch (e: any) {
      if (e instanceof HttpError) send(res, e.status, { error: e.code, message: e.message, details: e.details });
      else if (e instanceof ZodError) send(res, 400, { error: 'validation', message: 'Invalid input', details: e.flatten() });
      else if (e && e.code === '23505') send(res, 409, { error: 'duplicate', message: 'That already exists.', details: e.detail });
      else { log.error(ctx.method, ctx.path, e?.stack || e); send(res, 500, { error: 'server_error', message: 'Something went wrong on our side. Please try again.' }); }
    } finally {
      if (ctx.path.startsWith('/api/')) log.debug(ctx.method, ctx.path, res.statusCode, Date.now() - started + 'ms');
    }
  });
}
