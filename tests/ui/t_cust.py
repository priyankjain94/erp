import asyncio
from h2 import *
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); p = await new_page(b)
        await p.set_viewport_size({'width':1400,'height':900})
        await p.goto(BASE + '/c'); await p.wait_for_timeout(1500)
        await p.get_by_placeholder('10-digit mobile').fill('9827890116'); await p.get_by_role('button', name='Send OTP on WhatsApp').click(); await p.wait_for_timeout(600)
        c = re.search(r'(\d{4})', await p.locator('.banner.warn').inner_text()).group(1)
        await p.locator('input[maxlength="8"]').fill(c); await p.get_by_role('button', name='Log in').click(); await p.wait_for_timeout(2000)
        await p.screenshot(path='/tmp/cw_home.png')
        for v in ['Approvals','Your furniture','Payments','Complaints and service']:
            await p.locator('.cw-nav button', has_text=v).click(); await p.wait_for_timeout(600)
            await p.screenshot(path='/tmp/cw_'+v.split()[0].lower()+'.png')
        await p.get_by_role('button', name='Raise a complaint').first.click(); await p.wait_for_timeout(400)
        await p.screenshot(path='/tmp/cw_sheet.png')
        await p.get_by_placeholder(re.compile("Tell us what's wrong")).fill('Loft shutter not closing')
        await p.get_by_role('button', name='Send').click(); await p.wait_for_timeout(1200)
        print('raised:', await p.get_by_text(re.compile('Complaint SR-')).count(), [e for e in p.errs if '401' not in e and 'ERR_FAILED' not in e and 'key" prop' not in e])
        await p.set_viewport_size({'width':390,'height':844}); await p.wait_for_timeout(600)
        await p.screenshot(path='/tmp/cw_mobile.png')
        await b.close()
asyncio.run(main())
