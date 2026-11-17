import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { log } from './util.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = [path.resolve(here, '../../migrations'), path.resolve(here, '../../../migrations')].find(d => fs.existsSync(d));
/** Applies every migrations/*.sql file not yet applied, in name order, each in its own transaction. */
export async function migrate() {
    await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await pool.query('select name from schema_migrations')).rows.map(r => r.name));
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
        if (done.has(f))
            continue;
        const sql = fs.readFileSync(path.join(dir, f), 'utf8');
        const c = await pool.connect();
        try {
            await c.query('begin');
            await c.query(sql);
            await c.query('insert into schema_migrations(name) values ($1)', [f]);
            await c.query('commit');
            log.info('migration applied', f);
        }
        catch (e) {
            await c.query('rollback');
            throw new Error(`Migration ${f} failed: ${e.message}`);
        }
        finally {
            c.release();
        }
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    migrate().then(() => { log.info('migrations complete'); return pool.end(); }).catch(e => { console.error(e); process.exit(1); });
}
