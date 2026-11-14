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
        async def page(mobile=False):
            ctx = await b.new_context(viewport={'width':390,'height':844} if mobile else {'width':1400,'height':900}, is_mobile=mobile, has_touch=mobile, service_workers='block', geolocation={'latitude':21.25,'longitude':81.63}, permissions=['geolocation'])
            p = await ctx.new_page(); p.on('console', lambda m: m.type=='error' and errs.append(m.text)); p.on('pageerror', lambda e: errs.append('PAGEERR '+str(e))); await p.route('**/*', route); return p
        # sales converts L17 with a scope
        p = await page(); await login(p, '9000000004')
        await p.goto(BASE + '/#pipeline'); await p.wait_for_timeout(1200)
        await p.get_by_text('Kunal Bhatia').first.click(); await p.wait_for_timeout(800)
        await p.get_by_role('tab', name='Details').click(); await p.wait_for_timeout(500)
        box = p.locator('.box', has_text='Convert to project')
        await box.scroll_into_view_if_needed()
        await box.locator('.chips button', has_text='Kitchen').first.click()
        await box.locator('.chips button', has_text='+ Kitchen').click()
        await box.locator('.chips button', has_text='+ Crockery unit').click()
        await box.locator('.chips button', has_text='Master Bedroom').first.click()
        await box.locator('.chips button', has_text='+ Wardrobe').click()
        await box.locator('.scope-line input[placeholder^="Details"]').last.fill('Sliding, 3 doors, loft')
        await box.locator('.scope-line input[placeholder="₹ value"]').last.fill('135000')
        await box.screenshot(path='/tmp/x1_convert.png')
        await box.get_by_role('button', name='Convert to project').click(); await p.wait_for_timeout(1800)
        print('toast:', await p.locator('.toasts').inner_text())
        await p.get_by_role('tab', name=re.compile('^Scope')).click(); await p.wait_for_timeout(500)
        await p.locator('.drawer').screenshot(path='/tmp/x2_scopetab.png')
        print('scope tab:', (await p.locator('.drawer .d-body').inner_text())[:300].replace('\n',' | '))
        # surveyor on P103
        m = await page(True); await login(m, '9000000007')
        await m.goto(BASE + '/#survey'); await m.wait_for_timeout(1200)
        await m.locator('.ph-body > button.mcard', has_text='Rakesh Sharma').click(); await m.wait_for_timeout(600)
        await m.get_by_role('button', name='Check in at site').click(); await m.wait_for_timeout(1200)
        await m.screenshot(path='/tmp/x3_job.png', full_page=True)
        print('job foot:', await m.locator('.ph-foot').inner_text())
        await m.locator('.ph-foot .big').first.click(); await m.wait_for_timeout(400)   # Set up Kitchen
        print('sheet title:', await m.locator('.sheet-m h3').inner_text())
        await m.locator('.sheet-m').get_by_role('button', name='Add room').click(); await m.wait_for_timeout(700)
        for k in range(4):
            await m.locator('.photo-drop input[type=file]').set_input_files('/tmp/wall.jpg'); await m.wait_for_timeout(700)
        await m.locator('.ph-foot .big.pri').click(); await m.wait_for_timeout(500)   # Measure A
        await m.screenshot(path='/tmp/x4_wall.png', full_page=True)
        chips = await m.locator('.mcard', has_text='Scope items on this wall').locator('.chips button').all_inner_texts()
        print('wall chips:', chips)
        await m.locator('.mcard', has_text='Scope items on this wall').locator('.chips button').first.click(); await m.wait_for_timeout(300)
        await m.locator('.ph-head .back').click(); await m.wait_for_timeout(300); await m.locator('.ph-head .back').click(); await m.wait_for_timeout(800)
        await m.get_by_role('button', name='Review').click(); await m.wait_for_timeout(800)
        print('review:', (await m.locator('.ph-body').inner_text())[:500].replace('\n',' | '))
        print('errors:', [e[:200] for e in errs if '401' not in e and 'ERR_FAILED' not in e and 'key" prop' not in e])
        await b.close()
asyncio.run(main())
