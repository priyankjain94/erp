import { z } from 'zod';
import { many, one, tx, type Q } from '../core/db.js';
import { parse, type Router } from '../core/http.js';
import { addDays, bad, forbidden, notFound } from '../core/util.js';
import { BOXES, ROOM_PRESETS, stageTaskTitle, typeName } from '../domain.js';
import { audit, staff, userOf, type Principal } from './auth.js';
import { act, ScopeLineZ, type ScopeLine } from './ops.js';
import { staffState } from './state.js';
import { pushTask } from './tasks.js';

type U = Extract<Principal, { type: 'user' }>;

/** room code used in item codes; the same room name always gets the same code within a project */
async function roomCode(q: Q, pid: string, room: string) {
  const same = await one(q, `select room_code from project_scope where project_id = $1 and lower(room_name) = lower($2) limit 1`, [pid, room]);
  if (same) return same.room_code as string;
  const preset = ROOM_PRESETS.find(([n]) => n.toLowerCase() === room.toLowerCase());
  let base = preset ? preset[1] : (room.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'RM');
  const used = new Set((await many(q, 'select distinct room_code from project_scope where project_id = $1', [pid])).map(r => r.room_code));
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) { const c = base.slice(0, 2) + n; if (!used.has(c)) return c; }
  return base + Date.now() % 100;
}

export async function addScopeLines(q: Q, pid: string, lines: ScopeLine[], byId: string) {
  let sort = Number((await one(q, 'select coalesce(max(sort), 0) m from project_scope where project_id = $1', [pid]))!.m);
  const ids: number[] = [];
  for (const l of lines) {
    const code = await roomCode(q, pid, l.room);
    const r = await one(q, `insert into project_scope(project_id, room_name, room_code, type, descr, size, value, source, sort, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [pid, l.room, code, l.type, l.desc, l.size, l.value, l.source, ++sort, byId]);
    ids.push(r!.id);
  }
  return ids;
}

/** create the production item for one scope line (at survey submit, or when the PM adds a line after the survey) */
export async function createItemFromScope(q: Q, s: any, room: { code: string; name: string }, wall: string, note: string, byId: string, designer: string | null, target: string, startedAt?: Date) {
  const same = Number((await one(q, 'select count(*) n from items where project_id = $1 and room_code = $2 and type = $3', [s.project_id, room.code, s.type]))!.n);
  const id = 'I' + (await one(q, `select nextval('item_seq') n`))!.n;
  const code = `${room.code}-${s.type}-${String(same + 1).padStart(2, '0')}`;
  const descr = [s.descr, s.size, note].filter(Boolean).join(' · ');
  const palette = { ...((await one(q, 'select palette from projects where id = $1', [s.project_id]))?.palette || {}), ...(s.size ? { size: s.size } : {}) };
  await q.query(`insert into items(id, code, project_id, room_code, room_name, type, wall, descr, stage, owner_id, designer_id, target, value, scope_id, spec) values ($1,$2,$3,$4,$5,$6,$7,$8,'drawing',$9,$9,$10,$11,$12,$13)`,
    [id, code, s.project_id, room.code, room.name, s.type, wall, descr, designer, target, s.value, s.id, JSON.stringify(palette)]);
  await q.query(`insert into item_stage_log(item_id, stage, in_at, out_at, by_id) values ($1, 'survey', $2, now(), $3)`, [id, startedAt || new Date(), byId]);
  await q.query(`insert into item_stage_log(item_id, stage, in_at) values ($1, 'drawing', now())`, [id]);
  let n = 1; for (const label of BOXES[s.type] || BOXES.OT) await q.query('insert into item_boxes(item_id, n, label) values ($1,$2,$3)', [id, n++, label]);
  if (designer) await pushTask(q, { title: stageTaskTitle('drawing', code), projectId: s.project_id, itemId: id, assignee: designer, assigner: byId, deadline: addDays(4), auto: true, proof: 'file' });
  await q.query('update project_scope set item_id = $2 where id = $1', [s.id, id]);
  return { id, code };
}

/** sales may build the scope until the surveyor checks in; after that only the PM / ops (assign permission) */
async function canEditScope(q: Q, p: U, pid: string) {
  if (p.perms.has('assign')) return;
  const s = await one(q, 'select check_in_at from surveys where project_id = $1', [pid]);
  if (p.perms.has('crm') && !s?.check_in_at) return;
  throw forbidden('Only the project manager can change the scope once the site survey has started.');
}

export function scopeRoutes(r: Router) {
  r.post('/api/v1/projects/:id/scope', staff(), async ctx => {
    const p = userOf(ctx);
    const b = parse(z.object({ lines: z.array(ScopeLineZ).min(1).max(40), wall: z.string().regex(/^[A-H]$/).optional() }), ctx.body);
    await tx(async q => {
      const pr = await one(q, 'select * from projects where id = $1 for update', [ctx.params.id]); if (!pr) throw notFound();
      await canEditScope(q, p, pr.id);
      const sv = await one(q, 'select status, check_in_at from surveys where project_id = $1', [pr.id]);
      const ids = await addScopeLines(q, pr.id, b.lines, p.user.id);
      if (sv?.status === 'submitted') {
        // survey is done: the item goes straight to production drawing, on a measured wall
        if (b.lines.length !== 1 || !b.wall) throw bad('The survey is already submitted. Add one item at a time and choose the wall it goes on.');
        const s = await one(q, 'select * from project_scope where id = $1', [ids[0]]);
        const room = await one(q, 'select code, name from rooms where project_id = $1 and (code = $2 or lower(name) = lower($3)) limit 1', [pr.id, s.room_code, s.room_name]);
        if (!room) throw bad(`${s.room_name} was not measured in the survey. Ask the surveyor to visit again, then add it.`);
        if (room.code !== s.room_code) await q.query('update project_scope set room_code = $2 where id = $1', [s.id, room.code]);
        if (!(await one(q, 'select 1 from walls w join rooms r on r.id = w.room_id where r.project_id = $1 and r.code = $2 and w.label = $3', [pr.id, room.code, b.wall]))) throw bad(`Wall ${b.wall} was not measured in ${room.name}.`);
        const designer = (await one(q, `select id from users where role = 'designer' and active order by created_at limit 1`))?.id || null;
        const it = await createItemFromScope(q, { ...s, room_code: room.code }, room, b.wall, '', p.user.id, designer, pr.target);
        await act(q, pr.id, `Scope added after survey: ${typeName(s.type)} in ${room.name}, wall ${b.wall} (${it.code}) by ${p.user.name}`);
      } else {
        await act(q, pr.id, `Scope of work: ${b.lines.map(l => `${typeName(l.type)} · ${l.room}`).join(', ')} added by ${p.user.name}`);
      }
      await audit(q, p, 'scope.add', `Scope added to ${pr.code}: ${b.lines.length} line(s)`, 'project', pr.id);
    });
    return { ok: true, state: await staffState(p) };
  });
  r.patch('/api/v1/projects/:id/scope/:sid', staff(), async ctx => {
    const p = userOf(ctx); const b = parse(ScopeLineZ.partial().omit({ source: true, room: true }), ctx.body);
    await tx(async q => {
      const s = await one(q, 'select * from project_scope where id = $1 and project_id = $2 for update', [Number(ctx.params.sid), ctx.params.id]); if (!s) throw notFound();
      await canEditScope(q, p, s.project_id);
      if (s.item_id && b.type && b.type !== s.type) throw bad('This item is already in production. Raise a change order instead.');
      await q.query('update project_scope set type = coalesce($2, type), descr = coalesce($3, descr), size = coalesce($4, size), value = coalesce($5, value) where id = $1', [s.id, b.type ?? null, b.desc ?? null, b.size ?? null, b.value ?? null]);
      if (s.item_id && b.value !== undefined) await q.query('update items set value = $2 where id = $1', [s.item_id, b.value]);
    });
    return { ok: true, state: await staffState(p) };
  });
  r.delete('/api/v1/projects/:id/scope/:sid', staff(), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ reason: z.string().trim().min(3).max(200) }), ctx.body || {});
    await tx(async q => {
      const s = await one(q, 'select * from project_scope where id = $1 and project_id = $2 for update', [Number(ctx.params.sid), ctx.params.id]); if (!s) throw notFound();
      await canEditScope(q, p, s.project_id);
      if (s.item_id) throw bad('This item is already in production. Raise a change order to remove it.');
      await q.query(`update project_scope set status = 'removed', removed_by = $2, removed_at = now(), remove_reason = $3 where id = $1`, [s.id, p.user.id, b.reason]);
      await q.query(`delete from room_items where scope_id = $1`, [s.id]);
      await act(q, s.project_id, `Scope: ${typeName(s.type)} · ${s.room_name} removed by ${p.user.name} (${b.reason})`);
    });
    return { ok: true, state: await staffState(p) };
  });
}

export async function loadScope(q: Q, pids: string[] | null) {
  return many(q, `select * from project_scope ${pids ? 'where project_id = any($1::text[])' : ''} order by sort, id`, pids ? [pids] : []);
}
