import asyncio
from h2 import *
async def login(p, phone):
    await p.goto(BASE + '/'); await p.wait_for_timeout(1200)
    await p.get_by_placeholder('10-digit mobile').fill(phone); await p.get_by_role('button', name='Send OTP on WhatsApp').click(); await p.wait_for_timeout(600)
    c = re.search(r'(\d{4})', await p.locator('.banner.warn').inner_text()).group(1)
    await p.locator('input[maxlength="8"]').fill(c); await p.get_by_role('button', name='Log in').click(); await p.wait_for_timeout(1800)
async def main():
    async with async_playwright() as pw:
        b = await launch(pw)
        errs=[]
        async def page():
            ctx = await b.new_context(viewport={'width':1400,'height':900}, service_workers='block')
            p = await ctx.new_page(); p.on('console', lambda m: m.type=='error' and errs.append(m.text)); p.on('pageerror', lambda e: errs.append('PAGEERR '+str(e))); await p.route('**/*', route); return p
        # owner: control room, scorecards, settings
        p = await page(); await login(p, '9000000001')
        await p.goto(BASE + '/#ops'); await p.wait_for_timeout(1200); await p.screenshot(path='/tmp/w1_control.png', full_page=True)
        print('control:', (await p.locator('.view').first.inner_text())[:500].replace('\n',' | '))
        await p.goto(BASE + '/#team'); await p.wait_for_timeout(1000); await p.screenshot(path='/tmp/w2_score.png', full_page=True)
        print('score head:', (await p.locator('table thead').first.inner_text()).replace('\n',' '))
        await p.goto(BASE + '/#users'); await p.wait_for_timeout(800)
        await p.get_by_role('button', name='Stages and templates').click(); await p.wait_for_timeout(500)
        await p.screenshot(path='/tmp/w3_settings.png', full_page=True)
        inp = p.locator('.box').first.locator('input').nth(1); await inp.fill('6')
        await p.get_by_role('button', name='Save stage targets').click(); await p.wait_for_timeout(800)
        print('toast:', await p.locator('.toasts').inner_text())
        await p.goto(BASE + '/#tasks'); await p.wait_for_timeout(1000)
        for n in ['Team board','Assigned by me','Reminder log']:
            await p.get_by_role('button', name=re.compile('^'+n)).click(); await p.wait_for_timeout(500)
        await p.screenshot(path='/tmp/w4_log.png')
        # vikram (PM) creates a task for manish from a template, with check
        p2 = await page(); await login(p2, '9000000003')
        await p2.goto(BASE + '/#tasks'); await p2.wait_for_timeout(1000)
        await p2.get_by_role('button', name='New task').click(); await p2.wait_for_timeout(400)
        await p2.locator('.sheet select').first.select_option(index=3)  # template: site readiness check
        await p2.locator('.sheet label', has_text='Assign to').locator('select').select_option('manish')
        await p2.screenshot(path='/tmp/w5_newtask.png')
        await p2.get_by_role('button', name='Assign and send WhatsApp').click(); await p2.wait_for_timeout(1200)
        print('toast2:', await p2.locator('.toasts').inner_text())
        # manish: asks for more time, then blocks? -> ask more time
        p3 = await page(); await login(p3, '9000000010')
        await p3.goto(BASE + '/#tasks'); await p3.wait_for_timeout(1000)
        await p3.get_by_role('button', name=re.compile('^Upcoming')).click(); await p3.wait_for_timeout(300)
        await p3.locator('.mcard', has_text='Site readiness').get_by_role('button', name='More').click(); await p3.wait_for_timeout(600)
        print('drawer btns:', await p3.locator('.drawer .row-btns').inner_text())
        await p3.get_by_role('button', name='Need more time').click(); await p3.wait_for_timeout(300)
        await p3.locator('.drawer input[placeholder^="e.g. Client"]').fill('Civil work still going on at site')
        await p3.locator('.drawer').get_by_role('button', name=re.compile('^Ask')).click(); await p3.wait_for_timeout(1200)
        print('toast3:', await p3.locator('.toasts').inner_text())
        await p3.screenshot(path='/tmp/w6_drawer.png')
        # vikram approves in control room
        await p2.goto(BASE + '/#ops'); await p2.reload(); await p2.wait_for_timeout(2500)
        await p2.screenshot(path='/tmp/w7_vk_control.png', full_page=True)
        ap = p2.get_by_role('button', name=re.compile('^Approve'))
        print('approve buttons:', await ap.count())
        if await ap.count(): await ap.first.click(); await p2.wait_for_timeout(1200); print('toast4:', await p2.locator('.toasts').inner_text())
        # item modal waiting
        await p2.goto(BASE + '/#projects'); await p2.wait_for_timeout(1000)
        await p2.get_by_role('button', name=re.compile('Item board')).click(); await p2.wait_for_timeout(600)
        await p2.screenshot(path='/tmp/w8_board.png')
        await p2.locator('.icard').first.click(); await p2.wait_for_timeout(600)
        await p2.locator('.sheet select', has=p2.locator('option', has_text='Client approval')).select_option('client_approval'); await p2.wait_for_timeout(1000)
        print('modal age:', await p2.locator('.stage-age').first.inner_text())
        await p2.screenshot(path='/tmp/w9_item.png')
        print('errors:', [e[:200] for e in errs if '401' not in e and 'ERR_FAILED' not in e and 'key" prop' not in e])
        await b.close()
asyncio.run(main())
