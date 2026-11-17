import asyncio, sys, time, re
sys.path.insert(0, '/home/claude/harness')
import h2
h2.BASE = 'http://localhost:8091'
from h2 import *
BASE = h2.BASE
S = '/home/claude/audit/shots/'
async def tm(label, coro):
    t = time.time(); r = await coro; print(f'{label}: {time.time()-t:.2f}s'); return r
async def main():
    W, H = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (1366, 800)
    tag = 'm' if W < 600 else 'd'
    async with async_playwright() as pw:
        b = await launch(pw)
        ctx = await b.new_context(viewport={'width':W,'height':H}, service_workers='block', is_mobile=W<600, has_touch=W<600)
        p = await ctx.new_page(); errs=[]
        p.on('pageerror', lambda e: errs.append('PAGEERR '+str(e))); p.on('console', lambda x: errs.append(x.text) if x.type=='error' else None)
        await p.route('**/*', h2.route)
        t=time.time(); await p.goto(BASE + '/'); await p.get_by_placeholder('10-digit mobile').wait_for(); print(f'login screen: {time.time()-t:.2f}s')
        await p.screenshot(path=S+tag+'01-login.png')
        await p.get_by_placeholder('10-digit mobile').fill('7583837704'); await p.get_by_role('button', name=re.compile('Send OTP')).click()
        await p.locator('.banner.warn').wait_for(); c = re.search(r'(\d{4,6})', await p.locator('.banner.warn').inner_text()).group(1)
        await p.screenshot(path=S+tag+'02-otp.png')
        await p.locator('input[maxlength="8"]').fill(c)
        t=time.time(); await p.get_by_role('button', name='Log in').click(); await p.wait_for_selector('.view', timeout=20000); print(f'login -> app: {time.time()-t:.2f}s')
        await p.wait_for_timeout(800); await p.screenshot(path=S+tag+'03-landing.png', full_page=False)
        print('landing hash', await p.evaluate('location.hash'))
        for v in ['dashboard','pipeline','inbox','partners','automations','ops','projects','tasks']:
            t=time.time(); await p.goto(BASE+'/#'+v); await p.wait_for_timeout(700)
            await p.screenshot(path=S+f'{tag}04-{v}.png')
        print('errors:', [e[:200] for e in errs])
        await b.close()
asyncio.run(main())
