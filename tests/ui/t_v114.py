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
        await login(p, '9000000003')   # Vikram PM
        await p.goto(BASE + '/#projects/P101/progress'); await p.wait_for_timeout(1800)
        print('hash:', await p.evaluate('location.hash'), '| ws:', await p.locator('.ws').count())
        print('next step:', await p.locator('.next-step').inner_text())
        await p.screenshot(path='/tmp/z1_ws.png')
        # click Drawing step
        await p.locator('.ws-steps .pg-step', has_text='Drawing').click(); await p.wait_for_timeout(700)
        print('hash2:', await p.evaluate('location.hash'))
        await p.locator('.ws .d-body').screenshot(path='/tmp/z2_drawing.png')
        print('drawing panel:', (await p.locator('.ws .d-body').inner_text())[:400].replace('\n',' | '))
        # move to Factory PI stage
        await p.locator('.ws-steps .pg-step', has_text='Factory PI').click(); await p.wait_for_timeout(600)
        pi = p.locator('.ws .d-body')
        await pi.get_by_placeholder('FPI-5123').fill('FPI-8800'); await p.wait_for_timeout(1500)
        print('draft:', await pi.locator('.draft-note').first.inner_text())
        await p.reload(); await p.wait_for_timeout(2000)
        print('after reload hash:', await p.evaluate('location.hash'), '| PI field:', await p.locator('.ws .d-body').get_by_placeholder('FPI-5123').input_value())
        await p.locator('.ws .d-body').get_by_role('button', name=re.compile('^Save PI for')).click(); await p.wait_for_timeout(1500)
        print('toast:', await p.locator('.toasts').inner_text())
        await p.locator('.ws .d-body').screenshot(path='/tmp/z3_pi.png')
        # open an item inside the workspace
        await p.locator('.ws-steps .pg-step', has_text='Dispatch').click(); await p.wait_for_timeout(600)
        lk = p.locator('.ws .d-body table .linkbtn').first
        if await lk.count():
            await lk.click(); await p.wait_for_timeout(700)
            print('item inside ws:', await p.locator('.ws .ws-item').count(), '| modal:', await p.locator('.modal').count())
            await p.locator('.ws').screenshot(path='/tmp/z4_item.png')
            await p.get_by_role('tab', name='‹ Back to project').click(); await p.wait_for_timeout(400)
        # designer home: my next steps
        ctx2 = await b.new_context(viewport={'width':1440,'height':950}, service_workers='block'); q = await ctx2.new_page(); q.on('pageerror', lambda e: errs.append('PAGEERR '+str(e))); await q.route('**/*', route)
        await login(q, '9000000008'); await q.goto(BASE + '/#tasks'); await q.wait_for_timeout(1500)
        print('designer home:', (await q.locator('.view').first.inner_text())[:300].replace('\n',' | '))
        await q.screenshot(path='/tmp/z5_home.png')
        print('errors:', [e[:200] for e in errs if '401' not in e and 'ERR_FAILED' not in e and 'key" prop' not in e])
        await b.close()
asyncio.run(main())
