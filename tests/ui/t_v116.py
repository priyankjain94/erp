import asyncio
from h2 import *
async def main():
    vik = login('9000000003'); ank = login('9000000004')
    np = api('POST', '/projects', {'customer':'Nikhil Scope', 'phone':'9811100044', 'address':'Avanti Vihar, Raipur', 'value':400000, 'pm':'vikram', 'target':'2099-06-01', 'surveyDate':'2099-05-03', 'scope':[{'room':'Kitchen','type':'KT'}]}, vik)
    pid = np['id']; st = api('GET', '/state', None, ank)
    sid = [p for p in st['erp']['projects'] if p['id'] == pid][0]['scope'][0]['id']
    print('delete scope:', api('DELETE', f'/projects/{pid}/scope/{sid}', {'reason':'test'}, ank).get('ok'))
    async with async_playwright() as pw:
        b = await launch(pw); errs=[]
        ctx = await b.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True, service_workers='block', geolocation={'latitude':21.25,'longitude':81.63}, permissions=['geolocation'])
        m = await ctx.new_page(); m.on('pageerror', lambda e: errs.append('PAGEERR '+str(e))); m.on('console', lambda x: errs.append(x.text) if x.type=='error' else None); await m.route('**/*', route)
        await m.goto(BASE + '/'); await m.wait_for_timeout(1200)
        await m.get_by_placeholder('10-digit mobile').fill('9000000007'); await m.get_by_role('button', name='Send OTP on WhatsApp').click(); await m.wait_for_timeout(600)
        c = re.search(r'(\d{4})', await m.locator('.banner.warn').inner_text()).group(1)
        await m.locator('input[maxlength="8"]').fill(c); await m.get_by_role('button', name='Log in').click(); await m.wait_for_timeout(1800)
        await m.goto(BASE + '/#survey'); await m.wait_for_timeout(1200)
        card = m.locator('.ph-body > button.mcard', has_text='Nikhil Scope')
        print('1 list badge:', await card.locator('.pill', has_text='No scope').count())
        await card.click(); await m.wait_for_timeout(600)
        await m.get_by_role('button', name='Check in at site').click(); await m.wait_for_timeout(1200)
        print('2 job ask card:', (await m.locator('.mcard', has_text='No scope of work yet').inner_text()).replace('\n',' | '))
        await m.get_by_role('button', name=re.compile('^Ask .* to add it')).click(); await m.wait_for_timeout(1200)
        print('3 after ask:', (await m.locator('.mcard', has_text='No scope of work yet').inner_text()).replace('\n',' | '))
        await m.screenshot(path='/tmp/v116_job_noscope.png')
        # add an extra room so Review is enabled
        await m.locator('.ph-foot .big').first.click(); await m.wait_for_timeout(400)
        await m.locator('.sheet-m .presets button').first.click()
        await m.locator('.sheet-m').get_by_role('button', name='Add room').click(); await m.wait_for_timeout(700)
        await m.locator('.ph-head button').first.click(); await m.wait_for_timeout(400)
        await m.locator('.ph-head button').first.click(); await m.wait_for_timeout(400)
        await m.get_by_role('button', name='Review', exact=True).click(); await m.wait_for_timeout(600)
        print('4 review banner:', await m.locator('.banner.crit').first.inner_text())
        print('4 review askscope:', await m.locator('.mcard', has_text='No scope of work yet').count())
        print('4 submit disabled:', await m.locator('.ph-foot .big.go').is_disabled())
        await m.screenshot(path='/tmp/v116_review_noscope.png', full_page=True)
        # P103 Rakesh: scope rooms not set up + unplaced
        await m.goto(BASE + '/#survey'); await m.reload(); await m.wait_for_timeout(1500)
        await m.locator('.ph-body > button.mcard', has_text='Rakesh Sharma').click(); await m.wait_for_timeout(600)
        await m.get_by_role('button', name='Check in at site').click(); await m.wait_for_timeout(1200)
        await m.locator('.ph-foot .big').first.click(); await m.wait_for_timeout(400)
        await m.locator('.sheet-m').get_by_role('button', name='Add room').click(); await m.wait_for_timeout(700)
        for k in range(4):
            await m.locator('.photo-drop input[type=file]').set_input_files('/tmp/wall.jpg'); await m.wait_for_timeout(500)
        await m.locator('.ph-foot .big.pri').click(); await m.wait_for_timeout(500)
        for k in range(4):
            await m.locator('.dim').first.click(); await m.wait_for_timeout(250)
            for key in ['3','2','00']: await m.locator('.kp button', has_text=re.compile('^'+key+'$')).click()
            await m.locator('.kp-sheet .big.pri').click(); await m.wait_for_timeout(300)
            await m.locator('.ph-foot .big.pri').click(); await m.wait_for_timeout(500)
        print('5 roomdone issues:', [t.replace('\n',' ') for t in await m.locator('.mcard', has_text='Check before you leave').locator('button').all_inner_texts()])
        await m.locator('.mcard', has_text='Check before you leave').locator('button').first.click(); await m.wait_for_timeout(500)
        print('6 place sheet:', (await m.locator('.sheet-m h3').inner_text()), await m.locator('.sheet-m .mcard').count(), 'walls')
        await m.locator('.sheet-m .mcard').first.click(); await m.wait_for_timeout(500)
        print('7 after place, issues:', await m.locator('.mcard', has_text='Check before you leave').locator('button').count())
        await m.screenshot(path='/tmp/v116_roomdone.png', full_page=True)
        await m.goto(BASE + '/#survey'); await m.reload(); await m.wait_for_timeout(1500)
        await m.locator('.ph-body > button.mcard', has_text='Rakesh Sharma').click(); await m.wait_for_timeout(600)
        await m.get_by_role('button', name='Review', exact=True).click(); await m.wait_for_timeout(600)
        errs_txt = await m.locator('.ph-body button.mcard').all_inner_texts()
        print('8 review errors:', [t[:90] for t in errs_txt])
        await m.screenshot(path='/tmp/v116_review.png', full_page=True)
        setup = m.locator('.ph-body button.mcard', has_text='Tap to set it up').first
        if await setup.count():
            await setup.click(); await m.wait_for_timeout(500)
            print('9 setup sheet:', await m.locator('.sheet-m h3').inner_text())
            await m.locator('.sheet-m').get_by_role('button', name='Cancel').click(); await m.wait_for_timeout(300)
        pl = m.locator('.ph-body button.mcard', has_text='Tap to choose the wall').first
        if await pl.count():
            await pl.click(); await m.wait_for_timeout(500); print('10 place from review:', await m.locator('.sheet-m h3').inner_text())
        print('errors:', [e[:200] for e in errs])
        await b.close()
asyncio.run(main())
