import asyncio
from h import *
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); p = await new_page(b, 390, 844)
        for v in ['survey','install','customer','tasks','installers']:
            await go(p, v); await p.screenshot(path=f'/tmp/m_{v}.png')
        await p.locator('.mcard').first.click() if False else None
        await go(p, 'install'); await p.locator('.mcard').first.click(); await p.wait_for_timeout(200); await p.screenshot(path='/tmp/m_job.png')
        print([e for e in p.errs if 'key" prop' not in e and 'ERR_FAILED' not in e])
        await b.close()
asyncio.run(main())
