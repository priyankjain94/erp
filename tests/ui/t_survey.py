import asyncio
from h2 import *
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); ctx = await b.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True, service_workers='block', geolocation={'latitude':21.25,'longitude':81.63}, permissions=['geolocation'])
        p = await ctx.new_page(); errs=[]; p.on('console', lambda m: m.type=='error' and errs.append(m.text)); p.on('pageerror', lambda e: errs.append('PAGEERR '+str(e))); await p.route('**/*', route)
        await p.goto(BASE + '/'); await p.wait_for_timeout(1500)
        await p.get_by_placeholder('10-digit mobile').fill('9000000001'); await p.get_by_role('button', name='Send OTP on WhatsApp').click(); await p.wait_for_timeout(600)
        c = re.search(r'(\d{4})', await p.locator('.banner.warn').inner_text()).group(1)
        await p.locator('input[maxlength="8"]').fill(c); await p.get_by_role('button', name='Log in').click(); await p.wait_for_timeout(1500)
        await p.screenshot(path='/tmp/s0_home.png')
        # how does a phone user reach the survey?
        print('bottom nav:', await p.locator('nav.bottomnav button').all_inner_texts())
        await p.goto(BASE + '/#survey'); await p.wait_for_timeout(1200)
        await p.screenshot(path='/tmp/s1_list.png')
        print('list header:', (await p.locator('.ph-head').first.inner_text()).replace('\n',' | '))
        cards = p.locator('.ph-body > button.mcard'); print('jobs:', await cards.count())
        # open first not-submitted
        for i in range(await cards.count()):
            t = await cards.nth(i).inner_text()
            if 'Submitted' not in t: await cards.nth(i).click(); break
        await p.wait_for_timeout(700); await p.screenshot(path='/tmp/s2_job.png')
        await p.get_by_role('button', name='Check in at site').click(); await p.wait_for_timeout(1200)
        await p.screenshot(path='/tmp/s3_checked.png')
        await p.get_by_role('button', name='Add room').click(); await p.wait_for_timeout(400)
        await p.locator('.presets button').first.click()
        await p.locator('.sheet-m').get_by_role('button', name='Add room').click(); await p.wait_for_timeout(700)
        await p.screenshot(path='/tmp/s4_room.png')
        await p.locator('button.mcard', has_text='Wall A').click(); await p.wait_for_timeout(500)
        for k in range(4):
            fi = p.locator('input[type=file]').first
            await fi.set_input_files('/tmp/wall.jpg'); await p.wait_for_timeout(800)
            await p.get_by_placeholder('e.g. 3600').fill(str(3000 + (k%2)*600))
            if k == 0: await p.screenshot(path='/tmp/s5_wall.png')
            await p.locator('.ph-foot .big.pri').click(); await p.wait_for_timeout(500)
        await p.get_by_role('button', name='Tag furniture').click(); await p.wait_for_timeout(400)
        await p.screenshot(path='/tmp/s6_tag.png')
        sheet = p.locator('.sheet-m')
        btns = await sheet.get_by_role('button').all_inner_texts(); print('tag sheet buttons:', btns[:12])
        await sheet.get_by_role('button', name=re.compile('^(Tag|Add|Save)')).last.click(); await p.wait_for_timeout(600)
        await p.locator('.ph-head .back').click(); await p.wait_for_timeout(500)
        await p.screenshot(path='/tmp/s7_job2.png')
        foot = await p.locator('.ph-foot').inner_text(); print('job footer:', foot.replace('\n',' | '))
        await p.get_by_role('button', name=re.compile('Review')).click(); await p.wait_for_timeout(600)
        await p.screenshot(path='/tmp/s8_review.png')
        print('review banner:', await p.locator('.banner').first.inner_text())
        await p.get_by_role('button', name='Submit survey').click(); await p.wait_for_timeout(2000)
        await p.screenshot(path='/tmp/s9_done.png')
        print('after submit:', (await p.locator('.ph-body').first.inner_text())[:200].replace('\n',' | '))
        print('errors:', [e[:140] for e in errs if '401' not in e and 'ERR_FAILED' not in e and 'key" prop' not in e])
        await b.close()
asyncio.run(main())
