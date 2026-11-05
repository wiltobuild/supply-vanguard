import {STATUSES,isStale} from '/packages/domain/equipment.js';
import {roomIds} from '/packages/domain/seed.js';
import {presentEquipment,filterEquipment,describeFreshness,nextToReview,summarize,latestUpdate,webglAvailable} from '/src/lib.js';
import {createEquipmentApi,createEquipmentSession} from '/src/equipment-api.js';
import {createEquipmentPolling} from '/src/equipment-polling.js';
import {updateEquipmentFreshness} from '/src/equipment-freshness.js';
// All text from state or storage is added as text nodes by h(); no markup is ever built from data.
const h=(tag,attrs={},...kids)=>{const el=document.createElement(tag);for(const [k,v] of Object.entries(attrs)){if(v===false||v===null||v===undefined)continue;if(k==='class')el.className=v;else if(k.startsWith('on'))el.addEventListener(k.slice(2),v);else el.setAttribute(k,v===true?'':v);}for(const kid of kids.flat())if(kid!==null&&kid!==undefined&&kid!==false)el.append(kid.nodeType?kid:document.createTextNode(String(kid)));return el;};
const main=document.getElementById('main'),view=document.getElementById('view');
let items=[],events=[],notice=null,selected=null,query='',statusFilter='all',savedMessage='',formError=null,draft=null,session=null,connection={phase:'idle',busy:false};
let ward={state:'idle',frame:null,timer:null};
function connected(state){
 const busyChanged=connection.busy!==state.busy;
 const changed=JSON.stringify(state.items)!==JSON.stringify(items.map(({roomId,lastSeenAt,source,...record})=>record));
 connection=state;items=state.items.map(presentEquipment);syncScene();
 // Polls must never replace a focused field or throw away a draft.
 if(document.activeElement?.matches('input, select, textarea')&&!state.busy&&!busyChanged){
  document.querySelectorAll('#equipment-form select, #equipment-form textarea, #equipment-form button[type="submit"], #location-form select, #location-form button[type="submit"]').forEach(el=>{el.disabled=state.phase!=='ready'||state.needsRefresh||!navigator.onLine;});
  renderList();renderConnection();return;
 }
 if(changed||state.phase!=='ready'||state.busy||busyChanged)render();else renderConnection();
}
function connect(org,token){
 let api;try{api=createEquipmentApi({organizationId:org,token});}catch(error){connection={phase:'idle',busy:false,error};renderConnection();return;}
 session?.close();items=[];events=[];selected=null;draft=null;formError=null;
 session=createEquipmentSession(api,{onChange:connected});refresh();}
function refresh(){return session?.refresh().catch(()=>{});}
function disconnect(){session?.close();session=null;connection={phase:'idle',busy:false};items=[];events=[];selected=null;draft=null;syncScene();render();}
function connectionPanel(){
 if(!session)return h('section',{class:'connection','aria-labelledby':'connect-h'},h('h2',{id:'connect-h'},'Connect to equipment'),connection.error?h('p',{role:'alert'},connection.error.message):null,h('p',{},'Use an existing authorized session and organization. Local demo identities must be synthetic. Session tokens stay in this tab’s memory and disappear on reload.'),h('form',{onsubmit:e=>{e.preventDefault();const f=e.currentTarget;const org=f.elements.organization.value,token=f.elements.token.value;f.reset();connect(org,token);}},h('label',{},'Organization ID',h('input',{name:'organization',required:true,autocomplete:'off'})),h('label',{},'Session token',h('input',{name:'token',type:'password',required:true,autocomplete:'off'})),h('button',{type:'submit',class:'primary'},'Connect')));
 return h('section',{class:'connection','aria-label':'Equipment connection'},h('p',{role:connection.error?'alert':'status'},connection.error?.message||(connection.phase==='loading'?'Refreshing shared equipment…':connection.phase==='ready'?'Connected. Shared equipment refreshes every 5 seconds.':'Refresh to load shared equipment.')),connection.items?.length&&connection.phase!=='ready'?h('p',{},'Showing the last successful response. It may be out of date.'):null,h('div',{class:'card-actions'},h('button',{type:'button',disabled:connection.busy,onclick:refresh},'Refresh'),connection.phase==='loading'?h('button',{type:'button',onclick:()=>session.cancelRead()},'Cancel refresh'):null,h('button',{type:'button',onclick:disconnect},'Disconnect')));
}
const connectionHost=h('div',{id:'connection'});main.prepend(connectionHost);
let connectionRenderKey=null;
function renderConnection(){
 const key=JSON.stringify([!!session,connection.phase,connection.error?.message,connection.busy,connection.items?.length]);
 if(key===connectionRenderKey)return;
 connectionRenderKey=key;connectionHost.replaceChildren(connectionPanel());
}
const polling=createEquipmentPolling({getSession:()=>session,canRead:()=>document.visibilityState==='visible'&&navigator.onLine,onTick:now=>updateEquipmentFreshness(main,items,{now,stale:isStale})});
setInterval(()=>polling.tick(),1000);
addEventListener('online',refresh);
addEventListener('offline',()=>{connection={...connection,phase:'error',error:{message:'Offline. Showing the last successful response. Reconnect to refresh before saving.'}};renderConnection();});
addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refresh();});
const fmt=d=>d.toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
const statusBadge=s=>h('span',{class:`badge s-${STATUSES.includes(s)?s:'retired'}`},s);
const freshness=i=>{const f=describeFreshness(i,isStale);return h('span',{class:`fresh-${f.state}`,'data-freshness-id':i.id},f.text);};
const noticeEl=()=>notice?h('p',{class:'notice',role:'status'},notice):null;
function scene(){try{return ward.frame?.contentWindow?.SupplyVanguardScene;}catch{return undefined;}}
function syncScene(){const s=scene();if(s){try{s.setEquipment(items);}catch{ward.state='error';render();}}}
function route(){const m=/^#\/(workspace|equipment|ward)/.exec(location.hash);return m?m[1]:'workspace';}
function go(name,{focusSearch=false,select:id}={}){if(id)select(id,false);location.hash=`#/${name}${focusSearch?'?search=1':''}`;}
/* workspace */
function workspace(){
 const sum=summarize(items,isStale),next=nextToReview(items,isStale),last=latestUpdate(items);
 return h('div',{class:'workspace'},
  h('div',{class:'ribbon a','aria-hidden':'true'}),h('div',{class:'ribbon b','aria-hidden':'true'}),
  h('div',{class:'intro'},h('h1',{},'Department workspace'),h('p',{class:'lede'},'Find equipment, record where it went, and keep the NICU ready.')),
  h('div',{class:'pill-wrap'},h('p',{class:'status-pill',role:'status'},last?['Last location observation ',h('strong',{},fmt(last)),' · see each asset for its source']:[h('strong',{},'Not yet verified'),' · no location updates recorded'])),
  h('section',{class:'card mint nicu','aria-labelledby':'nicu-h'},
   h('h2',{id:'nicu-h'},h('a',{class:'card-link',href:'#/equipment'},'NICU ',h('span',{class:'arrow','aria-hidden':'true'},'→'))),
   h('p',{class:'lede'},'Equipment register and an explorable ward for the NICU reference section.'),
   h('ul',{class:'chips'},h('li',{},`${sum.total} shared assets`),h('li',{},`${sum.available} available`),h('li',{'data-verification-count':true},`${sum.needsVerification} need location verification`)),
   h('div',{class:'card-actions'},h('a',{class:'btn primary',href:'#/equipment'},'Open equipment'),h('a',{class:'btn',href:'#/ward'},'Open 3D ward'))),
  h('section',{class:'card blush panel next-item','aria-labelledby':'next-h'},
   h('h2',{id:'next-h'},'Next to verify'),
   h('div',{class:'what','data-review-summary':true,hidden:!next},h('h3',{'data-review-name':true},next?.name||''),h('p',{class:'muted',style:'margin:0','data-review-location':true},next?`${next.id} · ${next.roomId}`:''),h('p',{style:'margin:4px 0 0','data-review-freshness':true},next?describeFreshness(next,isStale).text:'')),
   h('button',{class:'primary',type:'button','data-review-id':next?.id||'',hidden:!next,onclick:e=>go('equipment',{select:e.currentTarget.dataset.reviewId})},'Review ',h('span',{'aria-hidden':'true'},'→')),
   h('p',{'data-review-empty':true,hidden:!!next},sum.total?'Every asset has a recent location observation.':session?'No equipment loaded. Check the connection above.':'Connect to load shared equipment.')),
  h('p',{class:'preview-note more'},'More departments will appear here when they have real content.'));
}
/* equipment */
function select(id,focus=true){const i=items.find(x=>x.id===id);if(!i||connection.busy)return;selected=id;draft={id,version:i.version,status:i.status,note:i.note||'',locationId:i.locationId};formError=null;savedMessage='';if(focus)queueFocus('#detail-h');}
let pendingFocus=null;const queueFocus=sel=>{pendingFocus=sel;};
function equipmentView(){
 const shown=filterEquipment(items,query,statusFilter),cur=items.find(i=>i.id===selected);
 const search=h('input',{id:'search',type:'search',value:query,autocomplete:'off',oninput:e=>{query=e.target.value;renderList();}});
 const filter=h('select',{id:'status-filter',onchange:e=>{statusFilter=e.target.value;renderList();}},h('option',{value:'all'},'All statuses'),STATUSES.map(s=>h('option',{value:s,selected:s===statusFilter},s)));
 return h('div',{},
  h('h1',{style:'font-size:clamp(32px,5vw,56px)'},'Equipment'),noticeEl(),
  h('p',{class:'muted'},'Shared API records. Synthetic local data; no live hardware tracking. Status edits do not verify physical location.'),
  h('div',{class:'two-col'},
   h('section',{'aria-labelledby':'list-h'},h('h2',{id:'list-h',class:'sr-only'},'Equipment register'),
    h('div',{class:'toolbar'},h('label',{for:'search'},'Search equipment',search,h('span',{class:'hint'},'Name, asset ID, room or status')),h('label',{for:'status-filter'},'Status',filter)),
    h('p',{class:'count',id:'count',role:'status'}),h('ul',{class:'asset-list',id:'asset-list'}),
    h('p',{class:'hint'},'Equipment is stored by the shared API. Browser demo resets are unavailable.')),
   h('div',{},cur?detail(cur):h('div',{class:'detail-empty'},h('h2',{style:'font-size:22px'},'No asset selected'),h('p',{style:'margin:0'},'Choose an asset from the list to see its location and record an update.')),
    h('section',{class:'activity','aria-labelledby':'act-h'},h('h2',{id:'act-h',style:'font-size:22px'},'Recent activity'),activity()))));
}
function renderList(){
 const shown=filterEquipment(items,query,statusFilter),list=document.getElementById('asset-list'),count=document.getElementById('count');if(!list)return;
 count.textContent=`${shown.length} of ${items.length} assets shown`;list.replaceChildren(...(shown.length?shown.map(i=>h('li',{},h('button',{type:'button',class:'asset','aria-current':String(i.id===selected),onclick:()=>{select(i.id);render();}},h('strong',{},i.name),h('span',{class:'meta'},`${i.id} · ${i.roomId}`),h('span',{},statusBadge(i.status)),h('span',{class:'meta'},freshness(i))))):[h('li',{},h('p',{class:'muted'},items.length?'No matching equipment. Clear the search or choose All statuses.':session&&connection.phase==='ready'?'No equipment registered in this organization.':'Connect or refresh to load shared equipment.'))]));
}
function detail(i){
 const d=draft?.id===i.id?draft:{id:i.id,version:i.version,status:i.status,note:i.note||'',locationId:i.locationId};draft=d;
 const disabled=connection.busy||connection.phase!=='ready'||connection.needsRefresh||!navigator.onLine;
 const status=h('select',{id:'status',disabled,onchange:e=>{d.status=e.target.value;}},STATUSES.map(s=>h('option',{value:s,selected:s===d.status},s)));
 const note=h('textarea',{id:'note',maxlength:'500',disabled,oninput:e=>{d.note=e.target.value;},'aria-describedby':'note-hint'},d.note);
 const room=h('select',{id:'room',disabled,onchange:e=>{d.locationId=e.target.value;}},!roomIds.includes(d.locationId)?h('option',{value:d.locationId,selected:true},d.locationId):null,roomIds.map(r=>h('option',{value:r,selected:r===d.locationId},r)));
 return h('section',{class:'detail','aria-labelledby':'detail-h'},h('h2',{id:'detail-h',tabindex:'-1'},i.name),h('p',{class:'muted'},i.id+' · current version '+i.version+' · editing version '+d.version),h('p',{},statusBadge(i.status),' ',freshness(i)),h('p',{},'Location: '+i.locationId),h('p',{class:'hint'},i.lastVerified?'Observed '+fmt(new Date(i.lastVerified.observedAt))+' · '+i.lastVerified.source:'No verified location observation'),h('p',{class:'hint'},'Provenance: '+i.provenance),
 h('form',{id:'equipment-form',onsubmit:e=>{e.preventDefault();submit('admin',i.id);}},h('label',{for:'status'},'Status',status),h('label',{for:'note'},'Administrative note',note,h('span',{class:'hint',id:'note-hint'},'Optional, up to 500 characters. Does not verify a location. No patient information.')),
 h('div',{class:'actions'},h('button',{type:'submit',class:'primary',disabled},connection.busy?'Saving…':'Save status and note'),h('button',{type:'button',onclick:()=>{select(i.id);render();},disabled:connection.busy},'Cancel edits'))),
 h('form',{id:'location-form',onsubmit:e=>{e.preventDefault();submit('observe',i.id);}},h('label',{for:'room'},'Observed location',room),h('p',{class:'hint'},'Record only after checking this physical location. Sends a manual check-in with the current observation time.'),h('button',{type:'submit',disabled},'Confirm observed location')),
 connection.busy?h('button',{type:'button',onclick:()=>session.cancelWrite()},'Stop waiting for save'):null,
 formError?h('p',{class:'field-error',role:'alert',tabindex:'-1'},formError.message,formError.conflict?[' ',h('button',{type:'button',disabled:connection.phase!=='ready',onclick:()=>{draft={...draft,version:i.version};formError=null;render();}},'Use latest version and review draft')]:null):null,
 savedMessage?h('p',{class:'save-ok',role:'status',tabindex:'-1'},savedMessage):null,
 h('div',{class:'actions'},h('button',{type:'button',onclick:()=>{go('ward');locate(i.id);}},'Locate in 3D')));
}
async function submit(kind,id){
 if(!session||connection.busy||connection.phase!=='ready'||connection.needsRefresh||!navigator.onLine)return;
 const d={...draft};formError=null;savedMessage='';
 try{
  const body=kind==='admin'?{expectedVersion:d.version,status:d.status,note:d.note}:{locationId:d.locationId,observedAt:new Date().toISOString(),source:'manual-check-in'};
  const result=await session.mutate(kind,id,body);
  if(selected!==id)return;
  const latest=items.find(i=>i.id===id);if(latest)draft={id,version:latest.version,status:latest.status,note:latest.note||'',locationId:latest.locationId};
  savedMessage=kind==='admin'?'Saved and refreshed shared state. Location verification is unchanged.':result.applied?'Observation recorded; shared state refreshed.':'Observation recorded but did not replace a newer verified location.';
  events.push({equipmentId:id,kind,at:new Date().toISOString(),message:savedMessage});events=events.slice(-8);
 }catch(error){if(selected!==id)return;formError={message:error.message,conflict:error.status===409};}
 queueFocus(formError?'[role="alert"]':'.save-ok');render();
}
function activity(){return events.length?h('ol',{},events.slice().reverse().map(e=>h('li',{},e.equipmentId+' · '+e.message,h('br'),h('span',{class:'muted'},e.at)))):h('p',{class:'muted'},'Actions confirmed in this tab appear here. Shared audit history is not available from this API.');}
/* ward */
// ?nowebgl and ?wardtimeout=MS exist so the fallback and error states can be exercised without a broken browser.
const params=new URLSearchParams(location.search),hasWebGL=!params.has('nowebgl')&&webglAvailable(()=>document.createElement('canvas')),wardTimeout=Number(params.get('wardtimeout'))||12000;
function locate(id){const s=scene();if(s)s.focusEquipment(id);else pendingLocate=id;}
let pendingLocate=null;
function startWard(){
 if(ward.state!=='idle')return;
 if(!hasWebGL){ward.state='no-webgl';return;}
 ward.state='loading';clearTimeout(ward.timer);
 const frame=h('iframe',{src:'/ward/',title:'Explorable NICU ward and equipment tracking',onload:()=>{let tries=0;const poll=()=>{if(scene()){ward.state='ready';syncScene();if(pendingLocate){scene().focusEquipment(pendingLocate);pendingLocate=null;}render();}else if(++tries<40)setTimeout(poll,250);};poll();}});
 ward.frame=frame;
 ward.timer=setTimeout(()=>{if(ward.state==='loading'){ward.state='error';render();}},wardTimeout);
}
// The iframe lives in a permanent container and is only hidden, never moved: detaching an iframe reloads it.
const wrap=document.getElementById('ward-wrap'),wardNotice=h('div'),wardLoading=h('div'),wardState=h('div'),wardFrameSlot=h('div');
wrap.append(h('h1',{style:'font-size:clamp(32px,5vw,56px)'},'3D ward'),wardNotice,h('p',{class:'muted'},'Equipment pins follow the register. Building geometry is an estimated reference reconstruction.'),wardLoading,h('div',{class:'ward-frame'},wardState,wardFrameSlot));
function renderWard(){
 startWard();
 const body=ward.state==='no-webgl'?h('div',{class:'ward-state'},h('h2',{},'3D view unavailable'),h('p',{},'This browser or device does not provide WebGL, which the 3D ward needs. Everything else still works: the equipment list shows the same rooms and statuses.'),h('div',{class:'card-actions'},h('a',{class:'btn primary',href:'#/equipment'},'Open equipment list')))
  :ward.state==='error'?h('div',{class:'ward-state'},h('h2',{},'The 3D ward did not load'),h('p',{},'It took too long or failed to start. The equipment list is unaffected.'),h('div',{class:'card-actions'},h('button',{type:'button',class:'primary',onclick:()=>{ward.frame?.remove();ward.frame=null;ward.state='idle';render();}},'Try again'),h('a',{class:'btn',href:'#/equipment'},'Open equipment list')))
  :null;
 wardNotice.replaceChildren(noticeEl()||'');
 wardLoading.replaceChildren(ward.state==='loading'?h('p',{class:'loading',role:'status'},'Loading ward…'):'');
 wardState.replaceChildren(body||'');
 if(ward.frame&&!ward.frame.isConnected)wardFrameSlot.append(ward.frame);
 if(!ward.frame)wardFrameSlot.replaceChildren();
}
/* shell */
function render(){
 renderConnection();
 const r=route();
 document.querySelectorAll('.nav a[data-route]').forEach(a=>{if(a.dataset.route===r)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
 const search=/search=1/.test(location.hash);
 wrap.hidden=r!=='ward';
 if(r==='ward'){view.replaceChildren();renderWard();}else view.replaceChildren(r==='equipment'?equipmentView():workspace());
 if(r==='equipment')renderList();
 document.title=`${{workspace:'Workspace',equipment:'Equipment',ward:'3D ward'}[r]} · Supply Vanguard`;
 if(pendingFocus){const el=main.querySelector(pendingFocus);pendingFocus=null;el?.focus?.();}
 else if(search&&r==='equipment'){document.getElementById('search')?.focus();}
}
let lastRoute=null;
function onRoute(){const r=route();if(r!==lastRoute&&!pendingFocus&&!/search=1/.test(location.hash)){pendingFocus=null;}render();if(r!==lastRoute){lastRoute=r;if(!pendingFocus&&!/search=1/.test(location.hash))main.focus({preventScroll:false});}}
addEventListener('hashchange',onRoute);
onRoute();
