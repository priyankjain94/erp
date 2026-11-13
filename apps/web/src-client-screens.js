
/* ---------- Login (team or customer) ---------- */
function LoginScreen({audience = 'staff', onLogin, title = 'Team login'}){
  const [phone, setPhone] = useState(''), [step, setStep] = useState(1), [code, setCode] = useState(''), [err, setErr] = useState(''), [info, setInfo] = useState(null), [busy, setBusy] = useState(false), [demo, setDemo] = useState([]);
  useEffect(() => { if (SERVER.demoMode || true) API.call('GET', '/auth/demo-users?audience=' + audience).then(r => setDemo(r.users || [])).catch(() => {}); }, []);
  const next = async e => { e.preventDefault(); setErr('');
    if (phone.replace(/\D/g,'').length < 10) return setErr('Enter your 10-digit mobile number.');
    setBusy(true);
    try { const r = await API.call('POST', '/auth/otp/request', {phone, audience}); setInfo(r); setStep(2); } catch(x){ setErr(x.message); }
    setBusy(false); };
  const verify = async e => { e.preventDefault(); setErr(''); setBusy(true);
    try { const r = await API.call('POST', '/auth/otp/verify', {phone, audience, code}); API.setToken(r.accessToken); await onLogin(r); } catch(x){ setErr(x.message); }
    setBusy(false); };
  return html`<div style=${{minHeight:'100%',display:'grid',placeItems:'center',padding:16,background:'var(--bg)',overflow:'auto'}}>
    <div className="sheet" style=${{width:'min(420px,100%)'}}>
      <header style=${{display:'flex',gap:12,alignItems:'center'}}><${Mark}/><div><h2>${title}</h2><p style=${{margin:0}}>Make My Space${audience === 'customer' ? ' · track your project' : ' CRM + Operations'}</p></div></header>
      ${step === 1 ? html`<form className="form" style=${{gridTemplateColumns:'1fr'}} onSubmit=${next} noValidate>
          <label>Mobile number (WhatsApp)<input inputMode="tel" autoFocus value=${phone} onInput=${e => setPhone(e.target.value)} placeholder="10-digit mobile"/></label>
          ${err && html`<span className="err">${err}</span>`}
          <button className="btn primary" type="submit" disabled=${busy} style=${{justifyContent:'center'}}>${busy ? 'Sending…' : 'Send OTP on WhatsApp'}</button>
          ${demo.length > 0 && html`<details style=${{fontSize:12,color:'var(--muted)'}}><summary>Demo numbers</summary><div style=${{display:'grid',gap:2,marginTop:6}}>${demo.map(u => html`<button type="button" key=${u.phone} className="linkbtn" style=${{color:'var(--muted)',textAlign:'left',marginTop:0}} onClick=${() => setPhone(u.phone)}>${u.name}${u.role ? ' · ' + (roleById[u.role]?.name || u.role) : ''} · ${u.phone}</button>`)}</div></details>`}
        </form>`
      : html`<form className="form" style=${{gridTemplateColumns:'1fr'}} onSubmit=${verify}>
          <div className="banner">Hi ${info.name}. We sent a code to ${info.phone} on WhatsApp.</div>
          ${info.devCode && html`<div className="banner warn">Demo only: the code is ${info.devCode}</div>`}
          <label>Code<input inputMode="numeric" autoFocus maxLength="8" value=${code} onInput=${e => setCode(e.target.value.replace(/\D/g,'').slice(0,8))} style=${{fontSize:22,letterSpacing:'.4em',textAlign:'center'}}/></label>
          ${err && html`<span className="err">${err}</span>`}
          <div className="inline"><button type="button" className="btn ghost" onClick=${() => { setStep(1); setCode(''); setErr(''); }}>Change number</button><button className="btn primary" type="submit" style=${{marginLeft:'auto'}} disabled=${code.length < 4 || busy}>Log in</button></div>
        </form>`}
    </div></div>`;
}

/* ---------- Installation team form ---------- */
function TeamForm({erp, ops, toast, team, close}){
  const [f, setF] = useState(team ? {name:team.name, phone:team.phone || '', members:(team.members || []).join(', '), skills:team.skills || ITEM_TYPES.map(t => t.id)} : {name:'', phone:'', members:'', skills:ITEM_TYPES.map(t => t.id)});
  const d = digits10(f.phone), clash = erp.users.find(u => digits10(u.phone) === d && (!team || u.id !== team.id));
  const ok = f.name.trim() && d.length === 10 && !clash && f.skills.length;
  const save = async () => {
    const body = {name:f.name.trim(), phone:d, members:f.members.split(',').map(x => x.trim()).filter(Boolean), skills:f.skills};
    const r = team ? await ops.updTeam(team.id, body, `${body.name}'s team updated.`) : await ops.addTeam(body);
    if (r) close();
  };
  return html`<div className="modal" role="dialog" aria-modal="true" aria-label="Installation team"><div className="scrim" onClick=${close}></div>
    <div className="sheet"><header><h2>${team ? 'Edit installation team' : 'Add installation team'}</h2><p>The team lead logs in to the Installer app with this WhatsApp number. Helpers are listed for the record and site entry.</p></header>
      <div className="form">
        <label>Team lead name<input autoFocus value=${f.name} onInput=${e => setF({...f, name:e.target.value})} placeholder="e.g. Imran"/></label>
        <label>Lead's WhatsApp<input inputMode="tel" value=${f.phone} onInput=${e => setF({...f, phone:e.target.value})} placeholder="10-digit mobile"/>${clash && html`<span className="err">Already used by ${clash.name}.</span>`}</label>
        <label className="full">Helpers (comma separated)<input value=${f.members} onInput=${e => setF({...f, members:e.target.value})} placeholder="e.g. Raju, Mohan"/></label>
        <div className="full" style=${{display:'grid',gap:6}}><span style=${{fontSize:12,fontWeight:500,color:'var(--ink-2)'}}>Can install</span>
          <div className="chips" style=${{flexWrap:'wrap'}}>${ITEM_TYPES.map(t => html`<button type="button" key=${t.id} className="chip" aria-pressed=${f.skills.includes(t.id)} onClick=${() => setF({...f, skills:f.skills.includes(t.id) ? f.skills.filter(x => x !== t.id) : [...f.skills, t.id]})}>${t.name}</button>`)}</div></div>
        <div className="form-foot">${team && html`<button type="button" className="btn ghost" style=${{marginRight:'auto',color:'var(--crit)'}} onClick=${async () => { if (await ops.updTeam(team.id, {active:false}, `${team.name} deactivated. Their open items now show as Needs an installer.`)) close(); }}>Deactivate team</button>`}<button type="button" className="btn ghost" onClick=${close}>Cancel</button><button type="button" className="btn primary" disabled=${!ok} onClick=${save}>${team ? 'Save' : 'Add team and send invite'}</button></div>
      </div></div></div>`;
}

/* ---------- Users and access (admin) ---------- */
function UsersAdmin({erp, ops, toast}){
  const [tab, setTab] = useState('users');
  const [f, setF] = useState(null);
  const ok = f && f.name.trim() && f.phone.replace(/\D/g,'').length === 10;
  const counts = Object.fromEntries(ROLES.map(r => [r.id, erp.users.filter(u => u.role === r.id && u.active !== false).length]));
  return html`<section className="view"><div className="stack">
    <div className="seg" style=${{alignSelf:'start'}}>${[['users','Users'],['roles','Roles and access'],['audit','Change log'],['integrations','WhatsApp and Meta']].map(([id,n]) => html`<button key=${id} aria-pressed=${tab === id} onClick=${() => setTab(id)}>${n}</button>`)}</div>
    ${tab === 'users' && html`<div className="stack">
      <div className="inline"><span style=${{color:'var(--muted)'}}>${erp.users.filter(u => u.active !== false).length} active users. Staff sign in with their mobile number and a WhatsApp OTP; no passwords.</span><button className="btn primary small" style=${{marginLeft:'auto'}} onClick=${() => setF({name:'', phone:'', role:'installer', title:''})}><${Icon} n="plus" s=${14}/>Add user</button></div>
      ${f && html`<div className="box"><h4>New user</h4><div className="form" style=${{padding:0}}>
        <label>Name<input value=${f.name} onInput=${e => setF({...f, name:e.target.value})} autoFocus/></label>
        <label>WhatsApp number<input inputMode="tel" value=${f.phone} onInput=${e => setF({...f, phone:e.target.value})} placeholder="10-digit mobile"/></label>
        <label>Role<select value=${f.role} onChange=${e => setF({...f, role:e.target.value})}>${ROLES.map(r => html`<option key=${r.id} value=${r.id}>${r.name}</option>`)}</select></label>
        <label>Title (optional)<input value=${f.title} onInput=${e => setF({...f, title:e.target.value})} placeholder="e.g. Senior designer"/></label>
        <div className="form-foot"><button className="btn ghost" onClick=${() => setF(null)}>Cancel</button><button className="btn primary" disabled=${!ok} onClick=${async () => { if (await ops.addUser({name:f.name.trim(), phone:f.phone, role:f.role, title:f.title.trim()})) setF(null); }}>Add and send invite</button></div></div></div>`}
      <div className="table-wrap"><table>
        <thead><tr><th>User</th><th>WhatsApp</th><th>Role</th><th>Can open</th><th>Open tasks</th><th>Active</th></tr></thead>
        <tbody>${erp.users.map(u => { const self = u.id === erp.me || u.id === 'owner'; const perms = erp.roles[u.role] || {};
          return html`<tr key=${u.id} style=${{opacity:u.active === false ? .5 : 1}}><td><span className="inline" style=${{gap:8}}><${Av} id=${u.id}/><span><b>${u.name}</b><div className="sub">${u.title || ''}</div></span></span></td>
          <td className="num">${u.phone || '—'}</td>
          <td><select className="sel" value=${u.role} disabled=${self} onChange=${e => ops.updUser(u.id, {role:e.target.value}, `${u.name} is now ${roleById[e.target.value].name}.`)} aria-label=${'Role of ' + u.name}>${ROLES.map(r => html`<option key=${r.id} value=${r.id}>${r.name}</option>`)}</select></td>
          <td className="sub" style=${{maxWidth:260,whiteSpace:'normal'}}>${PERMS.filter(([k]) => perms[k]).map(p => p[1]).join(', ') || 'Own tasks only'}</td>
          <td className="num">${erp.tasks.filter(t => t.assignee === u.id && t.status !== 'done').length}</td>
          <td><button className="switch" role="switch" aria-checked=${u.active !== false} disabled=${self} aria-label=${'Active: ' + u.name} onClick=${() => { const on = u.active === false; ops.updUser(u.id, {active:on}, on ? `${u.name} reactivated.` : `${u.name} deactivated and logged out everywhere. Hand over their open tasks from the Team board.`); }}></button></td></tr>`; })}</tbody></table></div>
    </div>`}
    ${tab === 'roles' && html`<div className="stack">
      <p style=${{margin:0,color:'var(--muted)'}}>Tick what each role can open and do. Changes apply immediately to everyone with that role and are enforced by the server. Everyone can always see and update their own tasks.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Permission</th>${ROLES.map(r => html`<th key=${r.id} style=${{textAlign:'center',whiteSpace:'normal',minWidth:78}}>${r.name}<div className="sub" style=${{fontFamily:'var(--f-body)',letterSpacing:0,textTransform:'none',fontWeight:400}}>${counts[r.id]} user${counts[r.id] === 1 ? '' : 's'}</div></th>`)}</tr></thead>
        <tbody>${PERMS.map(([k, name, desc]) => html`<tr key=${k}><td><b>${name}</b><div className="sub">${desc}</div></td>
          ${ROLES.map(r => html`<td key=${r.id} style=${{textAlign:'center'}}><input type="checkbox" style=${{width:17,height:17,accentColor:'var(--accent)'}} checked=${!!erp.roles[r.id]?.[k]} disabled=${r.id === 'admin'} aria-label=${name + ' for ' + r.name}
            onChange=${() => ops.setPerm(r.id, k, !erp.roles[r.id]?.[k])}/></td>`)}</tr>`)}</tbody></table></div>
      <div className="inline"><button className="btn small ghost" onClick=${() => ops.resetRoles()}>Reset to defaults</button><span className="sub" style=${{fontSize:12,color:'var(--muted)'}}>Owner / Admin always has full access so nobody can be locked out.</span></div>
    </div>`}
    ${tab === 'audit' && html`<div className="panel"><h3>Change log</h3><p className="hint">Logins, user and access changes, payments, overrides and assignments, newest first.</p>
      <ol className="chain">${(erp.audit || []).map((a,i) => html`<li key=${i}><span>${a.text} <span className="sub" style=${{color:'var(--muted)'}}>· by ${uname(a.by)}</span></span><time>${fmtDT(a.t)}</time></li>`)}</ol>${!(erp.audit || []).length && html`<p className="hint">No changes yet.</p>`}</div>`}
    ${tab === 'integrations' && html`<${Integrations} toast=${toast}/>`}
  </div></section>`;
}
function Integrations({toast}){
  const [d, setD] = useState(null), [busy, setBusy] = useState(false), [res, setRes] = useState(null);
  useEffect(() => { API.call('GET', '/admin/integrations').then(setD).catch(e => toast(e.message)); }, []);
  if (!d) return html`<p className="hint">Loading…</p>`;
  const Row = ({k, v}) => html`<div><dt>${k}</dt><dd className="mono" style=${{fontSize:12.5,overflowWrap:'anywhere'}}>${v}</dd></div>`;
  return html`<div className="stack">
    <div className="panel"><h3>WhatsApp Cloud API</h3><p className="hint">${d.whatsapp.live ? 'Connected. Messages are sent through your WhatsApp Business number.' : 'Not connected yet: messages are simulated and logged, nothing is sent. Add the Meta values to the server settings to go live.'}</p>
      <dl className="kv"><${Row} k="Status" v=${d.whatsapp.live ? 'Live' : 'Simulated'}/><${Row} k="Phone number ID" v=${d.whatsapp.phoneNumberId || '—'}/><${Row} k="Webhook URL (paste in Meta)" v=${d.whatsapp.webhook}/><${Row} k="Graph API version" v=${d.graphVersion}/>
        <${Row} k="Sent (30 days)" v=${d.whatsapp.last30.sent}/><${Row} k="Simulated (30 days)" v=${d.whatsapp.last30.simulated}/><${Row} k="Failed (30 days)" v=${d.whatsapp.last30.failed}/></dl>
      <div className="inline" style=${{marginTop:12}}><button className="btn small" disabled=${!d.whatsapp.live || busy} onClick=${async () => { setBusy(true); try { setRes((await API.call('POST', '/admin/whatsapp/sync-templates')).results); } catch(e){ toast(e.message); } setBusy(false); }}>Submit message templates to Meta</button><span className="sub" style=${{fontSize:12,color:'var(--muted)'}}>Creates every template this app uses (OTP, reminders, updates) for Meta approval.</span></div>
      ${res && html`<table style=${{marginTop:10,minWidth:0}}><tbody>${res.map(r => html`<tr key=${r.name}><td className="mono">${r.name}</td><td>${r.status}</td></tr>`)}</tbody></table>`}
    </div>
    <div className="panel"><h3>Meta Lead Ads</h3><p className="hint">${d.metaLeads.live ? 'Connected. New Facebook and Instagram lead-form leads arrive in the CRM within seconds, with a 15-minute safety-net sync.' : 'Not connected yet. Add the Page ID and Page access token to the server settings.'}</p>
      <dl className="kv"><${Row} k="Status" v=${d.metaLeads.live ? 'Live' : 'Not connected'}/><${Row} k="Page ID" v=${d.metaLeads.pageId || '—'}/><${Row} k="Webhook URL (paste in Meta)" v=${d.metaLeads.webhook}/><${Row} k="Leads received" v=${d.metaLeads.received.n}/></dl></div>
    <div className="panel"><h3>Background jobs</h3><dl className="kv"><${Row} k="Waiting" v=${d.jobs.pending}/><${Row} k="Failed after retries" v=${d.jobs.dead}/></dl></div>
  </div>`;
}

/* ---------- Customer app: live portal (/c) and staff preview ---------- */
function CustomerApp({erp, toast: toastIn, live}){
  const [state, setState] = useState(null), [pid, setPid] = useState(null), [sheet, setSheet] = useState(null), [view, setView] = useState('home'), [toasts, setToasts] = useState([]);
  const toast = toastIn || (text => { const id = Math.random(); setToasts(t => [...t, {id, text}]); setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200); });
  const load = async projectId => { try { const r = await API.call('GET', '/customer/state' + (projectId ? '?projectId=' + projectId : '')); setState(r.state); setPid(projectId || r.state.projects[0]?.id || null); } catch(e){ toast(e.message); } };
  const act = async (path, body, msg) => { try { const r = await API.call('POST', path, body); setState(r.state); if (msg) toast(msg); return true; } catch(e){ toast(e.message); return false; } };
  const [authed, setAuthed] = useState(!live);
  useEffect(() => { if (live){ API.setAudience('customer'); API.refresh().then(ok => { if (ok){ setAuthed(true); load(); } }); } }, []);
  const steps = ['Customer logs in with the WhatsApp number on their order; OTP on WhatsApp.','Home shows progress, the next visit and anything waiting for them.','Approve drawings or ask for a change; the designer gets a task.','See payment milestones and installation dates with the team name.','Raise a complaint (goes to the PM as an urgent task) and rate the work after handover.'];
  let screen;
  if (live && !authed) return html`<${LoginScreen} audience="customer" title="Customer login" onLogin=${async () => { setAuthed(true); await load(); }}/>`;
  if (!live && !pid) screen = html`<${Phone} title="Customer app preview" sub="Pick a customer to see their app">${erp.projects.map(x => html`<button key=${x.id} className="mcard" onClick=${() => load(x.id)}><b>${x.customer}</b><span className="meta">${x.code} · ${x.phone}</span></button>`)}<span className="meta" style=${{fontSize:12}}>Customers use their own login at ${location.origin}/c</span><//>`;
  else if (!state || !pid) screen = html`<${Phone} title="Make My Space" sub="Loading…"><p className="meta">Loading your project…</p><//>`;
  else {
    const p = state.projects.find(x => x.id === pid) || state.projects[0];
    const its = state.items.filter(i => i.projectId === p.id), done = its.filter(i => PIDX(i.stage) >= PIDX('handover')).length;
    const staffBy = id => state.staff.find(s => s.id === id) || {};
    const toApprove = its.filter(i => i.stage === 'drawing' && i.drawings.length && !latestDrawing(i).approved);
    const nextInst = its.filter(i => !i.installDone && i.installer && PIDX(i.stage) >= PIDX('dispatch')).sort((a,b) => a.target < b.target ? -1 : 1)[0];
    const due = p.payments.filter(m => !m.received);
    const out = async () => { if (live){ try { await API.call('POST', '/auth/logout'); } catch(e){} setAuthed(false); setState(null); } else { setPid(null); setState(null); } };
    const back = view !== 'home' ? () => setView('home') : null;
    if (view === 'home') screen = html`<${Phone} title=${'Hello ' + first(p.customer)} sub=${p.code + ' · ' + p.address} right=${html`<button className="btn small" style=${{background:'var(--rail-2)',color:'var(--rail-ink)',border:0}} onClick=${out}>${live ? 'Log out' : 'Close'}</button>`}>
      ${state.projects.length > 1 && html`<select className="sel" value=${p.id} onChange=${e => setPid(e.target.value)}>${state.projects.map(x => html`<option key=${x.id} value=${x.id}>${x.code} · ${x.address}</option>`)}</select>`}
      <div className="mcard"><div className="card-row"><b>Your project</b><span className="meta">Target ${fmtDate(p.target)}</span></div>
        ${its.length ? html`<${StageBar} items=${its}/><span className="meta">${done} of ${its.length} pieces installed</span>` : html`<span className="meta">${p.survey.status === 'submitted' ? 'Design in progress' : 'Site measurement ' + (p.survey.scheduled ? fmtDT(p.survey.scheduled) : 'to be scheduled')}</span>`}</div>
      ${toApprove.length > 0 && html`<button className="mcard" style=${{borderColor:'var(--accent)'}} onClick=${() => setView('approve')}><div className="card-row"><b>${toApprove.length} drawing${toApprove.length > 1 ? 's' : ''} waiting for your approval</b><span className="pill acc">Action</span></div><span className="meta">Tap to review and approve</span></button>`}
      ${nextInst && html`<div className="mcard"><b>Next installation</b><span>${typeById[nextInst.type].name} in ${nextInst.roomName} · ${fmtDate(nextInst.target)}</span><span className="meta">Team ${staffBy(nextInst.installer).name || ''} · ${staffBy(nextInst.installer).phone || ''}</span></div>`}
      <button className="mcard" onClick=${() => setView('items')}><div className="card-row"><b>Your furniture</b><span className="meta">${its.length} pieces ›</span></div></button>
      <button className="mcard" onClick=${() => setView('pay')}><div className="card-row"><b>Payments</b><span className="meta">${due.length ? due.length + ' pending ›' : 'All paid ›'}</span></div></button>
      <div className="inline"><button className="big" onClick=${() => setSheet({n:'complaint', text:''})}>Raise a complaint</button>${its.length && its.every(i => i.stage === 'closed') && !p.feedback ? html`<button className="big pri" onClick=${() => setSheet({n:'rate', r:5, text:''})}>Rate us</button>` : null}</div>
      ${p.feedback && html`<div className="banner good">Thank you for rating us ${p.feedback.rating}/5.</div>`}
      <span className="meta" style=${{fontSize:12,color:'var(--muted)'}}>Project manager: ${staffBy(p.pm).name || ''} · ${staffBy(p.pm).phone || ''}</span>
    <//>`;
    else if (view === 'items') screen = html`<${Phone} title="Your furniture" sub=${p.customer} back=${back}>${its.map(i => html`<div key=${i.id} className="mcard"><div className="card-row"><b>${typeById[i.type].name}</b><span className=${'pill ' + (PIDX(i.stage) >= PIDX('handover') ? 'good' : '')}>${i.customerStage || CUST_STAGE[i.stage]}</span></div><span className="meta">${i.roomName}${i.desc ? ' · ' + i.desc : ''}</span></div>`)}${!its.length && html`<p className="meta">Pieces appear here after the site measurement.</p>`}<//>`;
    else if (view === 'pay') screen = html`<${Phone} title="Payments" sub=${p.customer} back=${back}>${p.payments.map(m => html`<div key=${m.id} className="mcard"><div className="card-row"><b>${m.label}</b><span className=${'pill ' + (m.received ? 'good' : 'warn')}>${m.received ? 'Received' : 'Pending'}</span></div><span className="meta">${inr(m.amount)} · ${m.pct}%</span></div>`)}<span className="meta" style=${{fontSize:12}}>For payment details, please contact ${staffBy(p.pm).name || 'your project manager'}.</span><//>`;
    else if (view === 'approve') screen = html`<${Phone} title="Approve drawings" sub=${p.customer} back=${back}>
      ${toApprove.map(i => { const wall = p.survey.rooms.find(r => r.code === i.room)?.walls.find(w => w.label === i.wall); return html`<div key=${i.id} className="mcard"><b>${typeById[i.type].name} · ${i.roomName}</b><span className="meta">Drawing ${latestDrawing(i).rev}${i.desc ? ' · ' + i.desc : ''}</span>${latestDrawing(i).url ? html`<a className="btn small" href=${latestDrawing(i).url} target="_blank" rel="noopener">Open drawing PDF</a>` : html`<${Elevation} it=${i} wall=${wall}/>`}
        <div className="inline"><button className="big" onClick=${() => setSheet({n:'change', id:i.id, text:''})}>Ask for a change</button><button className="big go" onClick=${() => act(`/customer/items/${i.id}/approve`, {}, 'Approved. Your designer has been notified.')}>Approve</button></div></div>`; })}
      ${!toApprove.length && html`<div className="banner good">Nothing waiting for approval.</div>`}<//>`;
    if (sheet){
      const close = () => setSheet(null);
      const wrap = inner => html`<div className="sheet-m" onClick=${e => e.target === e.currentTarget && close()}><div className="in">${inner}</div></div>`;
      let overlay = null;
      if (sheet.n === 'change') overlay = wrap(html`<h3>What should change?</h3><textarea className="inp" rows="3" value=${sheet.text} onInput=${e => setSheet({...sheet, text:e.target.value})} placeholder="e.g. Please add 2 more drawers on the left"></textarea><div className="inline"><button className="big" onClick=${close}>Cancel</button><button className="big pri" disabled=${sheet.text.trim().length < 2} onClick=${async () => { if (await act(`/customer/items/${sheet.id}/change-request`, {note:sheet.text.trim()}, 'Sent to your designer. The revised drawing will come on WhatsApp.')) close(); }}>Send to designer</button></div>`);
      if (sheet.n === 'complaint') overlay = wrap(html`<h3>Raise a complaint</h3><textarea className="inp" rows="3" value=${sheet.text} onInput=${e => setSheet({...sheet, text:e.target.value})} placeholder="Tell us what went wrong"></textarea><div className="inline"><button className="big" onClick=${close}>Cancel</button><button className="big pri" disabled=${sheet.text.trim().length < 2} onClick=${async () => { if (await act(`/customer/projects/${p.id}/complaint`, {text:sheet.text.trim()}, 'Complaint sent. Your project manager will call you within a day.')) close(); }}>Send</button></div>`);
      if (sheet.n === 'rate') overlay = wrap(html`<h3>How did we do?</h3><div className="inline" style=${{justifyContent:'center'}}>${[1,2,3,4,5].map(r => html`<button key=${r} className=${'btn' + (sheet.r >= r ? ' primary' : '')} onClick=${() => setSheet({...sheet, r})}>${r} ★</button>`)}</div><textarea className="inp" rows="2" value=${sheet.text} onInput=${e => setSheet({...sheet, text:e.target.value})} placeholder="Anything to add? (optional)"></textarea><button className="big pri" onClick=${async () => { if (await act(`/customer/projects/${p.id}/feedback`, {rating:sheet.r, comment:sheet.text.trim()}, 'Thank you for your feedback!')) close(); }}>Submit</button>`);
      screen = React.cloneElement(screen, {overlay});
    }
  }
  if (live) return html`<div style=${{minHeight:'100%',display:'grid',placeItems:'start center',padding:'12px 0',background:'var(--bg)'}}>${screen}<div className="toasts" role="status" aria-live="polite">${toasts.map(t => html`<div className="toast" key=${t.id}><${Icon} n="check" s=${16}/><span>${t.text}</span></div>`)}</div></div>`;
  return html`<section className="view"><div className="phone-wrap">${screen}<${SideNote} title="Customer app flow" steps=${steps}/></div></section>`;
}
