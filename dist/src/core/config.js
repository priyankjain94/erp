import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
const bool = z.union([z.boolean(), z.string()]).transform(v => v === true || v === 'true' || v === '1');
const Env = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(8080),
    APP_BASE_URL: z.string().default(process.env.RENDER_EXTERNAL_URL || 'http://localhost:8080'),
    DATABASE_URL: z.string().default('postgres://postgres@127.0.0.1:5432/mms'),
    DATABASE_SSL: bool.default(false),
    JWT_SECRET: z.string().min(16).default('dev-only-change-me-access-secret'),
    JWT_REFRESH_SECRET: z.string().min(16).default('dev-only-change-me-refresh-secret'),
    ACCESS_TTL_MIN: z.coerce.number().default(15),
    REFRESH_TTL_DAYS: z.coerce.number().default(30),
    CORS_ORIGINS: z.string().default(''),
    TZ_BUSINESS: z.string().default('Asia/Kolkata'),
    ADMIN_PHONE: z.string().default(''),
    ADMIN_NAME: z.string().default('Owner'),
    ADMIN_EMAIL: z.string().default(''), // optional: super admin can also sign in with this Google account
    GOOGLE_CLIENT_ID: z.string().default(''), // Google Identity Services web client ID (public, not a secret)
    GOOGLE_TOKENINFO_URL: z.string().default('https://oauth2.googleapis.com/tokeninfo'),
    SEED_DEMO: bool.default(false),
    DEMO_MODE: bool.default(false), // shows OTP codes on screen + demo user switcher. NEVER in production.
    OTP_LENGTH: z.coerce.number().default(4),
    OTP_TTL_MIN: z.coerce.number().default(5),
    STORAGE_DRIVER: z.enum(['local', 's3', 'db']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./data/uploads'),
    S3_ENDPOINT: z.string().default(''),
    S3_REGION: z.string().default('ap-south-1'),
    S3_BUCKET: z.string().default(''),
    S3_ACCESS_KEY: z.string().default(''),
    S3_SECRET_KEY: z.string().default(''),
    MAX_UPLOAD_MB: z.coerce.number().default(25),
    META_GRAPH_BASE: z.string().default('https://graph.facebook.com'),
    META_GRAPH_VERSION: z.string().default('v25.0'),
    META_APP_ID: z.string().default(''),
    META_APP_SECRET: z.string().default(''),
    WHATSAPP_WABA_ID: z.string().default(''),
    WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
    WHATSAPP_ACCESS_TOKEN: z.string().default(''),
    WHATSAPP_VERIFY_TOKEN: z.string().default(''),
    WHATSAPP_TEMPLATE_LANG: z.string().default('en'),
    WHATSAPP_FORWARD_URL: z.string().default(''),
    META_PAGE_ID: z.string().default(''),
    META_PAGE_ACCESS_TOKEN: z.string().default(''),
    META_LEADS_VERIFY_TOKEN: z.string().default(''),
    SCHEDULER_ENABLED: bool.default(true),
    WORKER_ENABLED: bool.default(true),
    WEB_DIR: z.string().default(fs.existsSync('./web/index.html') ? './web' : '../web/public'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
});
export const config = Env.parse(process.env);
export function assertProductionConfig() {
    if (config.NODE_ENV !== 'production')
        return;
    const problems = [];
    if (config.JWT_SECRET.startsWith('dev-only') || config.JWT_REFRESH_SECRET.startsWith('dev-only'))
        problems.push('Set JWT_SECRET and JWT_REFRESH_SECRET to long random values');
    if (config.DEMO_MODE)
        problems.push('DEMO_MODE must be false in production');
    if (!config.ADMIN_PHONE)
        problems.push('Set ADMIN_PHONE (first admin login)');
    if (config.STORAGE_DRIVER === 's3' && (!config.S3_BUCKET || !config.S3_ACCESS_KEY))
        problems.push('S3 storage selected but S3_BUCKET / S3_ACCESS_KEY missing');
    if (problems.length)
        throw new Error('Unsafe production config:\n- ' + problems.join('\n- '));
}
/** Webhook verify token: WHATSAPP_VERIFY_TOKEN if set, otherwise derived from JWT_SECRET (stable, shown to admins on the Integrations screen). */
export const waVerifyToken = () => config.WHATSAPP_VERIFY_TOKEN || 'mms-' + crypto.createHash('sha256').update('wa-verify:' + config.JWT_SECRET).digest('hex').slice(0, 24);
/** Demo helpers (code on screen, user switcher, sample reset) only while WhatsApp is not live. Once the WhatsApp token is set they switch off by themselves. */
export const demoActive = () => config.DEMO_MODE && (!config.WHATSAPP_ACCESS_TOKEN || config.NODE_ENV === 'test');
export const whatsappLive = () => !!(config.WHATSAPP_ACCESS_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID);
export const metaLeadsLive = () => !!(config.META_PAGE_ACCESS_TOKEN && config.META_PAGE_ID);
