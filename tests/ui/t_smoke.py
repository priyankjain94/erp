import asyncio
from h import *
VIEWS = ['dashboard','pipeline','inbox','partners','automations','ops','projects','tasks','survey','install','team','installers','users']
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); p = await new_page(b)
        for v in VIEWS:
            await go(p, v)
            txt = await p.inner_text('h1')
            print(v.ljust(12), '|', txt.replace('\n',' / ')[:60], '| errors:', [e for e in p.errs if 'favicon' not in e][:2]); p.errs.clear()
        await p.screenshot(path='/tmp/s_users.png')
        await b.close()
asyncio.run(main())
