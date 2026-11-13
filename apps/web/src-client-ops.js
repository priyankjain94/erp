
/* =====================================================================
   API CLIENT — every change goes to the Make My Space server; the server
   enforces permissions and business rules and returns the fresh state.
   ===================================================================== */
const API = (() => {
  let token = null, audience = 'user', onAuthLost = () => {};
  const qKey = 'mms-offline-queue';
  const readQ = () => { try { return JSON.parse(localStorage.getItem(qKey)) || []; } catch(e){ return []; } };
  const writeQ = q => { try { localStorage.setItem(qKey, JSON.stringify(q)); } catch(e){} try { window.dispatchEvent(new Event('mms-queue')); } catch(e){} };
  async function refresh(){
    try {
      const r = await fetch('/api/v1/auth/refresh', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({audience})});
      if (!r.ok) return false;
      token = (await r.json()).accessToken; return true;
    } catch(e){ return false; }
  }
  async function call(method, path, body, opts = {}){
    const doFetch = () => fetch('/api/v1' + path, {method, credentials:'same-origin', headers:{'Content-Type':'application/json', ...(token ? {Authorization:'Bearer ' + token} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
    let r;
    try { r = await doFetch(); }
    catch(e){
      if (opts.queue){ const q = readQ().filter(x => !(opts.dedupe && x.dedupe === opts.dedupe)); q.push({method, path, body, dedupe:opts.dedupe, at:Date.now()}); writeQ(q); return {queued:true}; }
      throw new Error('No internet connection. Please try again.');
    }
    if (r.status === 401 && !opts.noRefresh){
      if (await refresh()) r = await doFetch();
      else { onAuthLost(); const err = new Error('Please log in again.'); err.status = 401; throw err; }
    }
    const data = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok){ const err = new Error(data.message || 'Something went wrong.'); err.status = r.status; err.data = data; throw err; }
    return data;
  }
  let flushing = false;
  async function flush(){
    if (flushing || !navigator.onLine) return; const q = readQ(); if (!q.length) return;
    flushing = true; const rest = [];
    for (const x of q){ try { await call(x.method, x.path, x.body); } catch(e){ if (!e.status) rest.push(x); } }
    writeQ(rest); flushing = false;
  }
  window.addEventListener('online', flush); setInterval(flush, 20000);
  return { call, refresh, flush, pending: () => readQ().length, setToken: t => { token = t; }, setAudience: a => { audience = a; }, onAuthLost: fn => { onAuthLost = fn; } };
})();
const SERVER = {demoMode:false, whatsappLive:false};
fetch('/api/v1/auth/config').then(r => r.json()).then(c => Object.assign(SERVER, c)).catch(() => {});

async function uploadDataUrl(dataUrl){
  const blob = await (await fetch(dataUrl)).blob();
  const type = blob.type || 'image/jpeg';
  const slot = await API.call('POST', '/uploads', {contentType:type, size:blob.size});
  const r = await fetch(slot.uploadUrl, {method:'PUT', body:blob, headers:{'Content-Type':type}});
  if (!r.ok) throw new Error('Upload failed');
  return slot; // {ref, viewUrl}
}
const photoSrc = (photo, url) => photo && String(photo).startsWith('upload:') ? url : photo;
function useQueueCount(){
  const [n, setN] = useState(API.pending());
  useEffect(() => { const f = () => setN(API.pending()); window.addEventListener('mms-queue', f); const t = setInterval(f, 5000); return () => { window.removeEventListener('mms-queue', f); clearInterval(t); }; }, []);
  return n;
}
const geo = () => new Promise(res => { try { navigator.geolocation.getCurrentPosition(p => res({lat:p.coords.latitude, lng:p.coords.longitude}), () => res({}), {timeout:4000}); } catch(e){ res({}); } });

/* ---------- operations used by every screen (same names as the tested prototype) ---------- */
function makeOps(erp, setErp, toast, leads, crm, app){
  const me = erp.me;
  const apply = res => { if (res && res.state) app.applyState(res.state); return res; };
  const run = async (method, path, body, msg, opts) => {
    try { const res = apply(await API.call(method, path, body, opts)); if (res && res.queued) toast('Saved on this phone. It will sync when the internet is back.'); else if (msg) toast(typeof msg === 'function' ? msg(res) : msg); return res || {}; }
    catch(e){ toast(e.message || 'Something went wrong.'); return null; }
  };
  const timers = app.timers, pend = app.pending;
  const later = (key, fn, ms) => { clearTimeout(timers[key]); timers[key] = setTimeout(async () => { delete timers[key]; await fn(); if (!Object.keys(timers).length) app.flushDeferred(); }, ms); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const E = () => app.cur();
  const ops = {
    me,
    gates: it => gatesFor(it, E().projects.find(p => p.id === it.projectId)),
    async setMe(id){
      if (!id){ try { await API.call('POST', '/auth/logout'); } catch(e){} app.loggedOut(); return; }
      try { const r = await API.call('POST', '/auth/demo-switch', {userId:id}); API.setToken(r.accessToken); await app.reload(); toast('Now using the app as ' + uname(id) + '.'); } catch(e){ toast(e.message); }
    },
    async moveItem(id, dir, reason){
      const it = E().items.find(i => i.id === id);
      try {
        const res = apply(await API.call('POST', `/items/${id}/transition`, {direction:dir, reason:reason || ''}));
        const to = pstById[res.to];
        toast(dir === 'back' ? `${it.code} sent back to ${to.short}.` : `${it.code} moved to ${to.short}.${res.flags && res.flags.length ? ' Flagged amber.' : ''}`);
        return true;
      } catch(e){ toast(e.message); return false; }
    },
    updItem(id, fn){
      const before = E().items.find(i => i.id === id); if (!before) return;
      const after = clone(before); fn(after, E());
      setErp(s => ({...s, items:s.items.map(i => i.id === id ? after : i)}));
      const patch = {};
      for (const k of ['owner','target','hwPI','prodPI','po','delivered']) if (!same(before[k], after[k])) patch[k] = after[k];
      if (!same(before.dispatch, after.dispatch) && after.dispatch) patch.dispatch = {vehicle:after.dispatch.vehicle || '', boxes:after.dispatch.boxes === '' || after.dispatch.boxes == null ? null : Number(after.dispatch.boxes), date:after.dispatch.date || null};
      if (Object.keys(patch).length){
        pend['item:' + id] = {...(pend['item:' + id] || {}), ...patch};
        const typing = 'po' in patch || 'dispatch' in patch;
        later('item:' + id, () => { const p = pend['item:' + id]; delete pend['item:' + id]; return run('PATCH', `/items/${id}`, p); }, typing ? 700 : 0);
      }
      if (after.drawings.length > before.drawings.length) run('POST', `/items/${id}/drawings`, {}, `Drawing R${after.drawings.length - 1} uploaded with packing list.`);
      else if (after.drawings.length && !before.drawings[before.drawings.length - 1]?.approved && after.drawings[after.drawings.length - 1].approved) run('POST', `/items/${id}/drawings/approve`, {}, 'Customer approval recorded.');
      after.boxes.forEach((b, i) => { if (before.boxes[i] && before.boxes[i].got !== b.got) run('POST', `/items/${id}/boxes/${b.n}`, {got:b.got}, null, {queue:true, dedupe:`box:${id}:${b.n}`}); });
    },
    sendDrawing: id => run('POST', `/items/${id}/drawings/send`, {}, 'Sent to the customer on WhatsApp with an Approve button.'),
    updProject(id, fn){
      const before = E().projects.find(p => p.id === id); if (!before) return;
      const after = clone(before); fn(after, E());
      setErp(s => ({...s, projects:s.projects.map(p => p.id === id ? after : p)}));
      after.payments.forEach((m, i) => { if (before.payments[i] && before.payments[i].received !== m.received) run('POST', `/projects/${id}/payments/${m.id}`, {received:m.received}); });
      if (before.siteReady !== after.siteReady) run('PATCH', `/projects/${id}`, {siteReady:after.siteReady});
      if (before.notes !== after.notes) later('notes:' + id, () => run('PATCH', `/projects/${id}`, {notes:after.notes}), 800);
      if (!same(before.survey.rooms, after.survey.rooms)) {
        app.surveyDraft[id] = after.survey.rooms;
        later('survey:' + id, () => API.call('PUT', `/surveys/${id}/draft`, {rooms:cleanRooms(app.surveyDraft[id])}, {queue:true, dedupe:'survey:' + id}).catch(e => toast(e.message)), 900);
      }
      if (!same(before.feedback, after.feedback) && after.feedback) run('POST', `/projects/${id}/feedback`, {rating:after.feedback.rating, comment:after.feedback.comment || ''});
    },
    assign: (itemIds, installer, target) => run('POST', '/assignments', {itemIds, installer, target:target || null}, res => `${itemIds.length} item${itemIds.length > 1 ? 's' : ''} assigned to ${uname(installer)}. WhatsApp sent.${res.warning ? ' ' + res.warning : ''}`),
    addTask: f => run('POST', '/tasks', {title:f.title, projectId:f.projectId || null, itemId:f.itemId || null, assignee:f.assignee, deadline:f.deadline, priority:f.priority || 'normal', proof:f.proof || '', repeat:f.repeat || ''}, `Task assigned to ${uname(f.assignee)}. WhatsApp sent with Open / Start buttons.`),
    taskDo(id, action, data = {}){
      const t0 = E().tasks.find(x => x.id === id);
      const msg = {start:'Task started.', done:`Done: ${t0?.title}${t0?.repeat ? '. Next one scheduled.' : '.'}`, block:'Marked blocked. Reminders paused; assigner notified on WhatsApp.', unblock:'Unblocked.', handover:`Handed over to ${uname(data.to)}. WhatsApp sent.`, remind:'Reminder sent on WhatsApp.', deadline:'Deadline changed.'}[action];
      return run('POST', `/tasks/${id}/${action}`, data, msg);
    },
    async convert(lead, f){
      const res = lead
        ? await run('POST', `/leads/${lead.id}/convert`, {pm:f.pm, target:f.target, surveyDate:f.surveyDate, advance:!!f.advance, address:f.address})
        : await run('POST', '/projects', {customer:f.customer, phone:f.phone, address:f.address, value:Number(f.value) || 0, pm:f.pm, target:f.target, surveyDate:f.surveyDate, advance:!!f.advance});
      if (res && res.code) toast(`${res.code} created. Survey task sent to the surveyor${lead ? ', welcome message sent to the customer' : ''}.`);
      return res ? res.id : null;
    },
    async checkIn(pid){ const g = await geo(); return run('POST', `/surveys/${pid}/check-in`, g, 'Checked in. Survey timer started.', {queue:true}); },
    async submitSurvey(pid, sign){
      clearTimeout(timers['survey:' + pid]); delete timers['survey:' + pid];
      const rooms = E().projects.find(p => p.id === pid).survey.rooms;
      return run('POST', `/surveys/${pid}/submit`, {signed:!!sign, rooms:cleanRooms(rooms)}, res => `Survey submitted. ${res.created} items created, designer tasks assigned, customer updated on WhatsApp.`);
    },
    async startWork(id){ const g = await geo(); return run('POST', `/items/${id}/work/start`, g, null, {queue:true}); },
    pauseWork: (id, reason) => run('POST', `/items/${id}/work/pause`, {reason}, `Paused: ${reason}. Timer stopped.`, {queue:true}),
    async requestSignoff(id, checklist, photo){
      let ref = photo;
      if (photo && photo.startsWith('data:')) { try { ref = (await uploadDataUrl(photo)).ref; } catch(e){ toast('Photo upload failed. Check the internet and try again.'); return null; } }
      return run('POST', `/items/${id}/complete/request-otp`, {checklist, photo:ref});
    },
    verifySignoff: (id, code) => run('POST', `/items/${id}/complete/verify`, {code}, res => res.heldBySnags ? `Installed. ${res.heldBySnags} snag open, so it stays in Installation until fixed.` : 'Installed and signed off. Moved to Handover; the PM is notified.'),
    async raiseSnag(id, s){
      let photo = s.photo || null;
      if (photo && photo.startsWith('data:')) { try { photo = (await uploadDataUrl(photo)).ref; } catch(e){ photo = null; } }
      return run('POST', `/items/${id}/snags`, {type:s.type, part:s.part, note:s.note || '', photo}, 'Snag raised. Reorder task sent to purchase on WhatsApp.', {queue:true});
    },
    advanceSnag: (id, sid) => run('POST', `/snags/${sid}/advance`, {}),
    /* admin */
    addUser: f => run('POST', '/users', f, `${f.name} added. Login invite sent on WhatsApp.`),
    updUser: (id, patch, msg) => run('PATCH', `/users/${id}`, patch, msg),
    setPerm: (role, perm, allowed) => run('PUT', `/roles/${role}/permissions`, {perm, allowed}),
    resetRoles: () => run('POST', '/roles/reset', {}, 'Access reset to defaults.'),
    addTeam: f => run('POST', '/teams', f, `Team ${f.name} added. Login invite sent on WhatsApp.`),
    updTeam: (id, patch, msg) => run('PATCH', `/teams/${id}`, patch, msg)
  };
  return ops;
}
function cleanRooms(rooms){
  return (rooms || []).map(r => ({id:r.id, name:r.name, code:r.code, ceiling:Number(r.ceiling) || 2900, floor:r.floor || '', shape:r.shape || 'rect',
    walls:r.walls.map(w => ({label:w.label, w:w.w === '' ? undefined : w.w, h:w.h === '' ? undefined : w.h, photo:w.photo || null, notes:w.notes || '', obs:(w.obs || []).map(o => ({type:o.type, left:Number(o.left) || 0, floor:Number(o.floor) || 0, w:Number(o.w), h:Number(o.h)}))})),
    items:(r.items || []).map(x => ({type:x.type, wall:x.wall, desc:x.desc || ''}))}));
}
