import asyncio
from h2 import *
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); errs=[]
        ctx = await b.new_context(viewport={'width':1280,'height':900})
        m = await ctx.new_page(); m.on('pageerror', lambda e: errs.append('PAGEERR '+str(e))); await m.route('**/*', route)
        await m.goto(BASE + '/'); await m.wait_for_timeout(1200)
        await m.get_by_placeholder('10-digit mobile').fill('7583837704'); await m.get_by_role('button', name='Send OTP on WhatsApp').click(); await m.wait_for_timeout(600)
        c = re.search(r'(\d{4})', await m.locator('.banner.warn').inner_text()).group(1)
        await m.locator('input[maxlength="8"]').fill(c); await m.get_by_role('button', name='Log in').click(); await m.wait_for_timeout(1800)
        await m.goto(BASE + '/#automations'); await m.wait_for_timeout(1500)
        print('add lead on automations:', await m.get_by_role('button', name='Add lead').count(), 'import:', await m.get_by_role('button', name='Import').count())
        print('warn:', (await m.locator('.warnbox').all_inner_texts())[:1])
        print('pills:', await m.locator('.auto .pill').all_inner_texts())
        await m.screenshot(path='/tmp/autos.png', full_page=True)
        await m.goto(BASE + '/#pipeline'); await m.wait_for_timeout(800)
        print('add lead on pipeline:', await m.get_by_role('button', name='Add lead').count())
        print('errors:', errs)
        await b.close()
asyncio.run(main())
