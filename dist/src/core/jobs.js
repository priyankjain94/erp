import { db, pool } from './db.js';
import { log } from './util.js';
const handlers = new Map();
export function registerJob(kind, fn) { handlers.set(kind, fn); }
/** Queue a job (inside the caller's transaction when q is a tx client, so it only runs if the change commits). */
export async function enqueue(kind, payload, opts = {}) {
    await (opts.q || db).query(`insert into jobs(kind, payload, run_at, max_attempts) values ($1, $2, now() + ($3 || ' seconds')::interval, $4)`, [kind, payload ?? {}, String(opts.delaySec || 0), opts.maxAttempts || 6]);
}
/** Claim and run up to `batch` due jobs. Safe with several workers (FOR UPDATE SKIP LOCKED). */
export async function runDueJobs(batch = 20) {
    const c = await pool.connect();
    let claimed = [];
    try {
        await c.query('begin');
        claimed = (await c.query(`select id, kind, payload, attempts, max_attempts from jobs
        where done_at is null and run_at <= now() and (locked_at is null or locked_at < now() - interval '5 minutes')
        order by run_at limit $1 for update skip locked`, [batch])).rows;
        if (claimed.length)
            await c.query('update jobs set locked_at = now(), attempts = attempts + 1 where id = any($1::bigint[])', [claimed.map(j => j.id)]);
        await c.query('commit');
    }
    catch (e) {
        await c.query('rollback');
        throw e;
    }
    finally {
        c.release();
    }
    for (const j of claimed) {
        const h = handlers.get(j.kind);
        try {
            if (!h)
                throw new Error('No handler for job kind ' + j.kind);
            await h(j.payload);
            await db.query('update jobs set done_at = now(), locked_at = null, last_error = null where id = $1', [j.id]);
        }
        catch (e) {
            const attempts = j.attempts + 1;
            const giveUp = attempts >= j.max_attempts;
            const backoff = Math.min(3600, 15 * 2 ** attempts);
            log.warn('job failed', j.kind, j.id, e?.message, giveUp ? '(giving up)' : `(retry in ${backoff}s)`);
            await db.query(`update jobs set locked_at = null, last_error = $2, run_at = now() + ($3 || ' seconds')::interval, done_at = case when $4 then now() else null end where id = $1`, [j.id, String(e?.message || e).slice(0, 500), String(backoff), giveUp]);
        }
    }
    return claimed.length;
}
let timer = null;
export function startWorker(intervalMs = 2000) {
    const tick = async () => {
        try {
            while (await runDueJobs() > 0) { /* drain */ }
        }
        catch (e) {
            log.error('worker', e?.message);
        }
        timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, 500);
}
export function stopWorker() { if (timer)
    clearTimeout(timer); }
