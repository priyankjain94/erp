import asyncio, re
from h2 import *
async def otp(p, phone):
    await p.goto(BASE + '/'); await p.wait_for_timeout(1200)
    await p.get_by_placeholder('10-digit mobile').fill(phone)
    await p.get_by_role('button', name=re.compile('Send OTP')).click(); await p.wait_for_timeout(700)
    code = re.search(r'(\d{4,6})', await p.locator('.banner.warn').inner_text()).group(1)
    await p.locator('input[maxlength="8"]').fill(code); await p.get_by_role('button', name=re.compile('Log in')).click(); await p.wait_for_timeout(1500)
def clean(errs): return [e for e in errs if 'key" prop' not in e and 'ERR_FAILED' not in e and '401' not in e]
async def main():
    res = []
    def ck(n, c): res.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n)
    st = api('GET', '/state', token=login('9000000001'))
    it = [i for i in st['erp']['items'] if i['stage'] == 'drawing'][0]
    designer = {'deepa':'9000000008','arjun':'9000000009'}[it['designer']]
    async with async_playwright() as pw:
        b = await launch(pw); p = await new_page(b, 1440, 900)
        await otp(p, designer)
        await p.goto(BASE + '/#projects'); await p.wait_for_timeout(800)
        await p.locator('.pcard', has_text=it['code'].split('-')[0]).first.click() if False else None
        await p.locator('.pcard').filter(has_text=[x for x in st['erp']['projects'] if x['id']==it['projectId']][0]['customer']).first.click(); await p.wait_for_timeout(700)
        await p.get_by_text(it['code'], exact=True).first.click(); await p.wait_for_timeout(700)
        ck('drawing stage shows the blocked gate for a missing file', await p.get_by_text('Production drawing file uploaded').count() > 0)
        await p.get_by_role('button', name=re.compile(r'Upload drawing R\d')).click(); await p.wait_for_timeout(300)
        await p.locator('.sheet.wide input[type=file]').first.set_input_files('/tmp/drawing-R1.pdf')
        vals = {'2400':'2400 × 2400 × 600','BWP':'BWP plywood 18 mm','HDHMR 18 mm':'HDHMR 18 mm','Laminate 1 mm':'Laminate 1 mm, Merino 22001 SUD','Hettich soft-close hinges and channels':'Hettich soft-close'}
        for ph, v in vals.items():
            await p.locator(f'.sheet.wide input[placeholder^="{ph}"]').first.fill(v)
        await p.get_by_role('button', name=re.compile(r'^Upload R\d')).click(); await p.wait_for_timeout(2000)
        s2 = api('GET', '/state', token=login(designer))
        it2 = [i for i in s2['erp']['items'] if i['id']==it['id']][0]
        ck('drawing uploaded with a real file and material spec', it2['drawings'][-1]['url'] and it2['spec'].get('carcass') == 'BWP plywood 18 mm')
        ck('drawing open link shown', await p.get_by_text(re.compile(r'^Open R\d')).count() > 0)
        await p.keyboard.press('Escape'); await p.wait_for_timeout(400)
        await p.get_by_role('tab', name='Documents').click(); await p.wait_for_timeout(400)
        await p.locator('.d-body input[type=file]').first.set_input_files('/tmp/floor-plan.pdf'); await p.wait_for_timeout(2000)
        ck('floor plan uploaded from the Documents tab', await p.get_by_text('Final floor plan').count() >= 2)
        ck('no runtime errors (designer)', not clean(p.errs)); print(clean(p.errs)[:3])
        await p.screenshot(path='/tmp/shots/docs_tab.png')
        pr = [x for x in s2['erp']['projects'] if x['id']==it['projectId']][0]
        c = await new_page(b, 390, 844); await c.goto(BASE + '/c'); await c.wait_for_timeout(1000)
        await c.get_by_placeholder('10-digit mobile').fill(re.sub(r'\D','',pr['phone'])[-10:])
        await c.get_by_role('button', name=re.compile('Send OTP')).click(); await c.wait_for_timeout(700)
        code = re.search(r'(\d{4,6})', await c.locator('.banner.warn').inner_text()).group(1)
        await c.locator('input[maxlength="8"]').fill(code); await c.get_by_role('button', name=re.compile('Log in')).click(); await c.wait_for_timeout(1500)
        await c.get_by_role('button', name=re.compile('Documents')).click(); await c.wait_for_timeout(500)
        ck('customer sees the floor plan in Documents', await c.get_by_text('Final floor plan').count() > 0)
        await c.screenshot(path='/tmp/shots/cust_docs.png')
        ck('no runtime errors (customer)', not clean(c.errs)); print(clean(c.errs)[:3])
        await b.close()
    print(sum(res), '/', len(res))
asyncio.run(main())
