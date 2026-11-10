import {createRequestSession, quantities, canClear} from './client.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mounts = new WeakMap();
const kinds = ['dirty','fault','maintenance','unknown'];
const label = value => esc(value ?? 'Unknown');
export function mountRequests(root, {api, permissions = [], role = null, equipment = [], equipmentTypes = []}) {
  mounts.get(root)?.dispose();
  let drafts = {}, draftRequest = null, disposed = false;
  const writable = () => permissions.includes('equipment:write');
  const remember = () => { for (const el of root.querySelectorAll('[data-draft]')) drafts[`${draftRequest ?? "new"}:${el.dataset.draft}`] = el.type === 'checkbox' ? el.checked : el.value; };
  const field = (name, title, type='text', extra='') => `<label>${title}<input data-draft="${name}" name="${name}" type="${type}" ${extra}></label>`;
  const button = (text, attrs = '', disabled = false) => `<button type="button" ${attrs} ${disabled?'disabled':''}>${text}</button>`;
  const session = createRequestSession({api, onChange:render});
  function render(state) {
    if (disposed) return;
    const nextRequest = state.request?.id ?? state.requestId ?? null;
    if (state.phase === 'denied' || nextRequest !== draftRequest) drafts = {}; else remember();
    draftRequest = nextRequest;
    const focus = root.ownerDocument.activeElement;
    const focusKey = focus && root.contains(focus) ? focus.getAttribute('data-focus') || focus.getAttribute('data-draft') : null;
    const locked = state.busy || state.uncertain || !writable() || !['ready','success'].includes(state.phase);
    const request = state.request;
    root.classList.add('sv-requests');
    root.innerHTML = `<header><p class="eyebrow">Supply Vanguard / Coordination</p><h1>Requests &amp; returns</h1><p>Track each item from reservation to safe return. Location is not changed by these actions.</p><p class="notice">Task-local module. Shared-app integration is not yet verified.</p></header>
      <div class="status" tabindex="-1" data-status data-focus="status" role="${state.error?'alert':'status'}" aria-live="polite">${state.busy?'Saving. Please wait.':state.phase === 'loading'?'Loading authorized records…':state.phase==='denied'?'Access unavailable. Reconnect through the host application.':state.phase==='conflict'?'Conflict: latest server record loaded. Review before a new action.':state.error?label(state.error.message):state.phase==='success'?'Saved and refreshed from the server.':'Server records; no inferred availability.'}</div>
      ${state.uncertain?`<aside class="notice">The previous write may have committed. ${state.retryable?'Retry sends the exact original command.':'Do not repeat this action: reconcile the server records first.'}${state.retryable?button('Retry exact command','data-command="retry" data-focus="retry"',state.busy):''}${button('I have reconciled the result; refresh','data-command="reconcile" data-focus="reconcile"',state.busy)}</aside>`:''}
      <nav aria-label="Request navigation">${button('Refresh','data-command="refresh" data-focus="refresh"',state.busy)}<label>Open request<select data-open data-focus="request-select" ${state.busy?'disabled':''}><option value="">Choose a request</option>${state.requests.map(r=>`<option value="${esc(r.id)}" ${r.id===request?.id?'selected':''}>${esc(r.id)}</option>`).join('')}</select></label></nav>
      ${state.phase==='denied'?'':`<section class="create"><h2>Create a request</h2><form data-create><label>Equipment types, one per demand line<textarea name="types" data-draft="types" required placeholder="One equipment type per line" ${!writable()?'disabled':''}></textarea></label><p>1–20 lines. Repeat a type for multiple items. Supported types: ${equipmentTypes.length?equipmentTypes.map(esc).join(', '):'provided by your organization; server validates each type'}.</p>${field('note','Operational note (no patient information)','text','maxlength="500"')}<button data-focus="create" ${locked?'disabled':''}>Create request</button></form></section>`}
      ${!request?`<p>${state.phase==='loading'?'Loading…':state.requests.length?'Choose a request to inspect its lines.':'No request records loaded.'}</p>`:`<section aria-label="Request quantities"><h2>Request ${esc(request.id)}</h2><dl class="quantities">${Object.entries(quantities(request.items)).map(([k,v])=>`<div><dt>${esc(k.replace(/([A-Z])/g,' $1'))}</dt><dd>${v}</dd></div>`).join('')}</dl><p>Delivered is cumulative; returns and missing items do not erase delivery. Demand cancellation does not prove return or availability.</p></section><div class="items">${request.items.map(item=>{
        const active = item.assignments.filter(a=>a.active), held = item.holds.some(h=>h.active);
        return `<article><h2>Line ${item.lineNo}: ${esc(item.equipmentType)}</h2><p class="badge">${label(item.state)}${item.demandCancelled?' · Demand cancelled':''}</p><p>${active.length?'Assignment retained: '+active.map(a=>esc(a.equipmentId)).join(', '):'No active assignment recorded.'} ${held?'Blocked by active holds.':'Availability must be verified from authorized inventory.'}</p>
        <p>Dispatched: ${label(item.dispatchedAt)} · Received: ${label(item.receivedAt)} · Returned: ${label(item.returnedAt)}</p>
        ${item.state==='open'?`<form data-claim="${item.lineNo}"><label>Assign serialized equipment<select name="equipment" data-draft="equipment-${item.lineNo}" required><option value="">Choose equipment</option>${equipment.filter(e=>e.modelKind===item.equipmentType).map(e=>`<option value="${esc(e.id)}">${esc(e.id)} · ${esc(e.status)} · version ${e.version}</option>`).join('')}</select></label><p>Server rechecks readiness, holds and competing assignments. Listed status alone is not availability.</p><button data-focus="assign-${item.lineNo}" ${locked?'disabled':''}>Assign line ${item.lineNo}</button></form>`:''}
        <div class="actions">${['dispatch','receive','fail','missing','cancel'].map(action=>button(action==='cancel'?'Cancel demand':action[0].toUpperCase()+action.slice(1),`data-action="${action}" data-line="${item.lineNo}" data-focus="${action}-${item.lineNo}"`,locked)).join('')}</div>
        ${!item.dispatchedAt?field(`transit-${item.lineNo}`,'I confirmed this item is not in transit (required before cancellation)','checkbox'):''}
        <form data-return="${item.lineNo}"><label>Return condition<select name="condition" data-draft="condition-${item.lineNo}" required><option value="">Choose observed condition</option>${['clean',...kinds].map(k=>`<option>${k}</option>`).join('')}</select></label><button data-focus="return-${item.lineNo}" ${locked?'disabled':''}>Record return</button></form>
        <h3>Independent holds</h3><ul>${item.holds.map(h=>`<li><strong>${esc(h.kind.toUpperCase())}</strong> ${h.active?'Active':'Cleared'} · placed ${label(h.placedAt)} by ${label(h.placedBy)}${h.active?'':` · cleared ${label(h.clearedAt)} by ${label(h.clearedBy)}`}${h.reason?` · reason: ${esc(h.reason)}`:''} ${h.active?button('Clear '+esc(h.kind),`data-clear="${esc(h.id)}" data-focus="clear-${esc(h.id)}"`,state.busy||state.uncertain||!canClear(h,role,state.rules)||!['ready','success'].includes(state.phase)):''}</li>`).join('')||'<li>No holds recorded.</li>'}</ul>
        <p>Clearance follows configured role rules; no rule means no clearance. Server records actor and time. Existing placement reason is not new clearance evidence.</p>
        ${active.map(a=>`<form data-hold="${esc(a.equipmentId)}"><label>Place hold<select name="kind" required><option value="">Choose hold</option>${kinds.map(k=>`<option>${k}</option>`).join('')}</select></label><label>Reason<input name="reason" data-draft="reason-${item.lineNo}" maxlength="500"></label><button data-focus="hold-${item.lineNo}" ${locked?'disabled':''}>Place independent hold</button></form>`).join('')}
        <details><summary>Assignment and lifecycle history</summary><ul>${item.assignments.map(a=>`<li>${esc(a.equipmentId)}: ${a.active?'active':'released'}; ${label(a.assignedAt)} by ${label(a.assignedBy)}; release ${label(a.releasedAt)}</li>`).join('')}${item.history.map(h=>`<li>${label(h.kind)} · ${label(h.recordedAt)} · ${label(h.actor)}<pre>${esc(JSON.stringify(h.detail,null,2))}</pre></li>`).join('')}</ul></details></article>`;
      }).join('')}</div>`}`;
    for (const el of root.querySelectorAll('[data-draft]')) if (Object.hasOwn(drafts,`${draftRequest ?? "new"}:${el.dataset.draft}`)) { if(el.type==='checkbox') el.checked=drafts[`${draftRequest ?? "new"}:${el.dataset.draft}`]; else el.value=drafts[`${draftRequest ?? "new"}:${el.dataset.draft}`]; }
    if (focusKey) { const next=[...root.querySelectorAll('[data-focus], [data-draft]')].find(el=>(el.dataset.focus||el.dataset.draft)===focusKey); if(next&&!next.disabled) next.focus(); else root.querySelector('[data-status]')?.focus(); }
  }
  const report = error => { const status=root.querySelector('[data-status]'); if(status){status.textContent=error.message;status.setAttribute('role','alert');status.focus();} };
  const run = fn => { try { Promise.resolve(fn()).catch(report); } catch(error){report(error);} };
  const click = event => {
    const b=event.target.closest('button'); if(!b||!root.contains(b)||b.disabled)return;
    const item=session.state.request?.items.find(i=>String(i.lineNo)===b.dataset.line);
    if(b.dataset.action) run(()=>session.transition(session.state.request.id,item,b.dataset.action,{confirmedNotInTransit:root.querySelector(`[name="transit-${item.lineNo}"]`)?.checked}));
    if(b.dataset.clear) run(()=>session.clear(b.dataset.clear));
    if(b.dataset.command==='refresh')run(()=>session.load(session.state.request?.id));
    if(b.dataset.command==='retry')run(()=>session.retry());
    if(b.dataset.command==='reconcile')run(()=>session.reconcile());
  };
  const change=event=>{if(event.target.matches('[data-open]')){const id=event.target.value;drafts={};root.replaceChildren();run(()=>session.load(id||undefined));}};
  const submit=event=>{event.preventDefault();const form=event.target;const data=new FormData(form);remember();
    if(form.matches('[data-create]'))run(()=>{const types=String(data.get('types')).split('\n').map(s=>s.trim()).filter(Boolean);if(!types.length||types.length>20)throw Error('Use between 1 and 20 demand lines.');return session.create({items:types.map(equipmentType=>({equipmentType})),note:String(data.get('note')||'')});});
    if(form.dataset.claim)run(()=>{const eq=equipment.find(e=>e.id===data.get('equipment'));if(!eq)throw Error('Choose a current equipment record.');return session.claim(session.state.request.id,Number(form.dataset.claim),{equipmentId:eq.id,expectedVersion:eq.version});});
    if(form.dataset.return)run(()=>session.transition(session.state.request.id,session.state.request.items.find(i=>String(i.lineNo)===form.dataset.return),'return',{condition:data.get('condition')}));
    if(form.dataset.hold)run(()=>session.place(form.dataset.hold,{kind:data.get('kind'),reason:data.get('reason')}));
  };
  root.addEventListener('click',click);root.addEventListener('change',change);root.addEventListener('submit',submit);
  render(session.state); session.load();
  const handle={session,resetAccess(next={}){drafts={};permissions=next.permissions||[];role=next.role||null;equipment=next.equipment||[];equipmentTypes=next.equipmentTypes||[];root.replaceChildren();session.reset();root.replaceChildren();},dispose(){disposed=true;drafts={};session.dispose();root.removeEventListener('click',click);root.removeEventListener('change',change);root.removeEventListener('submit',submit);root.replaceChildren();mounts.delete(root);}};
  mounts.set(root,handle);return handle;
}
