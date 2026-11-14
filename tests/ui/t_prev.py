import asyncio
from h2 import *
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); p = await new_page(b)
        await p.set_viewport_size({'width':1300,'height':850})
        await p.goto(BASE + '/'); await p.wait_for_timeout(1200)
        await p.get_by_placeholder('10-digit mobile').fill('9000000001'); await p.get_by_role('button', name='Send OTP on WhatsApp').click(); await p.wait_for_timeout(500)
        c = re.search(r'(\d{4})', await p.locator('.banner.warn').inner_text()).group(1)
        await p.locator('input[maxlength="8"]').fill(c); await p.get_by_role('button', name='Log in').click(); await p.wait_for_timeout(1500)
        await p.goto(BASE + '/#customer'); await p.wait_for_timeout(900)
        await p.locator('.mcard').first.click(); await p.wait_for_timeout(900)
        await p.get_by_role('button', name='See web portal view').click(); await p.wait_for_timeout(700)
        print('web preview nav:', await p.locator('.cw-nav button').count(), [e for e in p.errs if '401' not in e and 'ERR_FAILED' not in e and 'key" prop' not in e])
        await p.screenshot(path='/tmp/cw_preview.png')
        await b.close()
asyncio.run(main())
