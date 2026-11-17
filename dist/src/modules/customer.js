import { z } from 'zod';
import { db, many, one, tx } from '../core/db.js';
import { parse } from '../core/http.js';
import { addDays, bad, forbidden, notFound, todayStr } from '../core/util.js';
import { audit, customerOrPreview } from './auth.js';
import { act, approveDrawing, recordFeedback } from './ops.js';
import { customerState } from './state.js';
import { pushTask } from './tasks.js';
/** Resolve which customer the caller acts for and check they may touch this project. */
async function accessProject(q, ctx, pid) {
    const p = await one(q, 'select * from projects where id = $1', [pid]);
    if (!p)
        throw notFound('Project not found');
    if (ctx.auth?.type === 'customer' && ctx.auth.customer.id !== p.customer_id)
        throw forbidden();
    return p;
}
const via = (ctx) => ctx.auth?.type === 'customer' ? 'customer_app' : 'staff';
const reply = async (customerId) => ({ ok: true, state: await customerState(customerId) });
export async function customerChange(q, itemId, note, channel) {
    const it = await one(q, 'select i.*, p.pm_id from items i join projects p on p.id = i.project_id where i.id = $1', [itemId]);
    if (!it)
        throw notFound();
    const designer = it.designer_id || it.owner_id || it.pm_id;
    await pushTask(q, { title: `Customer change request · ${it.code}: ${note}`, projectId: it.project_id, itemId, assignee: designer, assigner: it.pm_id, deadline: addDays(2), priority: 'urgent', proof: 'file' });
    await act(q, it.project_id, `${it.code}: customer asked for a change (${channel}): ${note}`);
}
export async function customerComplaint(q, pid, text, channel) {
    const p = await one(q, 'select p.*, c.name from projects p join customers c on c.id = p.customer_id where p.id = $1', [pid]);
    if (!p)
        throw notFound();
    await pushTask(q, { title: `Customer complaint · ${p.name}: ${text}`, projectId: pid, assignee: p.pm_id, assigner: p.pm_id, deadline: addDays(1), priority: 'urgent' });
    await act(q, pid, `Customer complaint (${channel}): ${text}`);
}
export function customerRoutes(r) {
    r.get('/api/v1/customer/state', customerOrPreview, async (ctx) => {
        if (ctx.auth?.type === 'customer')
            return { state: await customerState(ctx.auth.customer.id) };
        const pid = ctx.query.get('projectId');
        if (!pid)
            throw bad('projectId is required for a staff preview');
        const p = await one(db, 'select customer_id from projects where id = $1', [pid]);
        if (!p)
            throw notFound();
        return { state: await customerState(p.customer_id) };
    });
    r.post('/api/v1/customer/items/:id/approve', customerOrPreview, async (ctx) => {
        const cid = await tx(async (q) => {
            const it = await one(q, 'select project_id from items where id = $1', [ctx.params.id]);
            if (!it)
                throw notFound();
            const p = await accessProject(q, ctx, it.project_id);
            await approveDrawing(q, ctx.params.id, via(ctx), ctx.auth?.type === 'user' ? ctx.auth.user.name : 'customer');
            return p.customer_id;
        });
        return reply(cid);
    });
    /* approve every drawing waiting in one go (the approval form) */
    r.post('/api/v1/customer/projects/:id/approve-all', customerOrPreview, async (ctx) => {
        const cid = await tx(async (q) => {
            const p = await accessProject(q, ctx, ctx.params.id);
            const items = await many(q, `select i.id from items i where i.project_id = $1 and i.stage = 'drawing' and exists (select 1 from documents d where d.item_id = i.id and d.kind = 'drawing' and d.approved_at is null and d.id = (select max(id) from documents where item_id = i.id and kind = 'drawing'))`, [p.id]);
            if (!items.length)
                throw bad('There is nothing waiting for your approval.');
            for (const i of items)
                await approveDrawing(q, i.id, via(ctx), ctx.auth?.type === 'user' ? ctx.auth.user.name : 'customer');
            return p.customer_id;
        });
        return reply(cid);
    });
    r.post('/api/v1/customer/items/:id/change-request', customerOrPreview, async (ctx) => {
        const b = parse(z.object({ note: z.string().trim().min(2).max(500) }), ctx.body);
        const cid = await tx(async (q) => {
            const it = await one(q, 'select project_id from items where id = $1', [ctx.params.id]);
            if (!it)
                throw notFound();
            const p = await accessProject(q, ctx, it.project_id);
            await customerChange(q, ctx.params.id, b.note, 'customer app');
            return p.customer_id;
        });
        return reply(cid);
    });
    r.post('/api/v1/customer/projects/:id/complaint', customerOrPreview, async (ctx) => {
        const b = parse(z.object({ text: z.string().trim().min(2).max(1000) }), ctx.body);
        const cid = await tx(async (q) => { const p = await accessProject(q, ctx, ctx.params.id); await customerComplaint(q, p.id, b.text, 'customer app'); return p.customer_id; });
        return reply(cid);
    });
    r.post('/api/v1/customer/projects/:id/feedback', customerOrPreview, async (ctx) => {
        const b = parse(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(500).default('') }), ctx.body);
        const cid = await tx(async (q) => {
            const p = await accessProject(q, ctx, ctx.params.id);
            const open = await one(q, `select count(*) n from items where project_id = $1 and stage <> 'closed'`, [p.id]);
            if (Number(open.n) > 0)
                throw bad('You can rate us once every piece is installed and handed over.');
            await recordFeedback(q, p.id, b.rating, b.comment, 'customer app');
            if (ctx.auth?.type === 'customer')
                await audit(q, ctx.auth, 'feedback', `Customer rated ${b.rating}/5`, 'project', p.id);
            return p.customer_id;
        });
        return reply(cid);
    });
}
export { todayStr };
