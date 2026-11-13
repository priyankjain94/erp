import pg from 'pg';
import { config } from './config.js';

// Dates (DATE columns) stay as 'YYYY-MM-DD' strings; never shift them through a JS Date.
pg.types.setTypeParser(1082, v => v);
// COUNT(*) and other int8 values come back as numbers (values here are far below 2^53).
pg.types.setTypeParser(20, v => Number(v));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined
});
pool.on('error', err => console.error('[db] idle client error', err.message));

export interface Q { query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }> }

export const db: Q = { query: (text, params) => pool.query(text, params) };

export async function one<R = any>(q: Q, text: string, params?: unknown[]): Promise<R | undefined> {
  return (await q.query<R>(text, params)).rows[0];
}
export async function many<R = any>(q: Q, text: string, params?: unknown[]): Promise<R[]> {
  return (await q.query<R>(text, params)).rows;
}

/** Run fn inside a transaction; everything a request changes commits or rolls back together. */
export async function tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    try { await c.query('rollback'); } catch { /* ignore */ }
    throw e;
  } finally {
    c.release();
  }
}
