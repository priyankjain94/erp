import asyncio, sys, re
sys.path.insert(0, '/home/claude/harness')
import h2
h2.BASE = 'http://localhost:8091'
from h2 import *
async def main():
    async with async_playwright() as pw:
        b = await launch(pw); ctx = await b.new_context(service_workers='block'); p = await ctx.new_page(); await p.route('**/*', h2.route)
        await p.goto(h2.BASE + '/'); await p.get_by_placeholder('10-digit mobile').fill(sys.argv[1] if len(sys.argv) > 1 else '7583837704'); await p.get_by_role('button', name=re.compile('Send OTP')).click()
        await p.locator('.banner.warn').wait_for(); c = re.search(r'(\d{4,6})', await p.locator('.banner.warn').inner_text()).group(1)
        await p.locator('input[maxlength="8"]').fill(c); await p.get_by_role('button', name='Log in').click(); await p.wait_for_selector('.view', timeout=20000)
        await ctx.storage_state(path='/home/claude/audit/state.json'); print('saved'); await b.close()
asyncio.run(main())
