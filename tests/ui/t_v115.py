import asyncio
from h2 import *
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); errs=[]
        ctx = await b.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True, service_workers='block', geolocation={'latitude':21.25,'longitude':81.63}, permissions=['geolocation'])
        m = await ctx.new_page(); m.on('pageerror', lambda e: errs.append('PAGEERR '+str(e))); await m.route('**/*', route)
        await m.goto(BASE + '/'); await m.wait_for_timeout(1200)
        await m.get_by_placeholder('10-digit mobile').fill('9000000007'); await m.get_by_role('button', name='Send OTP on WhatsApp').click(); await m.wait_for_timeout(600)
        c = re.search(r'(\d{4})', await m.locator('.banner.warn').inner_text()).group(1)
        await m.locator('input[maxlength="8"]').fill(c); await m.get_by_role('button', name='Log in').click(); await m.wait_for_timeout(1800)
        await m.goto(BASE + '/#survey'); await m.wait_for_timeout(1200)
        await m.locator('.ph-body > button.mcard', has_text='Rakesh Sharma').click(); await m.wait_for_timeout(600)
        await m.get_by_role('button', name='Check in at site').click(); await m.wait_for_timeout(1200)
        await m.locator('.ph-foot .big').first.click(); await m.wait_for_timeout(400)
        await m.locator('.sheet-m').get_by_role('button', name='Add room').click(); await m.wait_for_timeout(700)
        for k in range(4):
            await m.locator('.photo-drop input[type=file]').set_input_files('/tmp/wall.jpg'); await m.wait_for_timeout(600)
        await m.locator('.ph-foot .big.pri').click(); await m.wait_for_timeout(500)
        for k in range(4):
            await m.locator('.dim').first.click(); await m.wait_for_timeout(250)
            for key in ['3','2','00']: await m.locator('.kp button', has_text=re.compile('^'+key+'$')).click()
            await m.locator('.kp-sheet .big.pri').click(); await m.wait_for_timeout(300)
            if k == 0: await m.locator('.mcard', has_text='Scope items on this wall').locator('.chips button').first.click(); await m.wait_for_timeout(300)
            await m.locator('.ph-foot .big.pri').click(); await m.wait_for_timeout(500)
        await m.screenshot(path='/tmp/u1_roomdone.png', full_page=True)
        print('roomdone:', (await m.locator('.ph-body').inner_text())[:400].replace('\n',' | '))
        print('foot:', (await m.locator('.ph-foot').inner_text()).replace('\n',' | '))
        print('errors:', [e[:200] for e in errs])
        await b.close()
asyncio.run(main())
