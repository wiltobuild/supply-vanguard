// Host supplies a same-origin authorized API; no browser persistence, clinical policy, or role selector.
export function mountMaintenance(root,{api,keyFactory=()=>crypto.randomUUID()}){
 const doc=root.ownerDocument;
 root.innerHTML=`<section aria-labelledby="service-heading"><h2 id="service-heading">Equipment service</h2>
 <p>Service entries preserve unavailable status. Readiness clearance needs the separate hold policy.</p>
 <form data-search><label>View<select name="view"><option value="cleaning">Cleaning</option><option value="maintenance">Maintenance</option><option value="ready">Available and unassigned</option><option value="all">All equipment</option></select></label>
 <label>Search name or asset ID<input name="q" type="search" maxlength="100"></label><button>Search</button></form>
 <p data-message role="status" aria-live="polite"></p><button type="button" data-refresh>Refresh current state</button>
 <label>Equipment<select data-items><option value="">Load equipment</option></select></label><button type="button" data-more hidden>More equipment</button>
 <p data-detail></p><form data-service><label>Service action<select name="action"></select></label>
 <label>Service note (no patient information)<textarea name="note" maxlength="500" rows="4"></textarea></label>
 <p data-version></p><button data-save>Save service entry</button></form>
 <button type="button" data-rebase>Use current version for reviewed draft</button><button type="button" data-retry hidden>Retry identical command</button>
 <section aria-labelledby="history-heading"><h3 id="history-heading">Administrative service history</h3>
 <p>Recorded status and note changes. History access requires the existing audit permission.</p><button type="button" data-history>Load history</button><ol data-events></ol><p data-history-message role="status"></p><button type="button" data-history-more hidden>More history</button></section></section>`;
 const el=s=>root.querySelector(s),search=el('[data-search]'),form=el('[data-service]'),select=el('[data-items]'),action=form.elements.action,note=form.elements.note;
 const surface=root.firstElementChild;
 let items=[],selected='',cursor=null,historyCursor=null,busy=false,pending=null,needsRefresh=true,closed=false,historyGeneration=0,lifecycle=0,readGeneration=0;
 // A remount can replace this root before the old host calls close. Never touch its new identity's DOM.
 const current=(epoch=lifecycle)=>!closed&&epoch===lifecycle&&root.firstElementChild===surface;
 const drafts=new Map(),listeners=[];
 const on=(node,event,fn)=>{node.addEventListener(event,fn);listeners.push(()=>node.removeEventListener(event,fn));};
 const message=text=>{if(current())el('[data-message]').textContent=text;};
 function controls(){
  if(!current())return;
  for(const node of [...search.elements,select,el('[data-refresh]'),el('[data-more]')])node.disabled=busy;
  const unavailable=busy||!!pending||needsRefresh||!items.find(i=>i.id===selected)||!action.options.length;
  for(const node of form.elements)node.disabled=unavailable;
  el('[data-retry]').hidden=!pending;el('[data-retry]').disabled=busy;
  el('[data-retry]').textContent=pending?`Retry identical command for ${pending.id}`:'Retry identical command';
  el('[data-rebase]').disabled=unavailable;
 }
 function detail(){
  if(!current())return;
  const item=items.find(i=>i.id===selected),draft=drafts.get(selected);
  action.replaceChildren();
  const actions=item&&['available','in-use'].includes(item.status)?[['start-cleaning','Start cleaning'],['start-maintenance','Start maintenance']]:item&&['cleaning','maintenance'].includes(item.status)?[['record-service','Record service step; keep unavailable']]:[];
  for(const [value,label] of actions){const option=doc.createElement('option');option.value=value;option.textContent=label;action.append(option);}
  if(draft&&actions.some(([a])=>a===draft.action))action.value=draft.action;
  note.value=draft?.note??'';
  el('[data-detail]').textContent=item?`${item.id} · ${item.status} · Location: ${item.locationId}. Last physically verified: ${item.lastVerified?.observedAt??'Not yet verified'} (${item.lastVerified?.source??'unknown source'}). ${item.provenance}`:'No matching equipment.';
  el('[data-version]').textContent=item?`Current version ${item.version}${draft?`; draft based on version ${draft.expectedVersion}`:''}.`:'';
  controls();
 }
 function remember(){const item=items.find(i=>i.id===selected);if(item){const old=drafts.get(selected);drafts.set(selected,{action:action.value,note:note.value,expectedVersion:old?.expectedVersion??item.version});}}
 function clearHistory(){historyGeneration++;historyCursor=null;if(!current())return;el('[data-events]').replaceChildren();el('[data-history-message]').textContent='';el('[data-history-more]').hidden=true;}
 function discardAccess(error){
  if(!current())return;
  // Expiry, inventory denial or rejected write invalidates all cached identity-sensitive state and older work.
  lifecycle++;readGeneration++;items=[];selected='';cursor=null;drafts.clear();pending=null;busy=false;needsRefresh=true;
  select.replaceChildren();el('[data-more]').hidden=true;clearHistory();detail();message(error.message);
 }
 async function refresh({more=false}={}){
  if(busy||!current())return;const epoch=lifecycle,gen=++readGeneration,valid=()=>current(epoch)&&gen===readGeneration;busy=true;controls();message('Loading authoritative equipment…');
  try{
   const page=await api.list({view:search.elements.view.value,q:search.elements.q.value,cursor:more?cursor:null});if(!valid())return;
   items=more?[...items,...page.items]:page.items;cursor=page.nextCursor;
   select.replaceChildren();for(const item of items){const opt=doc.createElement('option');opt.value=item.id;opt.textContent=`${item.id} — ${item.name} (${item.status})`;select.append(opt);}
   if(!items.some(i=>i.id===selected)){selected=items[0]?.id??'';clearHistory();}select.value=selected;
   el('[data-more]').hidden=!cursor;needsRefresh=false;detail();message(`${items.length} loaded.${pending?' Uncertain command retained; retry uses its original version and key.':''}`);
  }catch(error){if(!valid())return;needsRefresh=true;if([401,403].includes(error.status))discardAccess(error);else message(error.message);}
  finally{if(valid()){busy=false;controls();}}
 }
 async function save(retry=false){
  if(busy||!current())return;const epoch=lifecycle;
  if(!retry){if(pending||needsRefresh)return;remember();const draft=drafts.get(selected);if(!draft||!action.options.length)return;pending={id:selected,body:{...draft},key:keyFactory()};}
  if(!pending)return;const command=pending;busy=true;controls();message('Saving service entry…');
  let accepted=false,noChange=false;
  try{const result=await api.service(command.id,command.body,command.key);if(!current(epoch))return;accepted=true;noChange=result.changed===false&&!result.replayed;drafts.delete(command.id);pending=null;needsRefresh=true;clearHistory();message('Service entry accepted; refreshing current state.');}
  catch(error){if(!current(epoch))return;if([401,403].includes(error.status))discardAccess(error);else{if(!error.uncertain)pending=null;needsRefresh=true;message(error.message);}}
  finally{if(current(epoch)){busy=false;controls();}}
  if(accepted&&current(epoch)){await refresh();if(current(epoch)&&!needsRefresh)message(noChange?'No change: this note already matches. Current state refreshed.':'Service entry saved. Current state refreshed; unavailable status is preserved.');}
 }
 async function history(more=false){
  if(!selected||!current())return;const epoch=lifecycle,id=selected,gen=++historyGeneration,valid=()=>current(epoch)&&gen===historyGeneration&&id===selected;el('[data-history-message]').textContent='Loading history…';
  try{const page=await api.history(id,more?historyCursor:null);if(!valid())return;
   if(!more)el('[data-events]').replaceChildren();for(const event of page.items){const li=doc.createElement('li');li.textContent=`${event.at} · ${event.actor} · ${event.before?.status??'unknown'} → ${event.after?.status??'unknown'} · ${event.after?.note??'No note'}`;el('[data-events]').append(li);}
   historyCursor=page.nextCursor;el('[data-history-more]').hidden=!historyCursor;el('[data-history-message]').textContent=page.items.length?'History loaded.':'No recorded changes.';
  }catch(error){if(!valid())return;if(error.status===401)discardAccess(error);else{if(error.status===403)clearHistory();el('[data-history-message]').textContent=error.message;}}
 }
 on(search,'submit',e=>{e.preventDefault();void refresh();});on(select,'change',()=>{selected=select.value;clearHistory();detail();});
 on(note,'input',remember);on(action,'change',remember);on(form,'submit',e=>{e.preventDefault();void save();});
 on(el('[data-refresh]'),'click',()=>void refresh());on(el('[data-more]'),'click',()=>void refresh({more:true}));on(el('[data-retry]'),'click',()=>void save(true));
 on(el('[data-rebase]'),'click',()=>{const item=items.find(i=>i.id===selected);if(item&&!busy&&!pending&&!needsRefresh){drafts.set(selected,{action:action.value,note:note.value,expectedVersion:item.version});detail();message('Draft retained using the reviewed current version. Save explicitly to submit.');}});
 on(el('[data-history]'),'click',()=>void history());on(el('[data-history-more]'),'click',()=>void history(true));
 controls();void refresh();
 return {refresh,close(){const ownsRoot=current();closed=true;lifecycle++;readGeneration++;historyGeneration++;listeners.forEach(remove=>remove());drafts.clear();pending=null;items=[];selected='';cursor=null;historyCursor=null;note.value='';select.replaceChildren();action.replaceChildren();surface.replaceChildren();if(ownsRoot)root.replaceChildren();}};
}
