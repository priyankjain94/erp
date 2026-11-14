import asyncio, json, re, urllib.request
from playwright.async_api import async_playwright
BASE = 'http://localhost:8090'
RB = open('/home/claude/harness/react-bundle.js').read()
HTM = open('/home/claude/harness/htm-mini.js').read()
async def route(r):
    u = r.request.url
    if 'react.production' in u: return await r.fulfill(body=RB, content_type='application/javascript')
    if 'react-dom' in u: return await r.fulfill(body='', content_type='application/javascript')
    if 'htm@' in u: return await r.fulfill(body=HTM, content_type='application/javascript')
    if u.startswith(BASE): return await r.continue_()
    return await r.abort()
async def new_page(b, w=1400, h=900):
    ctx = await b.new_context(viewport={'width':w,'height':h}, service_workers='block')
    p = await ctx.new_page(); p.errs = []
    p.on('console', lambda m: p.errs.append(m.text) if m.type == 'error' else None)
    p.on('pageerror', lambda e: p.errs.append('PAGEERROR ' + str(e)))
    await p.route('**/*', route)
    return p
def launch(pw): return pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
def api(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + '/api/v1' + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type':'application/json', **({'Authorization':'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r: return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e: return {'_status': e.code, **json.loads(e.read() or b'{}')}
def login(phone, audience='staff'):
    r = api('POST', '/auth/otp/request', {'phone':phone, 'audience':audience})
    v = api('POST', '/auth/otp/verify', {'phone':phone, 'audience':audience, 'code':r['devCode']})
    return v['accessToken']
