import {STATUSES,updateEquipment,validateEquipment,isStale} from '/packages/domain/equipment.js';
import {roomIds,seedEquipment} from '/packages/domain/seed.js';
import {STORAGE_KEY,parseSaved,filterEquipment,describeFreshness,nextToReview,summarize,latestUpdate,webglAvailable} from '/src/lib.js';
// All text from state or storage is added as text nodes by h(); no markup is ever built from data.
const h=(tag,attrs={},...kids)=>{const el=document.createElement(tag);for(const [k,v] of Object.entries(attrs)){if(v===false||v===null||v===undefined)continue;if(k==='class')el.className=v;else if(k.startsWith('on'))el.addEventListener(k.slice(2),v);else el.setAttribute(k,v===true?'':v);}for(const kid of kids.flat())if(kid!==null&&kid!==undefined&&kid!==false)el.append(kid.nodeType?kid:document.createTextNode(String(kid)));return el;};
const main=document.getElementById('main'),view=document.getElementById('view');
let items=seedEquipment(),events=[],notice=null,selected=null,formVersion=null,query='',statusFilter='all',savedMessage='',formError=null,resetArmed=false;
let ward={state:'idle',frame:null,timer:null};
try{const r=parseSaved(localStorage.getItem(STORAGE_KEY),{validate:validateEquipment,roomIds,expectedCount:8});if(r.items){items=r.items;events=r.events;}notice=r.notice;}catch{notice='Saved data is unavailable in this browser. Changes last until you close the tab.';}
function save(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify({items,events}));return true;}catch{notice='Changes could not be saved in this browser and will be lost when you close the tab.';return false;}}
const fmt=d=>d.toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
const statusBadge=s=>h('span',{class:`badge s-${STATUSES.includes(s)?s:'retired'}`},s);
const freshness=i=>{const f=describeFreshness(i,isStale);return h('span',{class:`fresh-${f.state}`},f.text);};
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
  h('div',{class:'pill-wrap'},h('p',{class:'status-pill',role:'status'},last?['Last update ',h('strong',{},fmt(last)),' · manual entry']:[h('strong',{},'Not yet verified'),' · no location updates recorded'])),
  h('section',{class:'card mint nicu','aria-labelledby':'nicu-h'},
   h('h2',{id:'nicu-h'},h('a',{class:'card-link',href:'#/equipment'},'NICU ',h('span',{class:'arrow','aria-hidden':'true'},'→'))),
   h('p',{class:'lede'},'Equipment register and an explorable ward for the NICU reference section.'),
   h('ul',{class:'chips'},h('li',{},`${sum.total} sample assets`),h('li',{},`${sum.available} available`),h('li',{},`${sum.needsVerification} need location verification`)),
   h('div',{class:'card-actions'},h('a',{class:'btn primary',href:'#/equipment'},'Open equipment'),h('a',{class:'btn',href:'#/ward'},'Open 3D ward'))),
  h('section',{class:'card blush panel next-item','aria-labelledby':'next-h'},
   h('h2',{id:'next-h'},'Next to verify'),
   next?[h('div',{class:'what'},h('h3',{},next.name),h('p',{class:'muted',style:'margin:0'},`${next.id} · ${next.roomId}`),h('p',{style:'margin:4px 0 0'},freshness(next))),h('button',{class:'primary',type:'button',onclick:()=>go('equipment',{select:next.id})},'Review ',h('span',{'aria-hidden':'true'},'→'))]
        :h('p',{},'Every asset has a recent update.')),
  h('p',{class:'preview-note more'},'More departments will appear here when they have real content.'));
}
/* equipment */
function select(id,focus=true){const i=items.find(x=>x.id===id);if(!i)return;selected=id;formVersion=i.version;formError=null;savedMessage='';if(focus)queueFocus('#detail-h');}
let pendingFocus=null;const queueFocus=sel=>{pendingFocus=sel;};
function equipmentView(){
 const shown=filterEquipment(items,query,statusFilter),cur=items.find(i=>i.id===selected);
 const search=h('input',{id:'search',type:'search',value:query,autocomplete:'off',oninput:e=>{query=e.target.value;renderList();}});
 const filter=h('select',{id:'status-filter',onchange:e=>{statusFilter=e.target.value;renderList();}},h('option',{value:'all'},'All statuses'),STATUSES.map(s=>h('option',{value:s,selected:s===statusFilter},s)));
 return h('div',{},
  h('h1',{style:'font-size:clamp(32px,5vw,56px)'},'Equipment'),noticeEl(),
  h('p',{class:'muted'},'Manual locations and sample assets. No live tracking feed.'),
  h('div',{class:'two-col'},
   h('section',{'aria-labelledby':'list-h'},h('h2',{id:'list-h',class:'sr-only'},'Equipment register'),
    h('div',{class:'toolbar'},h('label',{for:'search'},'Search equipment',search,h('span',{class:'hint'},'Name, asset ID, room or status')),h('label',{for:'status-filter'},'Status',filter)),
    h('p',{class:'count',id:'count',role:'status'}),h('ul',{class:'asset-list',id:'asset-list'}),
    h('div',{style:'margin-top:16px'},resetButton())),
   h('div',{},cur?detail(cur):h('div',{class:'detail-empty'},h('h2',{style:'font-size:22px'},'No asset selected'),h('p',{style:'margin:0'},'Choose an asset from the list to see its location and record an update.')),
    h('section',{class:'activity','aria-labelledby':'act-h'},h('h2',{id:'act-h',style:'font-size:22px'},'Recent activity'),activity()))));
}
function resetButton(){return resetArmed?h('span',{},h('button',{type:'button',class:'primary',onclick:()=>{items=seedEquipment();events=[];selected=null;resetArmed=false;save();syncScene();render();}},'Confirm reset'),' ',h('button',{type:'button',onclick:()=>{resetArmed=false;render();}},'Cancel')):h('button',{type:'button',onclick:()=>{resetArmed=true;render();}},'Reset demo data');}
function renderList(){
 const shown=filterEquipment(items,query,statusFilter),list=document.getElementById('asset-list'),count=document.getElementById('count');if(!list)return;
 count.textContent=`${shown.length} of ${items.length} assets shown`;list.replaceChildren(...(shown.length?shown.map(i=>h('li',{},h('button',{type:'button',class:'asset','aria-current':String(i.id===selected),onclick:()=>{select(i.id);render();}},h('strong',{},i.name),h('span',{class:'meta'},`${i.id} · ${i.roomId}`),h('span',{},statusBadge(i.status)),h('span',{class:'meta'},freshness(i))))):[h('li',{},h('p',{class:'muted'},'No matching equipment. Clear the search or choose All statuses.'))]));
}
function detail(i){
 const err=formError,noteErr=err&&/note/i.test(err.message),roomSel=h('select',{id:'room'},roomIds.map(r=>h('option',{value:r,selected:r===i.roomId},r))),statusSel=h('select',{id:'status'},STATUSES.map(s=>h('option',{value:s,selected:s===i.status},s))),note=h('textarea',{id:'note',maxlength:'500','aria-describedby':noteErr?'note-err note-hint':'note-hint','aria-invalid':noteErr?'true':false},err?.draft??'');
 return h('section',{class:'detail','aria-labelledby':'detail-h'},
  h('h2',{id:'detail-h',tabindex:'-1'},i.name),h('p',{class:'muted',style:'margin:0'},`${i.id} · version ${i.version}`),
  h('p',{style:'margin:8px 0 0'},statusBadge(i.status),' ',freshness(i)),
  h('form',{novalidate:true,onsubmit:e=>{e.preventDefault();submit(i.id,roomSel.value,statusSel.value,note.value);}},
   h('label',{for:'room'},'Room',roomSel),h('label',{for:'status'},'Status',statusSel),
   h('label',{for:'note'},'Movement note',note,h('span',{class:'hint',id:'note-hint'},'Optional. Up to 500 characters.')),
   noteErr?h('p',{class:'field-error',id:'note-err',role:'alert',tabindex:'-1'},err.message):null,
   err&&!noteErr?h('p',{class:'field-error',role:'alert',tabindex:'-1'},err.message,err.conflict?[' ',h('button',{type:'button',onclick:()=>{select(i.id);render();}},'Reload latest')]:null):null,
   savedMessage?h('p',{class:'save-ok',role:'status',tabindex:'-1'},savedMessage):null,
   h('div',{class:'actions'},h('button',{type:'submit',class:'primary'},'Save update'),h('button',{type:'button',onclick:()=>{go('ward');locate(i.id);}},'Locate in 3D'))));
}
function submit(id,roomId,status,noteText){
 const index=items.findIndex(e=>e.id===id);
 try{const result=updateEquipment(items[index],{roomId,status,note:noteText},{expectedVersion:formVersion,actor:'demo-operator',roomIds});
  items[index]=result.equipment;events.push(result.event);events=events.slice(-100);save();syncScene();formVersion=result.equipment.version;formError=null;savedMessage=`Saved. ${result.equipment.name} is now ${status} in ${roomId} (version ${result.equipment.version}).`;
 }catch(e){formError={message:e.message,draft:noteText,conflict:/^Conflict/.test(e.message)};savedMessage='';}
 queueFocus(formError?(/note/i.test(formError.message)?'#note':'[role="alert"]'):'.save-ok');render();
}
function activity(){return events.length?h('ol',{},events.slice(-8).reverse().map(e=>h('li',{},`${e.equipmentId} → ${e.after.roomId} / ${e.after.status}`,h('br'),h('span',{class:'muted'},`${e.at} · ${e.actor}`),e.note?h('br'):null,e.note?h('span',{},`Note: ${e.note}`):null))):h('p',{class:'muted'},'No equipment updates yet.');}
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
