import asyncio, sys, time, re
sys.path.insert(0, '/home/claude/harness')
import h2
h2.BASE = 'http://localhost:8091'
from h2 import *
BASE = h2.BASE; S = '/home/claude/audit/shots/'
async def main():
    W, H = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (1366, 800)
    tag = 'm' if W < 600 else 'd'
    async with async_playwright() as pw:
        b = await launch(pw)
        ctx = await b.new_context(viewport={'width':W,'height':H}, service_workers='block', is_mobile=W<600, has_touch=W<600, storage_state='/home/claude/audit/state.json')
        p = await ctx.new_page(); errs=[]
        p.on('pageerror', lambda e: errs.append('PAGEERR '+str(e))); p.on('console', lambda x: errs.append(x.text) if x.type=='error' and 'key' not in x.text else None)
        await p.route('**/*', h2.route)
        await p.goto(BASE + '/'); await p.wait_for_selector('.view', timeout=20000); await p.screenshot(path=S+tag+'09-home.png')
        await p.wait_for_timeout(500)
        # ---- ADD LEAD
        btn = p.get_by_role('button', name=re.compile('Add lead', re.I)).first
        await btn.click(); await p.wait_for_timeout(400); await p.screenshot(path=S+tag+'10-addlead-empty.png')
        await p.get_by_role('button', name='Add lead', exact=True).last.click(); await p.wait_for_timeout(300)
        await p.screenshot(path=S+tag+'11-addlead-errors.png')
        await p.locator('#f-name').fill('Meena Joshi'); await p.locator('#f-phone').fill('98271 55888')
        await p.locator('.src-opt', has_text='Architect').click(); await p.wait_for_timeout(200)
        await p.screenshot(path=S+tag+'12-addlead-architect.png')
        opts = await p.locator('#f-ref option').all_inner_texts(); print('architect options', opts)
        await p.locator('#f-ref').select_option(index=1)
        await p.locator('#f-interest').fill('Modular kitchen + 2 wardrobes'); await p.locator('#f-value').fill('450000'); await p.locator('#f-area').fill('Avanti Vihar')
        await p.screenshot(path=S+tag+'13-addlead-filled.png', full_page=True)
        t=time.time(); bt = p.get_by_role('button', name='Add lead', exact=True).last
        await bt.click(); await p.wait_for_timeout(400)
        if await bt.count(): await bt.click()  # impatient second tap
        await p.locator('.toast', has_text='added to New').first.wait_for(timeout=20000); print(f'save lead -> toast: {time.time()-t:.2f}s')
        await p.wait_for_timeout(2500); await p.screenshot(path=S+tag+'14-after-add.png')
        print('toasts:', await p.locator('.toast').all_inner_texts())
        print('Rohit cards:', await p.locator('.card', has_text='Meena Joshi').count())
        await p.locator('.card', has_text='Meena Joshi').first.click(); await p.wait_for_timeout(800)
        await p.screenshot(path=S+tag+'15-lead-drawer.png')
        print('drawer text:', (await p.locator('body').inner_text())[:0])
        # drawer opens?
        print('drawer open?', await p.locator('.drawer, aside[role=dialog], [aria-label*="Lead"]').count())
        print('errors:', [e[:200] for e in errs])
        await b.close()
asyncio.run(main())
