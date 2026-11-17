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
        t=time.time(); await p.goto(BASE + '/'); await p.wait_for_selector('.view', timeout=20000); print(f'reopen app (logged in) -> usable: {time.time()-t:.2f}s')
        await p.goto(BASE + '/#projects'); await p.wait_for_timeout(800)
        await p.get_by_role('button', name=re.compile('New project', re.I)).first.click(); await p.wait_for_timeout(500)
        await p.screenshot(path=S+tag+'20-newproject.png')
        opts = await p.locator('.sheet select').first.locator('option').all_inner_texts(); print('lead options', opts)
        await p.locator('.sheet select').first.select_option(index=0); await p.wait_for_timeout(300)
        await p.screenshot(path=S+tag+'21-newproject-direct.png', full_page=True)
        print('create disabled?', await p.get_by_role('button', name='Create project').is_disabled())
        labels = await p.locator('.sheet label').all_inner_texts(); print('labels', [l.split('\n')[0] for l in labels])
        ins = p.locator('.sheet .form > label input')
        n = await ins.count(); print('inputs', n)
        await p.locator('.sheet label', has_text='Customer name').locator('input').fill('Kavita Rao')
        await p.locator('.sheet label', has_text='WhatsApp number').locator('input').fill('9827166605')
        await p.locator('.sheet label', has_text='Site address').locator('input').fill('B-12, Avanti Vihar, Raipur')
        print('create disabled after basics?', await p.get_by_role('button', name='Create project').is_disabled())
        await p.locator('.scope-ed .chips button', has_text='Kitchen').first.click()
        await p.locator('.scope-ed .sugg').first.click(); await p.wait_for_timeout(200)
        await p.locator('.scope-ed .chips button', has_text='Master Bedroom').first.click()
        await p.locator('.scope-ed .sugg', has_text='Wardrobe').first.click(); await p.wait_for_timeout(200)
        await p.screenshot(path=S+tag+'22-newproject-scope.png', full_page=True)
        bt = p.get_by_role('button', name='Create project')
        t=time.time(); await bt.click(); await p.wait_for_timeout(300)
        print('still open after 300ms:', await p.locator('.sheet h2', has_text='New project').count(), 'btn disabled:', await bt.is_disabled() if await bt.count() else 'gone')
        await p.locator('.sheet h2', has_text='New project').wait_for(state='detached', timeout=20000); print(f'create -> toast: {time.time()-t:.2f}s')
        await p.wait_for_timeout(1500); await p.screenshot(path=S+tag+'23-project-open.png')
        print('toasts', await p.locator('.toast').all_inner_texts())
        print('hash', await p.evaluate('location.hash'))
        tabs = await p.locator('[role=tab], .tabs button').all_inner_texts(); print('tabs', tabs[:20])
        print('errors:', [e[:200] for e in errs])
        await b.close()
asyncio.run(main())
