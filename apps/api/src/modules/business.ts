/* v1.5 — partners management, quotations, payment receipts, GST invoices, change orders,
 * factory production steps, snag cost, warranty + after-sales service, CSV exports, company profile. */
import { z } from 'zod';
import { db, many, one, tx, type Q } from '../core/db.js';
import { parse, send, type Ctx, type Router } from '../core/http.js';
import { addDays, bad, forbidden, normPhone, notFound, todayStr } from '../core/util.js';
import { COMPANY_DEFAULT, fyLabel, PAY_MODES, PRODUCTION_STEPS, quoteTotals, SNAG_PAYERS } from '../domain.js';
import { audit, can, customerOrPreview, staff, userOf } from './auth.js';
import { act } from './ops.js';
import { customerState, staffState } from './state.js';
import { pushTask } from './tasks.js';

const done = async (ctx: Ctx, extra: Record<string, unknown> = {}) => ({ ok: true, ...extra, state: await staffState(userOf(ctx)) });
const rupees = (n: number) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const DateZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fileRef = z.string().regex(/^upload:[A-Za-z0-9_-]+\.(pdf|jpg|png|webp)$/);

export async function company(q: Q = db) {
  const v = (await one(q, `select value from settings where key = 'company'`))?.value || {};
  return { ...COMPANY_DEFAULT, ...v } as typeof COMPANY_DEFAULT;
}

/* ---------- partners ---------- */
const PartnerZ = z.object({
  name: z.string().trim().min(2).max(80), firm: z.string().trim().max(120).default(''), type: z.enum(['architect', 'contractor', 'agent']),
  phone: z.string().default(''), email: z.string().trim().max(120).default(''), city: z.string().trim().max(60).default(''),
  tier: z.enum(['Silver', 'Gold', 'Platinum']).default('Silver'), rate: z.coerce.number().min(0).max(30).default(0),
  owner: z.string().nullable().default(null), notes: z.string().max(1000).default(''), active: z.boolean().default(true)
});
export async function createPartner(q: Q, by: ReturnType<typeof userOf>, b: z.infer<typeof PartnerZ>) {
  const phone = b.phone ? normPhone(b.phone) : null;
  if (b.phone && !phone) throw bad('Enter a 10-digit WhatsApp number for the partner.');
  if (phone) { const dup = await one(q, 'select name from partners where phone = $1', [phone]); if (dup) throw bad(`${dup.name} already uses this number.`); }
  if (b.owner && !(await one(q, 'select 1 from users where id = $1 and active', [b.owner]))) throw bad('Choose an active relationship owner.');
  const id = 'p' + (await one(q, `select nextval('partner_seq') n`))!.n;
  await q.query(`insert into partners(id, name, firm, type, tier, rate, owner_id, phone, email, city, notes, active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, b.name, b.firm, b.type, b.tier, b.rate, b.owner, phone, b.email, b.city, b.notes, b.active]);
  await audit(q, by, 'partner.create', `Added partner ${b.name}${b.firm ? ' (' + b.firm + ')' : ''}`, 'partner', id);
  return id;
}

/* ---------- payments: a milestone is received once receipts cover it ---------- */
async function settleMilestones(q: Q, pid: string, byId: string) {
  const ms = await many(q, 'select * from payment_milestones where project_id = $1 order by sort, id', [pid]);
  for (const m of ms) {
    const paid = Number((await one(q, 'select coalesce(sum(amount),0) s from payment_receipts where milestone_id = $1', [m.id]))!.s);
    if (paid >= m.amount && m.amount > 0 && !m.received_at) {
      await q.query('update payment_milestones set received_at = now(), received_by = $2 where id = $1', [m.id, byId]);
      await act(q, pid, `Payment milestone complete: ${m.label} (${rupees(m.amount)})`);
    }
  }
}
async function rebalanceMilestones(q: Q, pid: string) {
  // After an approved change order, unpaid milestones are re-spread over the new project value (paid ones stay as they were).
  const p = await one(q, 'select value from projects where id = $1', [pid]);
  const ms = await many(q, 'select * from payment_milestones where project_id = $1 order by sort, id', [pid]);
  const paid = ms.filter(m => m.received_at).reduce((s, m) => s + m.amount, 0);
  const open = ms.filter(m => !m.received_at), openPct = open.reduce((s, m) => s + m.pct, 0) || 1;
  const remaining = Math.max(0, p!.value - paid);
  let left = remaining;
  for (const [i, m] of open.entries()) {
    const amt = i === open.length - 1 ? left : Math.round(remaining * m.pct / openPct);
    left -= amt; await q.query('update payment_milestones set amount = $2 where id = $1', [m.id, amt]);
  }
}

/* ---------- CSV ---------- */
const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (rows: Record<string, unknown>[]) => rows.length ? [Object.keys(rows[0]).join(','), ...rows.map(r => Object.values(r).map(csvCell).join(','))].join('\n') : '';

export async function partnerStats(q: Q = db) {
  return many(q, `
    select pt.id,
      count(l.id)::int leads,
      count(l.id) filter (where l.stage not in ('won','lost'))::int open,
      coalesce(sum(l.value) filter (where l.stage not in ('won','lost')),0)::bigint pipeline,
      count(l.id) filter (where l.stage = 'won')::int won,
      coalesce(sum(l.value) filter (where l.stage = 'won'),0)::bigint won_value,
      coalesce((select sum(p.value) from projects p join leads l2 on l2.id = p.lead_id where l2.ref_partner_id = pt.id),0)::bigint project_value,
      coalesce((select sum(c.amount) from commissions c where c.partner_id = pt.id),0)::bigint commission,
      coalesce((select sum(c.amount) from commissions c where c.partner_id = pt.id and c.status = 'paid'),0)::bigint commission_paid,
      max(l.created_at) last_lead
    from partners pt left join leads l on l.ref_partner_id = pt.id group by pt.id`);
}

export function businessRoutes(r: Router) {
  /* company profile (for quotes, receipts, invoices) */
  r.get('/api/v1/settings/company', staff(), async () => ({ company: await company() }));
  r.put('/api/v1/settings/company', staff('admin'), async ctx => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(120), legalName: z.string().max(160).default(''), gstin: z.string().trim().toUpperCase().regex(/^$|^[0-9A-Z]{15}$/, 'GSTIN has 15 letters and digits').default(''),
      address: z.string().max(400).default(''), phone: z.string().max(40).default(''), email: z.string().max(120).default(''), website: z.string().max(120).default(''), bank: z.string().max(400).default(''),
      hsn: z.string().max(10).default('9403'), gstPct: z.coerce.number().min(0).max(28).default(18), warrantyYears: z.coerce.number().int().min(0).max(25).default(10),
      quoteValidityDays: z.coerce.number().int().min(1).max(90).default(15), quoteTerms: z.string().max(2000).default('') }), ctx.body);
    await db.query(`insert into settings(key, value) values ('company', $1) on conflict (key) do update set value = excluded.value`, [JSON.stringify(b)]);
    await audit(db, userOf(ctx), 'company', 'Company profile updated', 'settings', 'company');
    return { ok: true, company: await company() };
  });

  /* partners */
  r.post('/api/v1/partners', staff('crm'), async ctx => {
    const b = parse(PartnerZ, ctx.body);
    const id = await tx(q => createPartner(q, userOf(ctx), b));
    return done(ctx, { id });
  });
  r.patch('/api/v1/partners/:id', staff('crm'), async ctx => {
    const b = parse(PartnerZ.partial(), ctx.body);
    await tx(async q => {
      const p = await one(q, 'select * from partners where id = $1 for update', [ctx.params.id]); if (!p) throw notFound('Partner not found');
      let phone = p.phone;
      if (b.phone !== undefined) {
        phone = b.phone ? normPhone(b.phone) : null; if (b.phone && !phone) throw bad('Enter a 10-digit WhatsApp number.');
        if (phone) { const dup = await one(q, 'select name from partners where phone = $1 and id <> $2', [phone, p.id]); if (dup) throw bad(`${dup.name} already uses this number.`); }
      }
      if (b.type && b.type !== p.type && (await one(q, 'select 1 from leads where ref_partner_id = $1 limit 1', [p.id]))) throw bad('This partner already has leads; their type can no longer change.');
      await q.query(`update partners set name = $2, firm = $3, type = $4, tier = $5, rate = $6, owner_id = $7, phone = $8, email = $9, city = $10, notes = $11, active = $12 where id = $1`,
        [p.id, b.name ?? p.name, b.firm ?? p.firm, b.type ?? p.type, b.tier ?? p.tier, b.rate ?? p.rate, b.owner !== undefined ? b.owner : p.owner_id, phone, b.email ?? p.email, b.city ?? p.city, b.notes ?? p.notes, b.active ?? p.active]);
      await audit(q, userOf(ctx), 'partner.update', `Updated partner ${b.name ?? p.name}`, 'partner', p.id);
    });
    return done(ctx);
  });
  r.post('/api/v1/commissions/:id/paid', staff('money'), async ctx => {
    const b = parse(z.object({ paid: z.boolean() }), ctx.body);
    await tx(async q => {
      const c = await one(q, 'select c.*, p.name from commissions c join partners p on p.id = c.partner_id where c.id = $1', [Number(ctx.params.id)]); if (!c) throw notFound();
      await q.query('update commissions set status = $2 where id = $1', [c.id, b.paid ? 'paid' : 'pending']);
      await audit(q, userOf(ctx), 'commission', `Commission ${rupees(c.amount)} to ${c.name} marked ${b.paid ? 'paid' : 'pending'}`, 'partner', c.partner_id);
    });
    return done(ctx);
  });

  /* quotations (BOQ) per lead, with revisions */
  const LineZ = z.object({ room: z.string().max(60).default(''), item: z.string().trim().min(1).max(120), desc: z.string().max(400).default(''), size: z.string().max(60).default(''), qty: z.coerce.number().min(0).max(10000), unit: z.string().max(12).default('nos'), rate: z.coerce.number().min(0).max(1e8) });
  const QuoteZ = z.object({ lines: z.array(LineZ).min(1).max(200), discount: z.coerce.number().min(0).default(0), gstPct: z.coerce.number().min(0).max(28).default(18), notes: z.string().max(2000).default('') });
  r.post('/api/v1/leads/:id/quotes', staff('crm'), async ctx => {
    const b = parse(QuoteZ, ctx.body); const p = userOf(ctx);
    const out = await tx(async q => {
      const l = await one(q, 'select * from leads where id = $1', [ctx.params.id]); if (!l) throw notFound('Lead not found');
      const t = quoteTotals(b.lines, b.discount, b.gstPct);
      if (b.discount > t.subtotal) throw bad('Discount is more than the quotation value.');
      const rev = Number((await one(q, 'select coalesce(max(rev), -1) + 1 n from quotes where lead_id = $1', [l.id]))!.n);
      await q.query(`update quotes set status = 'superseded' where lead_id = $1 and status in ('draft','sent')`, [l.id]);
      const row = await one(q, `insert into quotes(lead_id, rev, lines, discount, gst_pct, subtotal, total, notes, status, by_id) values ($1,$2,$3,$4,$5,$6,$7,$8,'sent',$9) returning id`,
        [l.id, rev, JSON.stringify(b.lines), b.discount, b.gstPct, t.subtotal, t.total, b.notes, p.user.id]);
      await q.query('update leads set value = $2 where id = $1', [l.id, t.total]);
      await q.query(`insert into lead_timeline(lead_id, text) values ($1, $2)`, [l.id, `Quotation R${rev} prepared · ${rupees(t.total)} incl. GST (${p.user.name})`]);
      return { quoteId: row!.id, rev };
    });
    return done(ctx, out);
  });
  r.post('/api/v1/quotes/:id/accept', staff('crm'), async ctx => {
    await tx(async q => {
      const qt = await one(q, 'select * from quotes where id = $1', [Number(ctx.params.id)]); if (!qt) throw notFound();
      if (qt.status === 'superseded') throw bad('A newer revision exists. Accept the latest quotation.');
      await q.query(`update quotes set status = 'accepted', accepted_at = now() where id = $1`, [qt.id]);
      if (qt.lead_id) {
        await q.query('update leads set value = $2 where id = $1', [qt.lead_id, Math.round(Number(qt.total))]);
        await q.query(`insert into lead_timeline(lead_id, text) values ($1, $2)`, [qt.lead_id, `Quotation R${qt.rev} accepted by the client · ${rupees(qt.total)}`]);
      }
    });
    return done(ctx);
  });

  /* payment receipts */
  r.post('/api/v1/projects/:id/receipts', staff('payments'), async ctx => {
    const b = parse(z.object({ amount: z.coerce.number().positive().max(1e9), paidOn: DateZ.default(todayStr()), mode: z.enum(PAY_MODES), reference: z.string().trim().max(80).default(''), milestoneId: z.coerce.number().int().nullable().default(null), note: z.string().max(300).default('') }), ctx.body);
    const p = userOf(ctx);
    const out = await tx(async q => {
      const pr = await one(q, 'select * from projects where id = $1', [ctx.params.id]); if (!pr) throw notFound();
      if (b.mode !== 'Cash' && !b.reference) throw bad('Add the UTR / cheque / transaction reference.');
      let mid = b.milestoneId;
      if (mid && !(await one(q, 'select 1 from payment_milestones where id = $1 and project_id = $2', [mid, pr.id]))) throw bad('That milestone is not on this project.');
      if (!mid) mid = (await one(q, 'select id from payment_milestones where project_id = $1 and received_at is null order by sort, id limit 1', [pr.id]))?.id || null;
      const n = (await one(q, `select nextval('receipt_seq') n`))!.n;
      const receiptNo = `RCPT/${fyLabel()}/${String(n).padStart(4, '0')}`;
      const row = await one(q, `insert into payment_receipts(project_id, milestone_id, receipt_no, amount, paid_on, mode, reference, note, by_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [pr.id, mid, receiptNo, b.amount, b.paidOn, b.mode, b.reference, b.note, p.user.id]);
      await act(q, pr.id, `Payment received ${rupees(b.amount)} by ${b.mode}${b.reference ? ' (' + b.reference + ')' : ''} · receipt ${receiptNo} (${p.user.name})`);
      await settleMilestones(q, pr.id, p.user.id);
      await audit(q, p, 'receipt', `Receipt ${receiptNo} ${rupees(b.amount)} on ${pr.code}`, 'project', pr.id);
      return { receiptId: row!.id, receiptNo };
    });
    return done(ctx, out);
  });
  r.delete('/api/v1/receipts/:id', staff('admin'), async ctx => {
    await tx(async q => {
      const rc = await one(q, 'select * from payment_receipts where id = $1', [Number(ctx.params.id)]); if (!rc) throw notFound();
      await q.query('delete from payment_receipts where id = $1', [rc.id]);
      if (rc.milestone_id) {
        const left = Number((await one(q, 'select coalesce(sum(amount),0) s from payment_receipts where milestone_id = $1', [rc.milestone_id]))!.s);
        const m = await one(q, 'select amount from payment_milestones where id = $1', [rc.milestone_id]);
        if (m && left < m.amount) await q.query('update payment_milestones set received_at = null, received_by = null where id = $1', [rc.milestone_id]);
      }
      await act(q, rc.project_id, `Receipt ${rc.receipt_no} cancelled (${userOf(ctx).user.name})`);
      await audit(q, userOf(ctx), 'receipt.cancel', `Cancelled receipt ${rc.receipt_no}`, 'project', rc.project_id);
    });
    return done(ctx);
  });

  /* GST tax invoices */
  r.post('/api/v1/projects/:id/invoices', staff('money'), async ctx => {
    const b = parse(z.object({ description: z.string().trim().min(2).max(300), taxable: z.coerce.number().positive().max(1e9), gstPct: z.coerce.number().min(0).max(28).optional(), date: DateZ.default(todayStr()) }), ctx.body);
    const p = userOf(ctx);
    const out = await tx(async q => {
      const pr = await one(q, 'select * from projects where id = $1', [ctx.params.id]); if (!pr) throw notFound();
      const c = await company(q);
      const pct = b.gstPct ?? c.gstPct, fy = fyLabel(new Date(b.date));
      await q.query(`insert into invoice_seq(fy, n) values ($1, 0) on conflict do nothing`, [fy]);
      const n = (await one(q, `update invoice_seq set n = n + 1 where fy = $1 returning n`, [fy]))!.n;
      const invoiceNo = `MMS/${fy}/${String(n).padStart(3, '0')}`;
      const gst = Math.round(b.taxable * pct) / 100, total = Math.round((b.taxable + gst) * 100) / 100;
      const row = await one(q, `insert into invoices(project_id, invoice_no, invoice_date, description, taxable, gst_pct, gst, total, by_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [pr.id, invoiceNo, b.date, b.description, b.taxable, pct, gst, total, p.user.id]);
      await act(q, pr.id, `Tax invoice ${invoiceNo} raised · ${rupees(total)} (${p.user.name})`);
      await audit(q, p, 'invoice', `Invoice ${invoiceNo} ${rupees(total)} on ${pr.code}`, 'project', pr.id);
      return { invoiceId: row!.id, invoiceNo };
    });
    return done(ctx, out);
  });

  /* printable documents: quote, receipt, invoice, snag reorder slip (open → browser print / save as PDF) */
  r.get('/api/v1/print/:kind/:id', staff(), async ctx => {
    const kind = ctx.params.kind, id = ctx.params.id;
    const c = await company();
    const money = can(ctx, 'money') || can(ctx, 'payments');
    let title = '', body = '';
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
    const inr = (n: unknown) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (kind === 'quote') {
      if (!can(ctx, 'crm') && !money) throw forbidden();
      const qt = await one(db, 'select q.*, l.name, l.phone, l.area, u.name by_name from quotes q left join leads l on l.id = q.lead_id left join users u on u.id = q.by_id where q.id = $1', [Number(id)]); if (!qt) throw notFound();
      const lines = qt.lines as any[], t = quoteTotals(lines, Number(qt.discount), Number(qt.gst_pct));
      title = `Quotation Q-${qt.lead_id}-R${qt.rev}`;
      body = `<h2>Quotation</h2><div class="meta"><div><b>To</b><br>${esc(qt.name)}<br>${esc(qt.phone)}${qt.area ? '<br>' + esc(qt.area) : ''}</div><div><b>No.</b> Q-${esc(qt.lead_id)}-R${qt.rev}<br><b>Date</b> ${new Date(qt.created_at).toLocaleDateString('en-IN')}<br><b>Valid for</b> ${c.quoteValidityDays} days<br><b>Prepared by</b> ${esc(qt.by_name || '')}</div></div>
        <table><thead><tr><th>#</th><th>Room</th><th>Item</th><th>Size</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>
        ${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.room)}</td><td><b>${esc(l.item)}</b>${l.desc ? '<br><small>' + esc(l.desc) + '</small>' : ''}</td><td>${esc(l.size)}</td><td class="r">${esc(l.qty)} ${esc(l.unit || '')}</td><td class="r">${inr(l.rate)}</td><td class="r">${inr(l.qty * l.rate)}</td></tr>`).join('')}
        </tbody><tfoot><tr><td colspan="6" class="r">Subtotal</td><td class="r">${inr(t.subtotal)}</td></tr>${Number(qt.discount) ? `<tr><td colspan="6" class="r">Discount</td><td class="r">− ${inr(qt.discount)}</td></tr>` : ''}
        <tr><td colspan="6" class="r">GST ${Number(qt.gst_pct)}%</td><td class="r">${inr(t.total - t.taxable)}</td></tr><tr class="grand"><td colspan="6" class="r">Total</td><td class="r">₹ ${inr(t.total)}</td></tr></tfoot></table>
        ${qt.notes ? `<p>${esc(qt.notes)}</p>` : ''}<h4>Terms</h4><p>${esc(c.quoteTerms)}</p><p>Warranty: ${c.warrantyYears} years on carcass and hardware against manufacturing defects.</p>`;
    } else if (kind === 'receipt') {
      if (!money) throw forbidden();
      const rc = await one(db, 'select r.*, p.code, p.address, c.name, c.phone, m.label from payment_receipts r join projects p on p.id = r.project_id join customers c on c.id = p.customer_id left join payment_milestones m on m.id = r.milestone_id where r.id = $1', [Number(id)]); if (!rc) throw notFound();
      title = `Receipt ${rc.receipt_no}`;
      body = `<h2>Payment receipt</h2><div class="meta"><div><b>Received from</b><br>${esc(rc.name)}<br>${esc(rc.phone)}<br>${esc(rc.address)}</div><div><b>Receipt</b> ${esc(rc.receipt_no)}<br><b>Date</b> ${new Date(rc.paid_on).toLocaleDateString('en-IN')}<br><b>Project</b> ${esc(rc.code)}</div></div>
        <table><tbody><tr><td>Amount received</td><td class="r"><b>₹ ${inr(rc.amount)}</b></td></tr><tr><td>Mode</td><td class="r">${esc(rc.mode)}</td></tr><tr><td>Reference</td><td class="r">${esc(rc.reference || '—')}</td></tr><tr><td>Against</td><td class="r">${esc(rc.label || 'On account')}</td></tr>${rc.note ? `<tr><td>Note</td><td class="r">${esc(rc.note)}</td></tr>` : ''}</tbody></table>
        <p class="sign">For ${esc(c.legalName || c.name)}<br><br>Authorised signatory</p>`;
    } else if (kind === 'invoice') {
      if (!money) throw forbidden();
      const iv = await one(db, 'select i.*, p.code, p.address, c.name, c.phone from invoices i join projects p on p.id = i.project_id join customers c on c.id = p.customer_id where i.id = $1', [Number(id)]); if (!iv) throw notFound();
      const half = Number(iv.gst) / 2;
      title = `Tax invoice ${iv.invoice_no}`;
      body = `<h2>Tax invoice</h2><div class="meta"><div><b>Bill to</b><br>${esc(iv.name)}<br>${esc(iv.phone)}<br>${esc(iv.address)}</div><div><b>Invoice</b> ${esc(iv.invoice_no)}<br><b>Date</b> ${new Date(iv.invoice_date).toLocaleDateString('en-IN')}<br><b>Project</b> ${esc(iv.code)}<br><b>Place of supply</b> ${esc((c.address.split(',').pop() || '').trim())}</div></div>
        <table><thead><tr><th>Description</th><th>HSN</th><th class="r">Taxable value</th></tr></thead><tbody><tr><td>${esc(iv.description)}</td><td>${esc(c.hsn)}</td><td class="r">${inr(iv.taxable)}</td></tr></tbody>
        <tfoot><tr><td colspan="2" class="r">CGST ${Number(iv.gst_pct) / 2}%</td><td class="r">${inr(half)}</td></tr><tr><td colspan="2" class="r">SGST ${Number(iv.gst_pct) / 2}%</td><td class="r">${inr(half)}</td></tr><tr class="grand"><td colspan="2" class="r">Total</td><td class="r">₹ ${inr(iv.total)}</td></tr></tfoot></table>
        ${c.bank ? `<h4>Bank details</h4><p>${esc(c.bank)}</p>` : ''}<p class="sign">For ${esc(c.legalName || c.name)}<br><br>Authorised signatory</p>`;
    } else if (kind === 'snag') {
      const s = await one(db, 'select s.*, i.code, i.room_name, i.type, i.spec, p.code pcode, p.address from snags s join items i on i.id = s.item_id join projects p on p.id = i.project_id where s.id = $1', [id]); if (!s) throw notFound();
      title = `Reorder slip ${s.id}`;
      const spec = s.spec || {};
      body = `<h2>Snag reorder slip</h2><div class="meta"><div><b>Project</b> ${esc(s.pcode)}<br>${esc(s.address)}</div><div><b>Snag</b> ${esc(s.id)}<br><b>Raised</b> ${new Date(s.created_at).toLocaleDateString('en-IN')}<br><b>Vendor</b> ${esc(s.vendor || '—')}</div></div>
        <table><tbody><tr><td>Item</td><td>${esc(s.code)} · ${esc(s.room_name)}</td></tr><tr><td>Part to replace</td><td><b>${esc(s.part)}</b></td></tr><tr><td>Problem</td><td>${esc(s.type)}${s.note ? ' — ' + esc(s.note) : ''}</td></tr>
        ${['carcass', 'shutter', 'finish', 'edge', 'hardware', 'handles'].filter(k => spec[k]).map(k => `<tr><td>${k[0].toUpperCase() + k.slice(1)}</td><td>${esc(spec[k])}</td></tr>`).join('')}
        <tr><td>Cost</td><td>${s.cost !== null ? '₹ ' + inr(s.cost) : '—'}${s.payer ? ' · borne by ' + esc(s.payer) : ''}</td></tr></tbody></table>`;
    } else throw notFound();
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
      body{font:13px/1.5 Inter,system-ui,Arial,sans-serif;color:#1A1A1A;max-width:780px;margin:24px auto;padding:0 24px}
      header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #1A1A1A;padding-bottom:10px}
      header b{font-size:18px;letter-spacing:.02em}header .co{text-align:right;font-size:12px;color:#555}
      h2{font-size:20px;margin:20px 0 8px;text-transform:uppercase;letter-spacing:.08em}h4{margin:18px 0 4px}
      .meta{display:flex;justify-content:space-between;gap:24px;margin:10px 0 16px}
      table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border-bottom:1px solid #ddd;padding:7px 6px;text-align:left;vertical-align:top}
      th{border-bottom:2px solid #1A1A1A;font-size:11px;text-transform:uppercase;letter-spacing:.08em}.r{text-align:right}
      tfoot td{border:0}.grand td{border-top:2px solid #1A1A1A;font-weight:700;font-size:15px}small{color:#666}
      .sign{margin-top:48px;text-align:right}.bar{position:sticky;top:0;background:#F7F4F0;padding:8px;margin:-24px -24px 16px;text-align:right}
      .bar button{background:#F40009;color:#fff;border:0;padding:8px 16px;font-weight:600;cursor:pointer}@media print{.bar{display:none}body{margin:0}}
    </style></head><body><div class="bar"><button onclick="print()">Print / Save as PDF</button></div>
    <header><b>${esc(c.name)}</b><div class="co">${esc(c.legalName)}${c.legalName ? '<br>' : ''}${esc(c.address)}<br>${esc(c.phone)} · ${esc(c.email)}${c.gstin ? '<br>GSTIN ' + esc(c.gstin) : ''}</div></header>${body}</body></html>`;
    send(ctx.res, 200, page, { 'Content-Type': 'text/html; charset=utf-8' });
  });

  /* change orders (price / scope changes after approval) */
  r.post('/api/v1/projects/:id/change-orders', staff('edit'), async ctx => {
    const b = parse(z.object({ description: z.string().trim().min(3).max(500), amount: z.coerce.number().min(-1e8).max(1e8), days: z.coerce.number().int().min(0).max(120).default(0), itemId: z.string().nullable().default(null) }), ctx.body);
    const p = userOf(ctx);
    await tx(async q => {
      const pr = await one(q, 'select * from projects where id = $1', [ctx.params.id]); if (!pr) throw notFound();
      if (b.itemId && !(await one(q, 'select 1 from items where id = $1 and project_id = $2', [b.itemId, pr.id]))) throw bad('That item is not on this project.');
      await q.query(`insert into change_orders(project_id, item_id, description, amount, days, by_id) values ($1,$2,$3,$4,$5,$6)`, [pr.id, b.itemId, b.description, b.amount, b.days, p.user.id]);
      await act(q, pr.id, `Change order raised: ${b.description} (${b.amount >= 0 ? '+' : '−'}${rupees(Math.abs(b.amount))}${b.days ? ', +' + b.days + ' days' : ''}) — waiting for the client (${p.user.name})`);
    });
    return done(ctx);
  });
  async function decideChange(q: Q, coId: number, approve: boolean, via: string, projectGuard?: (pid: string) => Promise<void>) {
    const co = await one(q, 'select * from change_orders where id = $1 for update', [coId]); if (!co) throw notFound();
    if (projectGuard) await projectGuard(co.project_id);
    if (co.status !== 'pending') throw bad('This change was already decided.');
    await q.query(`update change_orders set status = $2, decided_via = $3, decided_at = now() where id = $1`, [co.id, approve ? 'approved' : 'rejected', via]);
    if (approve) {
      await q.query('update projects set value = value + $2 where id = $1', [co.project_id, Math.round(Number(co.amount))]);
      await rebalanceMilestones(q, co.project_id);
      if (co.days) {
        await q.query(`update projects set target = target + $2::int where id = $1`, [co.project_id, co.days]);
        if (co.item_id) await q.query(`update items set target = target + $2::int where id = $1`, [co.item_id, co.days]);
      }
    }
    await act(q, co.project_id, `Change order ${approve ? 'approved' : 'declined'} (${via}): ${co.description}`);
    return co;
  }
  r.post('/api/v1/change-orders/:id/decide', staff('money'), async ctx => {
    const b = parse(z.object({ approve: z.boolean() }), ctx.body);
    await tx(q => decideChange(q, Number(ctx.params.id), b.approve, `recorded by ${userOf(ctx).user.name}`));
    return done(ctx);
  });
  r.post('/api/v1/customer/change-orders/:id/decide', customerOrPreview, async ctx => {
    const b = parse(z.object({ approve: z.boolean() }), ctx.body);
    const cid = await tx(async q => {
      let cust = 0;
      await decideChange(q, Number(ctx.params.id), b.approve, 'customer app', async pid => {
        const p = await one(q, 'select customer_id from projects where id = $1', [pid]);
        if (ctx.auth?.type === 'customer' && ctx.auth.customer.id !== p!.customer_id) throw forbidden();
        cust = p!.customer_id;
      });
      return cust;
    });
    return { ok: true, state: await customerState(cid) };
  });

  /* factory production steps: production is complete when every step is ticked */
  r.post('/api/v1/items/:id/production', staff('edit'), async ctx => {
    const b = parse(z.object({ step: z.enum(PRODUCTION_STEPS.map(s => s.id) as [string, ...string[]]), done: z.boolean() }), ctx.body);
    await tx(async q => {
      const it = await one(q, 'select * from items where id = $1 for update', [ctx.params.id]); if (!it) throw notFound();
      const steps = { ...(it.production_steps || {}) };
      if (b.done) steps[b.step] = new Date().toISOString(); else delete steps[b.step];
      const all = PRODUCTION_STEPS.every(s => steps[s.id]);
      await q.query('update items set production_steps = $2, production_done = $3 where id = $1', [it.id, JSON.stringify(steps), all]);
      const name = PRODUCTION_STEPS.find(s => s.id === b.step)!.name;
      await act(q, it.project_id, `${it.code}: ${name} ${b.done ? 'done' : 'unmarked'} (${userOf(ctx).user.name})${all && !it.production_done ? ' · factory production complete' : ''}`);
    });
    return done(ctx);
  });

  /* snag cost and who bears it */
  r.patch('/api/v1/snags/:sid', staff('edit'), async ctx => {
    const b = parse(z.object({ cost: z.coerce.number().min(0).max(1e7).nullable().optional(), payer: z.enum(['', ...SNAG_PAYERS]).optional(), vendor: z.string().max(80).optional() }), ctx.body);
    await tx(async q => {
      const s = await one(q, 'select s.*, i.project_id, i.code from snags s join items i on i.id = s.item_id where s.id = $1', [ctx.params.sid]); if (!s) throw notFound();
      await q.query('update snags set cost = $2, payer = $3, vendor = $4, updated_at = now() where id = $1', [s.id, b.cost !== undefined ? b.cost : s.cost, b.payer ?? s.payer, b.vendor ?? s.vendor]);
      if (b.cost !== undefined || b.payer) await act(q, s.project_id, `${s.code}: snag ${s.part} cost ${b.cost != null ? rupees(b.cost) : '—'}${b.payer ? ', borne by ' + b.payer : ''}`);
    });
    return done(ctx);
  });

  /* after-sales service: see support.ts */

  /* CSV exports */
  r.get('/api/v1/export/:what', staff(), async ctx => {
    const what = ctx.params.what; let rows: Record<string, unknown>[] = [];
    const need = (perm: Parameters<typeof can>[1]) => { if (!can(ctx, perm)) throw forbidden(); };
    if (what === 'leads') {
      need('crm');
      rows = (await many(db, `select l.id, l.created_at::date created, l.name, l.phone, l.source, l.sub, coalesce(pt.name, '') partner, l.stage, coalesce(u.name,'') owner, l.value, l.interest, l.area, l.follow_up, l.lost_reason from leads l left join partners pt on pt.id = l.ref_partner_id left join users u on u.id = l.owner_id order by l.created_at desc`));
    } else if (what === 'partners') {
      need('crm');
      const st = new Map((await partnerStats()).map(s => [s.id, s]));
      rows = (await many(db, 'select p.*, u.name owner from partners p left join users u on u.id = p.owner_id order by p.name')).map(p => { const s: any = st.get(p.id) || {}; return { id: p.id, name: p.name, firm: p.firm, type: p.type, tier: p.tier, phone: p.phone, email: p.email, city: p.city, owner: p.owner || '', commission_pct: p.rate, active: p.active, leads: s.leads, open_pipeline: s.pipeline, won: s.won, won_value: s.won_value, project_value: s.project_value, commission: s.commission, commission_paid: s.commission_paid }; });
    } else if (what === 'projects') {
      need('money');
      rows = await many(db, `select p.code, c.name customer, c.phone, p.address, u.name pm, p.value, coalesce((select sum(amount) from payment_receipts r where r.project_id = p.id),0) received, p.target, p.created_at::date created,
        (select count(*) from items i where i.project_id = p.id) items, (select count(*) from items i where i.project_id = p.id and i.stage = 'closed') closed, p.feedback_rating from projects p join customers c on c.id = p.customer_id left join users u on u.id = p.pm_id order by p.created_at desc`);
    } else if (what === 'payments') {
      need('money');
      rows = await many(db, `select r.receipt_no, r.paid_on, p.code project, c.name customer, r.amount, r.mode, r.reference, coalesce(m.label,'') milestone, coalesce(u.name,'') recorded_by from payment_receipts r join projects p on p.id = r.project_id join customers c on c.id = p.customer_id left join payment_milestones m on m.id = r.milestone_id left join users u on u.id = r.by_id order by r.paid_on desc, r.id desc`);
    } else if (what === 'invoices') {
      need('money');
      rows = await many(db, `select i.invoice_no, i.invoice_date, p.code project, c.name customer, i.description, i.taxable, i.gst_pct, i.gst, i.total from invoices i join projects p on p.id = i.project_id join customers c on c.id = p.customer_id order by i.invoice_date desc, i.id desc`);
    } else if (what === 'installer-hours') {
      need('ops');
      rows = await many(db, `select u.name installer, i.code item, p.code project, w.start_at::date day, round(extract(epoch from (coalesce(w.end_at, now()) - w.start_at)) / 3600.0, 2) hours, coalesce(w.reason,'') pause_reason from work_sessions w join items i on i.id = w.item_id join projects p on p.id = i.project_id left join users u on u.id = i.installer_id order by w.start_at desc`);
    } else throw notFound();
    const csv = '﻿' + toCsv(rows);
    send(ctx.res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="mms-${what}-${todayStr()}.csv"` });
  });
}
