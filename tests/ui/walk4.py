import asyncio, sys, time, re
sys.path.insert(0, '/home/claude/harness')
import h2
h2.BASE = 'http://localhost:8091'
from h2 import *
BASE = h2.BASE; S = '/home/claude/audit/shots/'
async def main():
    async with async_playwright() as pw:
        b = await launch(pw)
        ctx = await b.new_context(viewport={'width':390,'height':844}, service_workers='block', is_mobile=True, has_touch=True, storage_state='/home/claude/audit/state.json')
        p = await ctx.new_page(); await p.route('**/*', h2.route)
        await p.goto(BASE + '/#projects'); await p.wait_for_selector('.view', timeout=20000); await p.wait_for_timeout(500)
        await p.get_by_role('button', name=re.compile('New project', re.I)).first.click(); await p.wait_for_timeout(500)
        await p.locator('.sheet').evaluate('e => e.scrollTop = 99999'); await p.wait_for_timeout(300)
        await p.screenshot(path=S+'m24-newproject-bottom.png')
        bt = p.get_by_role('button', name='Create project'); box = await bt.bounding_box(); print('create btn box', box)
        nav = p.locator('nav').last; print('last nav box', await nav.bounding_box())
        hit = await p.evaluate("""() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Create project'); const r=b.getBoundingClientRect(); const el=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2); return el===b||b.contains(el) ? 'reachable' : 'covered by '+el.tagName+'.'+el.className; }""")
        print('create button:', hit)
        await p.goto(BASE + '/#pipeline'); await p.reload(); await p.wait_for_selector('.view', timeout=20000); await p.wait_for_timeout(600)
        await p.get_by_role('button', name=re.compile('Add lead', re.I)).first.click(); await p.wait_for_timeout(400)
        await p.locator('.sheet').evaluate('e => e.scrollTop = 99999'); await p.wait_for_timeout(300)
        await p.screenshot(path=S+'m16-addlead-bottom.png')
        hit = await p.evaluate("""() => { const b=[...document.querySelectorAll('.sheet button')].find(x=>x.textContent.trim()==='Add lead'); const r=b.getBoundingClientRect(); const el=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2); return (el===b||b.contains(el) ? 'reachable' : 'covered by '+el.tagName+'.'+el.className) + ' y=' + Math.round(r.y); }""")
        print('add lead button:', hit)
        await b.close()
asyncio.run(main())
