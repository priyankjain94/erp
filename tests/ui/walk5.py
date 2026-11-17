import asyncio, sys, time, re, json, urllib.request
sys.path.insert(0, '/home/claude/harness')
import h2
h2.BASE = 'http://localhost:8091'
from h2 import *
BASE = h2.BASE; S = '/home/claude/audit/shots/'
exec(open('/home/claude/audit/q.py').read().split("t=login")[0].replace("B='http://localhost:%s' % (sys.argv[1] if len(sys.argv)>1 else '8091')","B='http://localhost:8091'"))
async def main():
    async with async_playwright() as pw:
        b = await launch(pw)
        ctx = await b.new_context(viewport={'width':1366,'height':800}, service_workers='block', storage_state='/home/claude/audit/state.json')
        p = await ctx.new_page(); errs=[]
        p.on('pageerror', lambda e: errs.append('PAGEERR '+str(e)))
        await p.route('**/*', h2.route)
        await p.goto(BASE + '/#partners'); await p.wait_for_selector('.view', timeout=20000); await p.wait_for_timeout(600)
        await p.get_by_role('button', name='Send monthly update').click(); await p.wait_for_timeout(1500)
        await p.screenshot(path=S+'d30-partner-update.png')
        await p.get_by_role('button', name='Cancel').click()
        await p.goto(BASE + '/#pipeline'); await p.wait_for_timeout(800)
        # someone else adds a lead; the open screen should show it within a minute, no reload
        t = login('9000000002')
        api('POST','/api/v1/leads',{'name':'Arrives By Itself','phone':'9811199901','source':'online','sub':'Website'},t)
        t0=time.time()
        await p.locator('.card', has_text='Arrives By Itself').first.wait_for(timeout=80000)
        print(f'new lead from another user appeared after {time.time()-t0:.0f}s without reload')
        print('errors', errs)
        await b.close()
asyncio.run(main())
