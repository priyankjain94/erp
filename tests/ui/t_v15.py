import asyncio
from h2 import *
async def ui_login(p, phone='9000000001'):
    await p.goto(BASE + '/'); await p.wait_for_timeout(1200)
    await p.get_by_placeholder('10-digit mobile').fill(phone); await p.get_by_role('button', name='Send OTP on WhatsApp').click(); await p.wait_for_timeout(500)
    t = await p.locator('.banner.warn').inner_text(); code = re.search(r'(\d{4})', t).group(1)
    await p.locator('input[maxlength="8"]').fill(code); await p.get_by_role('button', name='Log in').click(); await p.wait_for_timeout(1500)
def errs(p):
    e = [x for x in p.errs if 'key" prop' not in x and 'ERR_FAILED' not in x and 'favicon' not in x and '401' not in x]; p.errs.clear(); return e
import time
U = str(int(time.time()))[-5:]
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); p = await new_page(b)
        await ui_login(p)
        # Partners: add
        await p.goto(BASE + '/#partners'); await p.wait_for_timeout(800)
        print('kpis:', (await p.locator('.kpis').inner_text()).replace('\n',' | ')[:200])
        await p.get_by_role('button', name='Add partner').click(); await p.wait_for_timeout(300)
        dlg = p.locator('[aria-label="Add partner"]')
        await dlg.get_by_placeholder('e.g. Ar. Neha Sharma').fill('Ar. UI Partner ' + U); await dlg.get_by_placeholder('Studio / company name').fill('UI Studio')
        await dlg.get_by_placeholder('10-digit mobile').fill('98333' + U)
        await dlg.get_by_role('button', name='Add partner').click(); await p.wait_for_timeout(900)
        print('partner row:', await p.get_by_text('Ar. UI Partner ' + U).count(), errs(p))
        await p.screenshot(path='/tmp/v15_partners.png')
        # Add lead with new partner inline
        await p.goto(BASE + '/#pipeline'); await p.wait_for_timeout(700)
        await p.get_by_role('button', name='Add lead').first.click(); await p.wait_for_timeout(300)
        await p.locator('#f-name').fill('Lead Via UI Partner ' + U); await p.locator('#f-phone').fill('98334' + U)
        await p.get_by_role('button', name='Real estate agent').click(); await p.wait_for_timeout(200)
        await p.get_by_role('button', name=re.compile('Add a new')).click(); await p.wait_for_timeout(300)
        d2 = p.locator('[aria-label="Add partner"]')
        await d2.get_by_placeholder('e.g. Ar. Neha Sharma').fill('Agent Inline ' + U); await d2.get_by_role('button', name='Add partner').click(); await p.wait_for_timeout(900)
        print('ref selected:', await p.locator('#f-ref option:checked').inner_text())
        await p.locator('form.sheet').get_by_role('button', name='Add lead').click(); await p.wait_for_timeout(1000)
        print('lead added:', await p.get_by_text('Lead Via UI Partner ' + U).count(), errs(p))
        # Quotation tab
        await p.get_by_text('Lead Via UI Partner ' + U).first.click(); await p.wait_for_timeout(500)
        await p.get_by_role('tab', name=re.compile('Quotation')).click(); await p.wait_for_timeout(300)
        await p.get_by_placeholder('Base units, carcass + shutters').fill('Kitchen complete')
        await p.locator('.qtable input[inputmode="numeric"]').first.fill('250000'); await p.wait_for_timeout(200)
        print('total shown:', 'yes' if await p.get_by_text('₹2,95,000').count() else 'no')
        async with p.context.expect_page() as np:
            await p.get_by_role('button', name='Save and open PDF').click()
        pp = await np.value; await pp.wait_for_timeout(800)
        print('print page:', (await pp.content()).count('2,95,000.00') > 0); await pp.close()
        await p.wait_for_timeout(500); print('revisions:', await p.locator('.box', has_text='Revisions').count(), errs(p))
        await p.keyboard.press('Escape')
        # Project money tab
        await p.goto(BASE + '/#projects'); await p.wait_for_timeout(700)
        await p.locator('.click, .pcard, button', has_text='P-101').first.click(); await p.wait_for_timeout(700)
        await p.get_by_role('tab', name='Money & site').click(); await p.wait_for_timeout(400)
        await p.get_by_placeholder('Amount ₹').fill('5000'); await p.get_by_placeholder('UTR / transaction ID').fill('UTR555')
        async with p.context.expect_page() as np:
            await p.get_by_role('button', name='Save and print receipt').click()
        pp = await np.value; await pp.wait_for_timeout(600); print('receipt print:', 'Payment receipt' in await pp.content()); await pp.close()
        await p.get_by_role('button', name='New tax invoice').click(); await p.wait_for_timeout(200)
        await p.screenshot(path='/tmp/v15_inv.png'); bb = await p.get_by_role('button', name='Raise invoice').bounding_box(); print('raise bbox', bb, await p.locator('aside.drawer').bounding_box())
        await p.get_by_placeholder('Taxable value ₹').fill('10000')
        async with p.context.expect_page() as np:
            await p.get_by_role('button', name='Raise invoice').click()
        pp = await np.value; await pp.wait_for_timeout(600); print('invoice print:', 'Tax invoice' in await pp.content()); await pp.close()
        await p.screenshot(path='/tmp/v15_money.png', full_page=False)
        await p.get_by_role('tab', name=re.compile('^Changes')).click(); await p.wait_for_timeout(300)
        await p.get_by_placeholder(re.compile('What is changing')).fill('Add loft above wardrobe'); await p.get_by_placeholder('± ₹').fill('18000')
        await p.get_by_role('button', name='Raise', exact=True).click(); await p.wait_for_timeout(700)
        print('change pending:', await p.get_by_text('Waiting for client').count())
        await p.get_by_role('tab', name=re.compile('^Service')).click(); await p.wait_for_timeout(300)
        print('service tab warranty box:', await p.locator('.box', has_text='Warranty').count(), errs(p))
        await p.screenshot(path='/tmp/v15_service.png')
        # Admin
        await p.keyboard.press('Escape'); await p.wait_for_timeout(300)
        await p.goto(BASE + '/#users'); await p.wait_for_timeout(700)
        for tab in ['Company profile', 'Exports', 'WhatsApp and Meta']:
            await p.locator('.seg button', has_text=tab).click(); await p.wait_for_timeout(600)
            print('admin', tab, errs(p))
        print('templates rows:', await p.locator('.table-wrap tbody tr').count())
        await p.screenshot(path='/tmp/v15_wa.png', full_page=True)
        # Customer app: change approval
        await p.goto(BASE + '/#customer'); await p.wait_for_timeout(700)
        await p.locator('.mcard', has_text='P-101').click(); await p.wait_for_timeout(900)
        print('customer action card:', await p.get_by_text(re.compile('waiting for your OK')).count())
        await p.get_by_text(re.compile('waiting for your OK')).click(); await p.wait_for_timeout(400)
        await p.get_by_role('button', name='Approve').first.click(); await p.wait_for_timeout(900)
        print('approved:', await p.locator('.pill.good', has_text='approved').count(), errs(p))
        await p.screenshot(path='/tmp/v15_customer.png')
        await b.close()
asyncio.run(main())
