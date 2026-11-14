import asyncio, re, json
from h import *
OK = []; FAIL = []
def check(name, cond, info=''):
    (OK if cond else FAIL).append(name); print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else '  -> ' + str(info)))
async def S(p): return await p.evaluate("JSON.parse(localStorage.getItem('mms-erp-v2'))")
async def L(p): return await p.evaluate("JSON.parse(localStorage.getItem('mms-crm-v1'))")
async def toast(p):
    t = await p.locator('.toast').all_inner_texts(); return ' | '.join(t)
async def btn(p, name, exact=True, scope=None, nth=0):
    loc = (scope or p).get_by_role('button', name=name, exact=exact)
    await loc.nth(nth).click(); await p.wait_for_timeout(150)
async def switch_user(p, uid):
    await p.locator('.me-box select').select_option(uid); await p.wait_for_timeout(200)
async def otp_from(p, sel='.banner.warn'):
    t = await p.locator(sel).last.inner_text(); return re.search(r'(\d{4})', t).group(1)

async def main():
    async with async_playwright() as pw:
        b = await launch(pw); p = await new_page(b)
        await go(p, 'ops')
        # ---------- 1. team login ----------
        await p.get_by_role('button', name='Log out').click(); await p.wait_for_timeout(200)
        check('logout shows login screen', await p.get_by_text('Team login').count() == 1)
        await p.get_by_placeholder('10-digit mobile').fill('9999900000'); await btn(p, 'Send OTP on WhatsApp')
        check('unknown number rejected', await p.get_by_text('not registered').count() == 1)
        st = await S(p); ravi = [u for u in st['users'] if u['id'] == 'ravi'][0]
        await p.get_by_placeholder('10-digit mobile').fill(ravi['phone']); await btn(p, 'Send OTP on WhatsApp')
        code = await otp_from(p); await p.locator('input[maxlength="4"]').fill('0000')
        await btn(p, 'Log in'); check('wrong OTP rejected', await p.get_by_text('does not match').count() == 1)
        await p.locator('input[maxlength="4"]').fill(code); await btn(p, 'Log in')
        navs = await p.locator('.rail .nav button').all_inner_texts()
        check('installer login: only Tasks + Installer app', [n.strip().split('\n')[0] for n in navs] == ['Tasks','Installer app'], navs)
        await p.get_by_role('button', name='Log out').click(); await p.wait_for_timeout(150)
        owner = [u for u in st['users'] if u['id'] == 'owner'][0]
        await p.get_by_placeholder('10-digit mobile').fill(owner['phone']); await btn(p, 'Send OTP on WhatsApp')
        await p.locator('input[maxlength="4"]').fill(await otp_from(p)); await btn(p, 'Log in')
        navs = await p.locator('.rail .nav button').all_inner_texts()
        check('owner login: sees Admin', 'Users and access' in ' '.join(navs), navs)

        # ---------- 2. add installation team ----------
        await go(p, 'installers'); await btn(p, 'Add installation team')
        dlg = p.get_by_role('dialog', name='Installation team')
        await dlg.get_by_placeholder('e.g. Imran').fill('Kamal'); await dlg.get_by_placeholder('10-digit mobile').fill('9000011111')
        await dlg.get_by_placeholder('e.g. Raju, Mohan').fill('Ramesh, Dinesh'); await dlg.get_by_role('button', name='Kitchen', exact=True).click()
        await dlg.get_by_role('button', name='Add team and send invite').click(); await p.wait_for_timeout(200)
        st = await S(p); kam = [u for u in st['users'] if u['name'] == 'Kamal']
        check('team saved as installer with helpers', kam and kam[0]['role'] == 'installer' and kam[0]['members'] == ['Ramesh','Dinesh'] and 'KT' not in kam[0]['skills'], kam)
        check('team card shown', await p.locator('.kpi', has_text='Team Kamal').count() == 1)
        check('team in schedule + users list', await p.locator('table b', has_text='Kamal').count() >= 1)
        kid = kam[0]['id']
        # duplicate phone blocked
        await btn(p, 'Add installation team'); dlg = p.get_by_role('dialog', name='Installation team')
        await dlg.get_by_placeholder('e.g. Imran').fill('Dup'); await dlg.get_by_placeholder('10-digit mobile').fill('9000011111')
        check('duplicate phone blocked', await dlg.get_by_text('Already used by Kamal').count() == 1 and await dlg.get_by_role('button', name='Add team and send invite').is_disabled())
        await dlg.get_by_role('button', name='Cancel').click()

        # ---------- 3. assign a whole project to the team ----------
        await p.locator('select[aria-label="Project"]').select_option('P101'); await p.wait_for_timeout(100)
        n_queue = await p.locator('.task-list .task').count()
        await p.get_by_role('button', name=re.compile(r'^Select all')).click()
        await p.locator('select[aria-label="Installer"]').first.select_option(kid)
        await p.locator('input[aria-label="Target date"]').first.fill(await p.evaluate("addDays(5)"))
        await p.get_by_role('button', name=re.compile(r'^Assign \d')).click(); await p.wait_for_timeout(200)
        st = await S(p); mine = [i for i in st['items'] if i['installer'] == kid]
        check(f'whole-project assign ({n_queue} items) saved', len(mine) == n_queue and n_queue > 0, (n_queue, len(mine)))
        check('assigned items appear on schedule', await p.locator('td button.pill').count() >= n_queue)
        check('assign toast', 'assigned to Kamal' in await toast(p), await toast(p))
        # assign kitchen to Kamal -> skill warning (reassign scope)
        await p.get_by_role('button', name='All open (reassign)').click(); await p.locator('select[aria-label="Project"]').select_option('P101')
        row = p.locator('.task-list .task', has_text='KIT-KT-01'); await row.locator('input[type=checkbox]').check()
        await p.locator('select[aria-label="Installer"]').first.select_option(kid); await p.get_by_role('button', name=re.compile(r'^Assign 1')).click(); await p.wait_for_timeout(200)
        check('skill mismatch warning', 'not marked for kitchen' in await toast(p), await toast(p))
        # put the kitchen back with Suresh via the item modal
        await row.locator('button.who').click(); dlg = p.get_by_role('dialog', name='KIT-KT-01')
        await dlg.locator('select[aria-label="Installer"]').select_option('suresh'); await p.keyboard.press('Escape')
        st = await S(p); check('reassign from item detail', [i for i in st['items'] if i['code'] == 'KIT-KT-01' and i['projectId'] == 'P101'][0]['installer'] == 'suresh')
        # edit team + deactivate shows items as unassigned
        await p.locator('.kpi', has_text='Team Kamal').get_by_role('button', name='Edit').click()
        dlg = p.get_by_role('dialog', name='Installation team'); await dlg.get_by_placeholder('e.g. Raju, Mohan').fill('Ramesh, Dinesh, Prakash'); await dlg.get_by_role('button', name='Save').click()
        st = await S(p); check('edit team helpers', [u for u in st['users'] if u['id'] == kid][0]['title'].endswith('team of 4'))

        # ---------- 4. CRM: won lead -> project ----------
        await go(p, 'pipeline'); await p.get_by_role('button', name='List', exact=True).click()
        await p.locator('select[aria-label="Stage for Kunal Bhatia"]').select_option('won'); await p.wait_for_timeout(200)
        await p.keyboard.press('Escape'); await p.locator('tr', has_text='Kunal Bhatia').locator('b').first.click(); await p.get_by_role('tab', name='Details').click()
        check('convert box on won lead', await p.get_by_text('Convert to project').count() >= 1)
        await p.get_by_role('button', name='Convert to project').click(); await p.wait_for_timeout(300)
        st = await S(p); np = [x for x in st['projects'] if x['leadId'] == 'L17']
        check('project created from lead', len(np) == 1, len(np)); P = np[0]
        check('survey task created for Sana', any(t['assignee'] == 'sana' and t['projectId'] == P['id'] for t in st['tasks']))
        leads = await L(p); lead = [l for l in leads['leads'] if l['id'] == 'L17'][0]
        check('CRM lead timeline + WhatsApp welcome', 'Converted to project' in lead['timeline'][-1]['text'] and lead['msgs'][-1]['tpl'] == 'project_update')
        check('project drawer opened', await p.get_by_role('dialog', name='Kunal Bhatia').count() == 1)
        await p.keyboard.press('Escape')

        # ---------- 5. site survey as Sana ----------
        await switch_user(p, 'sana'); navs = await p.locator('.rail .nav button').all_inner_texts()
        check('surveyor nav', [n.strip().split('\n')[0] for n in navs] == ['Projects','Tasks','Survey app'], navs)
        await go(p, 'survey'); await p.locator('.mcard', has_text='Kunal Bhatia').click()
        await btn(p, 'Check in at site'); await btn(p, 'Add room', nth=0)
        await p.locator('.presets button', has_text='Kitchen').first.click(); await p.locator('.sheet-m').get_by_role('button', name='Add room').click(); await p.wait_for_timeout(150)
        await btn(p, 'Tag furniture'); await p.locator('.sheet-m .presets button', has_text='Kitchen').click(); await p.locator('.sheet-m').get_by_role('button', name='Add kitchen').click()
        await btn(p, 'Tag furniture'); await p.locator('.sheet-m .presets button', has_text='Crockery unit').click(); await p.locator('.sheet-m select').select_option('C'); await p.locator('.sheet-m').get_by_role('button', name='Add crockery unit').click()
        await p.locator('.mcard:has(.wall-letter)').first.click()
        for w, val in zip('ABCD', ['3200','2400','3205','2398']):
            await p.get_by_role('button', name='Demo: use a sample photo').click()
            await p.get_by_placeholder('e.g. 3600').fill(val)
            if w == 'A':
                await p.locator('.mcard', has_text='Obstructions').get_by_role('button', name='Add').click()
                sm = p.locator('.sheet-m'); await sm.locator('select').select_option('Door')
                ins = sm.locator('input'); await ins.nth(0).fill('150'); await ins.nth(1).fill('0'); await ins.nth(2).fill('900'); await ins.nth(3).fill('2100'); await sm.get_by_role('button', name='Add').click()
            await p.locator('.ph-foot .big.pri').click(); await p.wait_for_timeout(100)
        await p.locator('.phoneframe .back').click()
        await btn(p, 'Review'); errs = await p.locator('.banner.crit').count()
        check('review passes with complete walls', errs == 0)
        await btn(p, 'Submit survey'); st = await S(p)
        its = [i for i in st['items'] if i['projectId'] == P['id']]
        check('survey created 2 items at Drawing', len(its) == 2 and all(i['stage'] == 'drawing' for i in its), [(i['code'], i['stage']) for i in its])
        check('designer tasks created', sum(1 for t in st['tasks'] if t['projectId'] == P['id'] and t['title'].startswith('Production drawing')) == 2)
        pr = [x for x in st['projects'] if x['id'] == P['id']][0]
        check('survey data saved (walls, door)', pr['survey']['status'] == 'submitted' and len(pr['survey']['rooms'][0]['walls']) == 4 and pr['survey']['rooms'][0]['walls'][0]['obs'][0]['type'] == 'Door')
        kit = [i for i in its if i['type'] == 'KT'][0]

        # ---------- 6. designer: drawing + gate ----------
        await switch_user(p, 'deepa' if kit['designer'] == 'deepa' else 'arjun')
        await go(p, 'projects'); await p.locator('.pcard', has_text='Kunal Bhatia').click()
        await p.locator('tr', has_text=kit['code']).click(); dlg = p.get_by_role('dialog', name=kit['code'])
        await dlg.get_by_role('button', name=re.compile(r'^Upload R0')).click()
        check('designer: move disabled until customer approves', await dlg.get_by_role('button', name=re.compile(r'^Move to PI')).is_disabled() and await dlg.get_by_text('Your role cannot override').count() == 1)
        await dlg.get_by_role('button', name='Send for approval').click()
        st = await S(p); check('hard gate keeps item in Drawing', [i for i in st['items'] if i['id'] == kit['id']][0]['stage'] == 'drawing')
        await p.keyboard.press('Escape'); await p.keyboard.press('Escape')

        # ---------- 7. customer app: approve + change request ----------
        await switch_user(p, 'owner'); await go(p, 'customer')
        await p.get_by_placeholder('10-digit mobile').fill(pr['phone']); await btn(p, 'Send OTP')
        await p.locator('.phoneframe input[maxlength="4"]').fill(await otp_from(p)); await btn(p, 'Log in')
        check('customer home', await p.get_by_text('Hello Kunal').count() == 1)
        await p.locator('.mcard', has_text='waiting for your approval').click(); await btn(p, 'Approve')
        st = await S(p); check('customer approval saved', [i for i in st['items'] if i['id'] == kit['id']][0]['drawings'][-1]['approved'])
        await p.locator('.phoneframe .back').click(); await btn(p, 'Raise a complaint'); await p.locator('.sheet-m textarea').fill('Showroom shutter sample was scratched'); await btn(p, 'Send')
        st = await S(p); check('complaint -> urgent PM task', any(t['title'].startswith('Customer complaint') and t['priority'] == 'urgent' for t in st['tasks']))

        # ---------- 8. full pipeline to completion as owner ----------
        async def open_item():
            await go(p, 'projects'); await p.locator('.pcard', has_text='Kunal Bhatia').click(); await p.locator('tr', has_text=kit['code']).click()
            return p.get_by_role('dialog', name=kit['code'])
        async def stage(): return [i for i in (await S(p))['items'] if i['id'] == kit['id']][0]
        dlg = await open_item(); await dlg.get_by_role('button', name=re.compile(r'^Move to PI')).click(); await p.wait_for_timeout(150)
        check('moved to PI after approval', (await stage())['stage'] == 'pi')
        await dlg.get_by_label('Hardware PI raised').check(); await dlg.get_by_label('Production PI raised').check()
        b_ = dlg.get_by_role('button', name=re.compile(r'^Move to Order'))
        check('payment gate blocks order (needs override reason)', await b_.is_disabled() and 'override' in await b_.inner_text())
        await p.keyboard.press('Escape'); await p.get_by_role('tab', name='Payments & site').click()
        await p.get_by_role('switch', name='Before order received').click(); await p.get_by_label('Civil, electrical, painting and flooring are done').check()
        await p.keyboard.press('Escape'); dlg = await open_item()
        await dlg.get_by_role('button', name=re.compile(r'^Move to Order')).click(); await p.wait_for_timeout(100)
        check('moved to Order after payment', (await stage())['stage'] == 'order')
        await dlg.get_by_placeholder('PO-2431').fill('PO-9001'); await dlg.get_by_role('button', name=re.compile(r'^Move to Dispatch')).click(); await p.wait_for_timeout(100)
        await dlg.get_by_placeholder('Vehicle no.').fill('CG04 AB 1234'); await dlg.get_by_label('Material delivered at site').check()
        await dlg.locator('select[aria-label="Installer"]').select_option(kid)
        await dlg.get_by_role('button', name=re.compile(r'^Move to Install')).click(); await p.wait_for_timeout(150)
        s8 = await stage(); check('moved to Install with Kamal as owner', s8['stage'] == 'install' and s8['owner'] == kid, (s8['stage'], s8['owner']))
        st = await S(p); check('install task created for Kamal', any(t['assignee'] == kid and t['itemId'] == kit['id'] and t['status'] != 'done' for t in st['tasks']))
        await p.keyboard.press('Escape'); await p.keyboard.press('Escape')

        # ---------- 9. installer app as Kamal ----------
        await switch_user(p, kid); navs = await p.locator('.rail .nav button').all_inner_texts()
        check('installer nav', [n.strip().split('\n')[0] for n in navs] == ['Tasks','Installer app'], navs)
        await go(p, 'install'); await p.locator('.mcard', has_text=kit['code']).click()
        gots = p.locator('.phoneframe button', has_text=re.compile(r'^Got$'))
        n_boxes = await gots.count()
        for _ in range(n_boxes - 1): await gots.first.click()
        await p.locator('.phoneframe button', has_text='Missing').last.click()   # last box missing -> snag sheet
        await p.locator('.sheet-m').get_by_role('button', name='Report snag').click(); await p.wait_for_timeout(100)
        st = await S(p); it = [i for i in st['items'] if i['id'] == kit['id']][0]
        check('missing box -> snag + reorder task', len(it['snags']) == 1 and any(t['title'].startswith('Snag reorder') for t in st['tasks']))
        await btn(p, 'Start work'); await p.wait_for_timeout(1100); await btn(p, 'Pause')
        await p.locator('.sheet-m button', has_text='Lunch / break').click(); await btn(p, 'Resume')
        await btn(p, 'Complete')
        for c in await p.locator('.sheet-m input[type=checkbox]').all(): await c.check()
        await p.get_by_role('button', name='Demo: use a sample photo').click(); await btn(p, 'Send OTP to customer')
        await p.locator('.sheet-m input[maxlength="4"]').fill(await otp_from(p, '.sheet-m .banner.warn')); await btn(p, 'Confirm and complete')
        it = await stage(); check('completed but held by open snag', it['installDone'] and it['stage'] == 'install' and len(it['sessions']) == 2, (it['stage'], len(it['sessions'])))

        # ---------- 10. PM closes snag, moves to handover and completed; customer rates ----------
        await switch_user(p, 'vikram'); dlg = await open_item()
        for _ in range(3): await dlg.get_by_role('button', name=re.compile(r'^Mark (reordered|dispatched|fixed)')).click(); await p.wait_for_timeout(80)
        await dlg.get_by_role('button', name=re.compile(r'^Move to Handover')).click(); await p.wait_for_timeout(100)
        await dlg.get_by_role('button', name=re.compile(r'^Move to Done')).click(); await p.wait_for_timeout(100)
        check('item completed', (await stage())['stage'] == 'closed')
        await p.keyboard.press('Escape'); await p.keyboard.press('Escape')
        # second item still in drawing -> owner override path
        await switch_user(p, 'owner'); cu = [i for i in its if i['type'] == 'CU'][0]
        await go(p, 'projects'); await p.locator('.pcard', has_text='Kunal Bhatia').click(); await p.locator('tr', has_text=cu['code']).click()
        dlg = p.get_by_role('dialog', name=cu['code']); await dlg.get_by_role('button', name=re.compile(r'^Upload R0')).click()
        await dlg.get_by_placeholder('e.g. Customer approved on call, written approval tomorrow').fill('Approved on call')
        await dlg.get_by_role('button', name=re.compile(r'override')).click(); await p.wait_for_timeout(100)
        st = await S(p); c2 = [i for i in st['items'] if i['id'] == cu['id']][0]
        check('owner override logged', c2['stage'] == 'pi' and c2['log'][-2].get('override') == 'Approved on call')

        # ---------- 11. tasks: create, handover, block, WhatsApp done, repeat ----------
        await p.keyboard.press('Escape'); await p.keyboard.press('Escape')
        await switch_user(p, 'vikram'); await go(p, 'tasks'); await btn(p, 'New task')
        dlg = p.get_by_role('dialog', name='New task'); await dlg.get_by_placeholder('e.g. Share revised kitchen drawing with customer').fill('Call Kunal about handover date')
        await dlg.locator('select').first.select_option('manish'); await dlg.locator('.seg').get_by_role('button', name='Urgent', exact=True).click()
        await dlg.get_by_role('button', name='Assign and send WhatsApp').click()
        st = await S(p); t = [x for x in st['tasks'] if x['title'] == 'Call Kunal about handover date'][0]
        check('task created with assigner + urgent', t['assigner'] == 'vikram' and t['assignee'] == 'manish' and t['priority'] == 'urgent')
        await switch_user(p, 'manish'); await go(p, 'tasks')
        check('purchase sees My tasks only', await p.get_by_role('button', name='Team board').count() == 0)
        await p.locator('.chip', has_text='Upcoming').click()
        await p.get_by_role('button', name='Call Kunal about handover date').click()
        dlg = p.get_by_role('dialog', name='Call Kunal about handover date')
        await dlg.get_by_role('button', name='Hand over').click(); await dlg.locator('select[aria-label="Hand over to"]').select_option('vikram')
        await dlg.get_by_placeholder('Handover note (required)').fill('PM should call directly'); await dlg.get_by_role('button', name='Hand over').last.click()
        st = await S(p); t = [x for x in st['tasks'] if x['id'] == t['id']][0]
        check('handover chain recorded', t['assignee'] == 'vikram' and any(e['e'] == 'seen' for e in t['events']) and any(e['e'] == 'handover' and e['note'] == 'PM should call directly' for e in t['events']))
        await p.keyboard.press('Escape')
        await switch_user(p, 'owner'); await go(p, 'tasks'); await p.get_by_role('button', name='WhatsApp reminders').click()
        await p.locator('select[aria-label="Person"]').select_option('manish')
        before = len([x for x in (await S(p))['tasks'] if x['assignee'] == 'manish' and x['status'] == 'done'])
        mk = p.locator('.wa-btns button', has_text=re.compile(r'^Mark done$'))
        if await mk.count(): await mk.first.click(); await p.wait_for_timeout(100)
        after = len([x for x in (await S(p))['tasks'] if x['assignee'] == 'manish' and x['status'] == 'done'])
        check('WhatsApp Mark done completes a task (repeat creates next)', after == before + 1)

        # ---------- 12. users and access ----------
        await go(p, 'users'); await btn(p, 'Add user')
        await p.locator('.box input').nth(0).fill('Neha'); await p.locator('.box input').nth(1).fill('9123456789'); await p.locator('.box select').select_option('designer')
        await btn(p, 'Add and send invite'); st = await S(p)
        check('user added', any(u['name'] == 'Neha' and u['role'] == 'designer' for u in st['users']))
        await p.get_by_role('button', name='Roles and access').click()
        await p.get_by_label('Users and access for Operations head').check(); st = await S(p)
        check('permission matrix saves', st['roles']['ops_head']['admin'] is True)
        await switch_user(p, 'meera'); navs = ' '.join(await p.locator('.rail .nav button').all_inner_texts())
        check('ops head now sees Users and access', 'Users and access' in navs)
        await switch_user(p, 'owner'); await go(p, 'users'); await p.get_by_role('button', name='Change log').click()
        check('change log records', await p.locator('.chain li').count() >= 3)
        # deactivate team -> items back to queue
        await go(p, 'installers'); await p.locator('.kpi', has_text='Team Kamal').get_by_role('button', name='Edit').click()
        await p.get_by_role('button', name='Deactivate team').click(); await p.locator('select[aria-label="Project"]').select_option('P101')
        check('deactivated team items return to queue', await p.locator('.task-list .task', has_text='(inactive)').count() >= 1)

        # ---------- 13. other screens render after all this ----------
        for v in ['ops','projects','team','dashboard','installers']:
            await go(p, v)
        real = [e for e in p.errs if 'key" prop' not in e and 'ERR_FAILED' not in e]
        check('no runtime errors through the whole run', not real, real[:3])
        await b.close()
    print(f'\n{len(OK)} passed, {len(FAIL)} failed'); print('FAILED:', FAIL)
asyncio.run(main())
