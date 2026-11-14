import asyncio
from h2 import *
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); p = await new_page(b)
        await p.goto(BASE + '/'); await p.wait_for_timeout(2500)
        print(p.errs[:5]); print((await p.content())[-600:])
        await b.close()
asyncio.run(main())
