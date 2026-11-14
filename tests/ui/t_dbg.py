import asyncio
from h import *
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); p = await new_page(b)
        await go(p, 'pipeline'); await p.get_by_role('button', name='List', exact=True).click()
        await p.locator('select[aria-label="Stage for Kunal Bhatia"]').select_option('won'); await p.wait_for_timeout(300)
        print(await p.locator('tr', has_text='Kunal Bhatia').count())
        await p.locator('tr', has_text='Kunal Bhatia').first.click(); await p.wait_for_timeout(300)
        await p.screenshot(path='/tmp/dbg.png'); print(p.errs[-3:])
        await b.close()
asyncio.run(main())
