import { z } from 'zod';
import { config } from '../core/config.js';
import { db, many, one, tx, type Q } from '../core/db.js';
import { parse, type Router } from '../core/http.js';
import { bad, first, notFound } from '../core/util.js';
import { gatesFor, MATERIAL_FIELDS, stageIdx, STAGES } from '../domain.js';
import { sendTemplate } from '../integrations/whatsapp.js';
import { staff, userOf, type Principal } from './auth.js';
import { act, gateInput, moveIn } from './ops.js';
import { staffState } from './state.js';

type U = Extract<Principal, { type: 'user' }>;
/* stages that move on their own once every required check is done. Handover is closed by the PM. */
const AUTO = new Set(['drawing', 'pi', 'order', 'dispatch', 'install']);

/** Move an item forward while all of its required checks pass. Returns the moves made. */
export async function autoAdvance(q: Q, itemId: string, byId = 'system') {
  const moves: { from: string; to: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const { it, gi, gp } = await gateInput(q, itemId);
    if (!AUTO.has(it.stage)) break;
    const g = gatesFor(gi, gp);
    if (g.some(x => x.hard && !x.ok)) break;
    const to = STAGES[stageIdx(it.stage) + 1].id;
    await moveIn(q, itemId, to, byId, 'auto: all required checks done');
    moves.push({ from: it.stage, to });
  }
  return moves;
}
export async function autoAdvanceProject(q: Q, pid: string, byId = 'system') {
  for (const it of await many(q, `select id from items where project_id = $1 and stage <> 'closed' order by id`, [pid])) await autoAdvance(q, it.id, byId);
}

const fileRef = z.string().regex(/^upload:[A-Za-z0-9_-]+\.(pdf|jpg|png|webp)$/, 'Upload the file first');
const BatchZ = z.object({
  kind: z.enum(['pi', 'po', 'hw_received', 'production_done', 'dispatch', 'delivered']),
  items: z.array(z.string()).min(1).max(60),
  refNo: z.string().trim().max(60).optional(), amount: z.coerce.number().min(0).max(1e9).optional().nullable(), doc: fileRef.optional().nullable(),
  vendor: z.string().trim().max(80).optional(), vehicle: z.string().trim().max(40).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});
const BATCH_STAGE: Record<string, string> = { pi: 'pi', po: 'order', hw_received: 'order', production_done: 'order', dispatch: 'dispatch', delivered: 'dispatch' };

export function workflowRoutes(r: Router) {
  const done = async (p: U, extra: Record<string, unknown> = {}) => ({ ok: true, ...extra, state: await staffState(p) });

  /* one PI / one PO / one truck for several items */
  r.post('/api/v1/projects/:id/batch', staff('edit'), async ctx => {
    const p = userOf(ctx); const b = parse(BatchZ, ctx.body);
    const out = await tx(async q => {
      const pr = await one(q, 'select * from projects where id = $1', [ctx.params.id]); if (!pr) throw notFound();
      const its = await many(q, 'select * from items where id = any($1::text[]) and project_id = $2 for update', [b.items, pr.id]);
      if (its.length !== b.items.length) throw bad('Some items are not in this project.');
      const wrong = its.filter(i => i.stage !== BATCH_STAGE[b.kind]);
      if (wrong.length) throw bad(`${wrong.map(i => i.code).join(', ')} ${wrong.length > 1 ? 'are' : 'is'} not at this stage.`);
      if (b.doc && !(await one(q, 'select 1 from uploads where id = $1', [b.doc.slice(7)]))) throw bad('That file was not uploaded. Try again.');
      const codes = its.map(i => i.code).join(', ');
      if (b.kind === 'pi') {
        if (!b.refNo) throw bad('Enter the PI number.');
        for (const i of its) await q.query('update items set prod_pi_no = $2, prod_pi = true, prod_pi_doc = coalesce($3, prod_pi_doc) where id = $1', [i.id, b.refNo, b.doc || null]);
        await act(q, pr.id, `Factory PI ${b.refNo}${b.amount ? ' · ₹' + Math.round(b.amount).toLocaleString('en-IN') : ''} raised for ${codes} (${p.user.name})`);
      } else if (b.kind === 'po') {
        if (!b.refNo) throw bad('Enter the PO number.');
        for (const i of its) await q.query('update items set po = $2, hw_vendor = coalesce(nullif($3, \'\'), hw_vendor), hw_po_doc = coalesce($4, hw_po_doc), hw_pi = true where id = $1', [i.id, b.refNo, b.vendor || '', b.doc || null]);
        await act(q, pr.id, `Hardware PO ${b.refNo}${b.vendor ? ' · ' + b.vendor : ''} placed for ${codes} (${p.user.name})`);
      } else if (b.kind === 'hw_received') {
        for (const i of its) await q.query('update items set hw_received = true where id = $1', [i.id]);
        await act(q, pr.id, `Hardware received for ${codes} (${p.user.name})`);
      } else if (b.kind === 'production_done') {
        for (const i of its) await q.query('update items set production_done = true where id = $1', [i.id]);
        await act(q, pr.id, `Factory production complete for ${codes} (${p.user.name})`);
      } else if (b.kind === 'dispatch') {
        if (!b.vehicle || !b.date) throw bad('Enter the vehicle number and the dispatch date.');
        for (const i of its) { const n = Number((await one(q, 'select count(*) n from item_boxes where item_id = $1', [i.id]))!.n); await q.query('update items set dispatch_vehicle = $2, dispatch_date = $3, dispatch_boxes = $4 where id = $1', [i.id, b.vehicle, b.date, n]); }
        await act(q, pr.id, `Dispatch planned: ${b.vehicle} on ${b.date} with ${codes} (${p.user.name})`);
      } else if (b.kind === 'delivered') {
        for (const i of its) await q.query('update items set delivered = true where id = $1', [i.id]);
        await act(q, pr.id, `Material delivered at site: ${codes} (${p.user.name})`);
      }
      await q.query(`insert into project_batches(project_id, kind, ref_no, amount, doc, vendor, vehicle, date, items, by_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [pr.id, b.kind, b.refNo || null, b.amount ?? null, b.doc || null, b.vendor || null, b.vehicle || null, b.date || null, b.items, p.user.id]);
      let moved = 0; for (const i of its) moved += (await autoAdvance(q, i.id, p.user.id)).length ? 1 : 0;
      return { moved };
    });
    return done(p, out);
  });

  /* project material palette: set once, every item's specification starts from it */
  r.put('/api/v1/projects/:id/palette', staff('edit'), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ spec: z.record(z.string(), z.string().max(300)) }), ctx.body);
    const clean = Object.fromEntries(MATERIAL_FIELDS.map(f => [f.id, String(b.spec[f.id] ?? '').trim()]).filter(([, v]) => v));
    await tx(async q => {
      const pr = await one(q, 'update projects set palette = $2 where id = $1 returning id', [ctx.params.id, JSON.stringify(clean)]); if (!pr) throw notFound();
      // items still in drawing with no spec of their own take the palette
      for (const i of await many(q, `select id, spec from items where project_id = $1 and stage = 'drawing'`, [pr.id])) {
        const merged = { ...clean, ...Object.fromEntries(Object.entries(i.spec || {}).filter(([, v]) => v)) };
        await q.query('update items set spec = $2 where id = $1', [i.id, JSON.stringify(merged)]);
      }
      await act(q, pr.id, `Material palette set by ${p.user.name}`);
    });
    return done(p);
  });

  /* approval form: one WhatsApp to the client with every drawing waiting for approval */
  r.post('/api/v1/projects/:id/approval-form', staff('edit'), async ctx => {
    const p = userOf(ctx); const b = parse(z.object({ items: z.array(z.string()).min(1).max(60) }), ctx.body);
    const out = await tx(async q => {
      const pr = await one(q, 'select p.*, c.name cname, c.phone cphone from projects p join customers c on c.id = p.customer_id where p.id = $1', [ctx.params.id]); if (!pr) throw notFound();
      const ready: string[] = [];
      for (const id of b.items) {
        const d = await one(q, `select d.id, d.approved_at, i.code, i.stage from documents d join items i on i.id = d.item_id where d.item_id = $1 and i.project_id = $2 and d.kind = 'drawing' order by d.id desc limit 1`, [id, pr.id]);
        if (d && !d.approved_at && d.stage === 'drawing') { ready.push(d.code); await q.query('update documents set sent_at = now() where id = $1', [d.id]); }
      }
      if (!ready.length) throw bad('None of these items has a new drawing waiting for approval. Upload the drawings first.');
      await sendTemplate(pr.cphone, 'approval_form', [first(pr.cname), String(ready.length), pr.code, `${config.APP_BASE_URL}/c`], { q, related: { type: 'project', id: pr.id } });
      await q.query(`update items set waiting = 'client_approval', waiting_since = coalesce(waiting_since, now()) where project_id = $1 and code = any($2::text[]) and waiting = ''`, [pr.id, ready]);
      await act(q, pr.id, `Approval form sent to the client on WhatsApp: ${ready.length} drawing${ready.length > 1 ? 's' : ''} (${ready.join(', ')}) by ${p.user.name}`);
      return { sent: ready.length };
    });
    return done(p, out);
  });

  /* drafts: every form saves as you go; the author, the project's PM and the item's owner can see it */
  r.put('/api/v1/drafts', staff(), async ctx => {
    const p = userOf(ctx);
    const b = parse(z.object({ key: z.string().min(3).max(120), kind: z.string().max(40), title: z.string().max(160), projectId: z.string().max(40).nullable().optional(), itemId: z.string().max(40).nullable().optional(), data: z.unknown() }), ctx.body);
    const size = JSON.stringify(b.data ?? null).length; if (size > 200000) throw bad('This draft is too large to save.');
    await db.query(`insert into drafts(user_id, key, kind, title, project_id, item_id, data, updated_at) values ($1,$2,$3,$4,$5,$6,$7, now())
      on conflict (user_id, key) do update set kind = excluded.kind, title = excluded.title, project_id = excluded.project_id, item_id = excluded.item_id, data = excluded.data, updated_at = now()`,
      [p.user.id, b.key, b.kind, b.title, b.projectId || null, b.itemId || null, JSON.stringify(b.data ?? null)]);
    return { ok: true, savedAt: Date.now() };
  });
  r.delete('/api/v1/drafts/:key', staff(), async ctx => {
    const p = userOf(ctx);
    await db.query('delete from drafts where user_id = $1 and key = $2', [p.user.id, decodeURIComponent(ctx.params.key)]);
    return { ok: true };
  });

}

/** drafts the person may see: their own, plus those on projects they manage or items they now own */
export async function loadDrafts(q: Q, p: U) {
  const rows = await many(q, `select d.*, u.name by_name from drafts d join users u on u.id = d.user_id
    left join projects pr on pr.id = d.project_id left join items i on i.id = d.item_id
    where d.updated_at > now() - interval '30 days' and (d.user_id = $1 or pr.pm_id = $1 or i.owner_id = $1 or $2)
    order by d.updated_at desc limit 200`, [p.user.id, p.perms.has('tasksAll')]);
  return rows.map(d => ({ key: d.key, kind: d.kind, title: d.title, projectId: d.project_id, itemId: d.item_id, by: d.user_id, byName: d.by_name, at: new Date(d.updated_at).getTime(), mine: d.user_id === p.user.id, data: d.data }));
}
