import { config } from '../core/config.js';
import { db, one, tx } from '../core/db.js';
import { log } from '../core/util.js';
import { routeInboundText } from '../modules/crm.js';
import { customerChange } from '../modules/customer.js';
import { approveDrawing, recordFeedback } from '../modules/ops.js';
import { taskAction } from '../modules/tasks.js';
import { onInbound, sendText } from './whatsapp.js';
/* Quick-reply payloads are put on our template buttons. They are only honoured when the phone that
   tapped the button owns the record (assignee for tasks, project customer for drawings and ratings). */
async function handleButton(m) {
    const [kind, id, extra] = String(m.buttonPayload).split(':');
    const user = await one(db, 'select id, name, role from users where phone = $1 and active', [m.from]);
    const link = `${config.APP_BASE_URL}`;
    try {
        if (kind.startsWith('TASK_')) {
            const t = await one(db, 'select t.*, a.phone a_phone, s.phone s_phone from tasks t join users a on a.id = t.assignee_id join users s on s.id = t.assigner_id where t.id = $1', [id]);
            if (!t || !user)
                return;
            const isAssignee = t.a_phone === m.from, isAssigner = t.s_phone === m.from;
            const isLead = isAssigner || ['admin', 'ops_head', 'pm'].includes(user.role) || t.ext_request?.to === user.id;
            if (kind === 'TASK_DONE' && isAssignee) {
                if (t.proof) {
                    await sendText(m.from, `“${t.title}” needs a ${t.proof} to complete. Please open the app: ${link}`);
                    return;
                }
                await tx(q => taskAction(q, user.id, id, 'done', { note: 'Marked done from WhatsApp' }));
                await sendText(m.from, `Done: ${t.title}. Thank you!`);
            }
            else if (kind === 'TASK_BLOCKED' && isAssignee) {
                await tx(q => taskAction(q, user.id, id, 'block', { reason: 'Waiting for another team' }));
                await sendText(m.from, `Marked blocked. Your manager has been told and will follow up in 2 days. Update who you are waiting on in the app: ${link}`);
            }
            else if (kind === 'TASK_START' && isAssignee) {
                await tx(q => taskAction(q, user.id, id, 'start'));
                await sendText(m.from, `Started: ${t.title}.`);
            }
            else if ((kind === 'TASK_EXTOK' || kind === 'TASK_EXTNO') && isLead) {
                try {
                    await tx(q => taskAction(q, user.id, id, kind === 'TASK_EXTOK' ? 'extend_ok' : 'extend_no', {}, new Set(user.role === 'admin' || user.role === 'ops_head' ? ['tasksAll'] : [])));
                    await sendText(m.from, kind === 'TASK_EXTOK' ? `Approved. ${t.title} now has the new deadline.` : `Rejected. The deadline for ${t.title} stays the same.`);
                }
                catch (e) {
                    await sendText(m.from, e?.message || 'Could not update the task.');
                }
            }
            else if (kind === 'TASK_NUDGE' && isLead) {
                await tx(q => taskAction(q, user.id, id, 'remind', {}, new Set(['tasksAll'])));
                await sendText(m.from, 'Reminder sent.');
            }
            else if (kind === 'TASK_OPEN' && (isAssignee || isLead)) {
                await sendText(m.from, `Open the task here: ${link}`);
            }
            return;
        }
        if (kind === 'DRAWING_APPROVE' || kind === 'DRAWING_CHANGE') {
            const it = await one(db, 'select i.id, i.code, c.phone from items i join projects p on p.id = i.project_id join customers c on c.id = p.customer_id where i.id = $1', [id]);
            if (!it || it.phone !== m.from)
                return;
            if (kind === 'DRAWING_APPROVE') {
                await tx(q => approveDrawing(q, id, 'whatsapp', 'customer'));
                await sendText(m.from, 'Thank you! Your approval is recorded and production can begin.');
            }
            else {
                await tx(q => customerChange(q, id, 'Customer tapped "Ask for a change" on WhatsApp — please call them', 'WhatsApp'));
                await sendText(m.from, 'Noted. Your designer will call you to understand the change.');
            }
            return;
        }
        if (kind === 'TICKET_RATE') {
            const t = await one(db, `select s.id, coalesce(s.contact_phone, c.phone) phone, c.phone cphone from service_requests s join projects p on p.id = s.project_id join customers c on c.id = p.customer_id where s.id = $1`, [Number(id)]);
            if (!t || (t.phone !== m.from && t.cphone !== m.from))
                return;
            const { handleTicketRating } = await import('../modules/support.js');
            await tx(q => handleTicketRating(q, String(m.buttonPayload)));
            await sendText(m.from, 'Thank you for your feedback!');
            return;
        }
        if (kind === 'RATE') {
            const p = await one(db, 'select p.id, c.phone from projects p join customers c on c.id = p.customer_id where p.id = $1', [id]);
            if (!p || p.phone !== m.from)
                return;
            await tx(q => recordFeedback(q, id, Math.max(1, Math.min(5, Number(extra) || 5)), '', 'WhatsApp'));
            await sendText(m.from, 'Thank you for your rating!');
        }
    }
    catch (e) {
        log.warn('button handling failed', m.buttonPayload, e?.message);
        await sendText(m.from, `Sorry, that could not be completed: ${e?.message || 'please use the app'}`);
    }
}
export function installInbound() {
    onInbound(async (m) => {
        if (m.buttonPayload)
            return handleButton(m);
        await routeInboundText(m.from, m.text || '', m.name, m.at);
    });
}
