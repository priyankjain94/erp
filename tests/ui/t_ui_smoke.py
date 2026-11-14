import asyncio
from h2 import *
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); p = await new_page(b)
        await p.goto(BASE + '/'); await p.wait_for_timeout(1500)
        print('title:', await p.title()); print('login visible:', await p.get_by_text('Team login').count())
        await p.get_by_placeholder('10-digit mobile').fill('9000000001'); await p.get_by_role('button', name='Send OTP on WhatsApp').click(); await p.wait_for_timeout(500)
        t = await p.locator('.banner.warn').inner_text(); code = re.search(r'(\d{4})', t).group(1)
        await p.locator('input[maxlength="8"]').fill(code); await p.get_by_role('button', name='Log in').click(); await p.wait_for_timeout(1500)
        print('nav:', [x.strip() for x in await p.locator('.rail .nav button').all_inner_texts()])
        for v in ['dashboard','pipeline','inbox','partners','automations','ops','projects','tasks','survey','install','team','installers','users','customer']:
            await p.goto(BASE + '/#' + v); await p.wait_for_timeout(700)
            h1 = (await p.locator('h1').inner_text()).replace('\n',' / ') if await p.locator('h1').count() else '(no h1)'
            errs = [e for e in p.errs if 'key" prop' not in e and 'ERR_FAILED' not in e and 'favicon' not in e]
            print(v.ljust(12), h1[:55], errs[:2]); p.errs.clear()
        await p.screenshot(path='/tmp/ui_users.png')
        await b.close()
asyncio.run(main())
