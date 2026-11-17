import crypto from 'node:crypto';
import { config } from './config.js';
export class HttpError extends Error {
    status;
    code;
    details;
    constructor(status, message, code = 'error', details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
export const bad = (msg, details) => new HttpError(400, msg, 'bad_request', details);
export const forbidden = (msg = 'You do not have permission to do this.') => new HttpError(403, msg, 'forbidden');
export const notFound = (what = 'Not found') => new HttpError(404, what, 'not_found');
export const conflict = (msg, details) => new HttpError(409, msg, 'conflict', details);
/** Business "today" in the business time zone (Asia/Kolkata), as YYYY-MM-DD. */
export function todayStr(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: config.TZ_BUSINESS, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function addDays(n, from) {
    const base = from || todayStr();
    const d = new Date(base + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
export function daysFrom(date, from) {
    return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse((from || todayStr()) + 'T00:00:00Z')) / 864e5);
}
export function localParts(now = new Date()) {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: config.TZ_BUSINESS, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
    const parts = Object.fromEntries(f.formatToParts(now).map(p => [p.type, p.value]));
    return { hhmm: `${parts.hour}:${parts.minute}`, weekday: parts.weekday, date: todayStr(now) };
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDate = (s) => { const [, m, d] = s.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
export const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
/** Normalise an Indian mobile to E.164 (+91XXXXXXXXXX). Returns '' when invalid. */
export function normPhone(input) {
    const d = String(input ?? '').replace(/\D/g, '');
    if (d.length === 10)
        return '+91' + d;
    if (d.length === 12 && d.startsWith('91'))
        return '+' + d;
    if (d.length > 10 && d.length <= 15 && String(input).trim().startsWith('+'))
        return '+' + d;
    return '';
}
/** Display format used by the UI: +91 98261 10001 */
export function prettyPhone(e164) {
    const m = e164.match(/^\+91(\d{5})(\d{5})$/);
    return m ? `+91 ${m[1]} ${m[2]}` : e164;
}
export const waNumber = (e164) => e164.replace(/^\+/, '');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'user';
export function safeEqual(a, b) {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export const first = (s) => (s || '').replace(/^(Ar\.|Er\.)\s*/, '').split(' ')[0];
export const log = {
    debug: (...a) => { if (config.LOG_LEVEL === 'debug')
        console.log(new Date().toISOString(), '[debug]', ...a); },
    info: (...a) => { if (config.LOG_LEVEL !== 'warn' && config.LOG_LEVEL !== 'error')
        console.log(new Date().toISOString(), '[info]', ...a); },
    warn: (...a) => { if (config.LOG_LEVEL !== 'error')
        console.warn(new Date().toISOString(), '[warn]', ...a); },
    error: (...a) => console.error(new Date().toISOString(), '[error]', ...a)
};
