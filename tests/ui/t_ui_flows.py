import asyncio, re
from h2 import *
async def otp_login(p, phone, cust=False):
    await p.get_by_placeholder('10-digit mobile').fill(phone)
    await p.get_by_role('button', name=re.compile('Send OTP')).click(); await p.wait_for_timeout(600)
    code = re.search(r'(\d{4,6})', await p.locator('.banner.warn').inner_text()).group(1)
    await p.locator('input[maxlength="8"]').fill(code); await p.get_by_role('button', name=re.compile('Log in')).click(); await p.wait_for_timeout(1500)
def clean(errs): return [e for e in errs if 'key" prop' not in e and 'ERR_FAILED' not in e and 'favicon' not in e and '401' not in e]
async def main():
    res = []
    def ck(n, c): res.append((n, bool(c))); print(('PASS ' if c else 'FAIL ') + n)
    async with async_playwright() as pw:
        b = await launch(pw); p = await new_page(b)
        await p.goto(BASE + '/'); await p.wait_for_timeout(1200); await otp_login(p, '9000000002')  # Meera, ops head
        await p.goto(BASE + '/#installers'); await p.wait_for_timeout(800)
        await p.get_by_role('button', name='Add installation team').click()
        await p.get_by_placeholder('e.g. Imran').fill('Salim'); await p.get_by_placeholder('10-digit mobile').fill('9000033333')
        await p.get_by_placeholder('e.g. Raju, Mohan').fill('Raju, Mohan')
        await p.get_by_role('button', name='Add team and send invite').click(); await p.wait_for_timeout(1200)
        ck('team added from Installer management screen', await p.get_by_text('Team Salim').count())
        sel = p.locator('select[aria-label="Installer"]').first
        await sel.select_option(label='Salim')
        boxes = p.locator('.task-list input[type=checkbox]'); n = await boxes.count()
        for i in range(min(2, n)): await boxes.nth(i).check()
        await p.locator('.box button.primary', has_text='Assign').first.click(); await p.wait_for_timeout(1500)
        tok = login('9000000001'); st = api('GET', '/state', token=tok)
        sal = [u for u in st['erp']['users'] if u['name'] == 'Salim'][0]
        mine = [i for i in st['erp']['items'] if i['installer'] == sal['id']]
        ck(f'assigned {len(mine)} items to Salim through the UI (saved on server)', len(mine) == min(2, n))
        ck('no runtime errors (ops head)', not clean(p.errs)); print(clean(p.errs)[:3])
        # Salim logs in on a phone and sees exactly his jobs
        m = await new_page(b, 390, 844); await m.goto(BASE + '/'); await m.wait_for_timeout(1200); await otp_login(m, '9000033333')
        await m.goto(BASE + '/#install'); await m.wait_for_timeout(1000)
        await m.get_by_role('button', name=re.compile('Upcoming')).click(); await m.wait_for_timeout(400)
        body = await m.locator('body').inner_text()
        ck('installer team sees its jobs on mobile', all(i['code'] in body for i in mine))
        ck('installer has no CRM nav', await m.locator('.rail .nav button', has_text='Pipeline').count() == 0)
        ck('no runtime errors (installer mobile)', not clean(m.errs)); print(clean(m.errs)[:3])
        await m.screenshot(path='/tmp/ui_installer_mobile.png')
        # customer portal
        c = await new_page(b, 390, 844); await c.goto(BASE + '/c'); await c.wait_for_timeout(1200)
        await otp_login(c, '9827890116', cust=True)
        cb = await c.locator('body').inner_text()
        ck('customer portal shows their project', 'Hello Vivek' in cb and 'Your furniture' in cb)
        ck('no runtime errors (customer)', not clean(c.errs)); print(clean(c.errs)[:3]); print(cb[:300].replace('\n',' | '))
        await c.screenshot(path='/tmp/ui_customer.png')
        await b.close()
    print(sum(x for _, x in res), '/', len(res))
asyncio.run(main())
