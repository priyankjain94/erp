import asyncio
from h2 import *
async def login(p, phone):
    await p.goto(BASE + '/'); await p.wait_for_timeout(1200)
    await p.get_by_placeholder('10-digit mobile').fill(phone); await p.get_by_role('button', name='Send OTP on WhatsApp').click(); await p.wait_for_timeout(600)
    c = re.search(r'(\d{4})', await p.locator('.banner.warn').inner_text()).group(1)
    await p.locator('input[maxlength="8"]').fill(c); await p.get_by_role('button', name='Log in').click(); await p.wait_for_timeout(1800)
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); errs=[]
        ctx = await b.new_context(viewport={'width':1440,'height':950}, service_workers='block')
        p = await ctx.new_page(); p.on('console', lambda m: m.type=='error' and errs.append(m.text)); p.on('pageerror', lambda e: errs.append('PAGEERR '+str(e))); await p.route('**/*', route)
        await login(p, '9000000003')
        await p.goto(BASE + '/#projects'); await p.wait_for_timeout(1500)
        await p.screenshot(path='/tmp/y1_board.png')
        print('cols:', (await p.locator('.pboard').inner_text())[:600].replace('\n',' | '))
        await p.locator('.pcard2').nth(2).click(); await p.wait_for_timeout(900)
        await p.locator('.drawer').screenshot(path='/tmp/y2_progress.png')
        print('progress:', (await p.locator('.drawer .d-body').inner_text())[:500].replace('\n',' | '))
        cbs = p.locator('.pg-table input[type=checkbox]')
        if await cbs.count() > 1:
            await cbs.nth(0).check(); await cbs.nth(1).check(); await p.wait_for_timeout(300)
            print('bar:', await p.locator('.pg-bar').inner_text())
        # factory user default view
        ctx2 = await b.new_context(viewport={'width':1440,'height':950}, service_workers='block'); q = await ctx2.new_page(); q.on('pageerror', lambda e: errs.append('PAGEERR '+str(e))); await q.route('**/*', route)
        await login(q, '9000000010'); await q.goto(BASE + '/#projects'); await q.wait_for_timeout(1200)
        print('purchase view:', await q.locator('.seg button[aria-pressed=true]').first.inner_text())
        print('errors:', [e[:200] for e in errs if '401' not in e and 'ERR_FAILED' not in e and 'key" prop' not in e])
        await b.close()
asyncio.run(main())
