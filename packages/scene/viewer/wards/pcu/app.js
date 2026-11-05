import {WARD,LOCATIONS,EQUIPMENT,SOURCES,filterEquipment} from './config.js';
const $=id=>document.getElementById(id);
let viewer=null,selectedId=null,renderedEquipmentKey=null;
const listOnly=new URLSearchParams(location.search).get('view')==='list';
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function selectEquipment(id){
 const item=EQUIPMENT.find(e=>e.id===id);if(!item)return;selectedId=id;
 const room=LOCATIONS.find(r=>r.id===item.locationId),panel=$('selection');panel.replaceChildren();panel.hidden=false;
 panel.append(el('h3',item.name),el('code',item.id),el('p',room.name),el('p',item.provenance));
 if(viewer){const visit=el('button','Walk inside this room');visit.onclick=()=>viewer.visit(room);panel.append(visit);viewer.select(item);}
 // Keep result nodes intact so Enter/Space selection preserves keyboard focus and scroll.
 for(const button of $('equipment-list').children)if(button.dataset.equipmentId)button.setAttribute('aria-pressed',String(selectedId===button.dataset.equipmentId));
}
function updateEquipmentSummary(matches){
 $('result-count').textContent=`${matches.length} of ${EQUIPMENT.length} synthetic examples${viewer&&matches.length<EQUIPMENT.length?' · matches highlighted in 3D':''}`;
 viewer?.highlight(matches.map(e=>e.id));
}
function renderEquipment(){
 const matches=filterEquipment($('equipment-search').value,$('equipment-kind').value),list=$('equipment-list'),key=matches.map(item=>item.id).join('\n');
 // History restoration and viewer readiness must reconcile rows as well as count/highlights.
 // Leave unchanged results intact, including a focused row restored from the page cache.
 if(key!==renderedEquipmentKey){
 list.replaceChildren();
 for(const item of matches){const room=LOCATIONS.find(r=>r.id===item.locationId),button=el('button',undefined,'equipment-item');button.dataset.equipmentId=item.id;button.append(el('span',item.name),el('small',`${room.short} · ${item.id}`));button.setAttribute('aria-pressed',String(selectedId===item.id));button.onclick=()=>selectEquipment(item.id);list.append(button);}
 if(!matches.length)list.append(el('p','No matching examples. Try another room or equipment name.'));
 renderedEquipmentKey=key;
 }
 updateEquipmentSummary(matches);
}
for(const room of LOCATIONS){const button=el('button',room.short);button.setAttribute('aria-label',`Visit ${room.name}`);button.disabled=true;button.dataset.room=room.id;button.onclick=()=>viewer?.visit(room);$('room-list').append(button);}
for(const source of SOURCES){const link=el('a',source.title);link.href=source.url;link.target='_blank';link.rel='noreferrer';$('source-list').append(link,el('p',source.supports));}
$('sources-open').onclick=()=>$('sources-dialog').showModal();$('sources-close').onclick=()=>$('sources-dialog').close();
$('sources-dialog').addEventListener('click',e=>{if(e.target===$('sources-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
function changeEquipmentFilters(){
 window.history.replaceState({...window.history.state,pcuFilters:{query:$('equipment-search').value,kind:$('equipment-kind').value}},'');
 renderEquipment();
}
function restoreEquipmentFilters(){
 const saved=window.history.state?.pcuFilters;
 if(saved&&typeof saved.query==='string'&&(saved.kind==='all'||EQUIPMENT.some(item=>item.kind===saved.kind))){$('equipment-search').value=saved.query;$('equipment-kind').value=saved.kind;}
 renderEquipment();
}
$('equipment-search').addEventListener('input',changeEquipmentFilters);$('equipment-kind').addEventListener('change',changeEquipmentFilters);renderEquipment();
// Restored form values need not emit input/change and may arrive after pageshow.
// Run after history traversal finishes, including back-forward cache restoration.
window.addEventListener('pageshow',()=>setTimeout(restoreEquipmentFilters,0));
function fallback(message){document.body.classList.add('list-mode');$('loading').textContent=message;$('view-status').textContent='Equipment list and reference sources remain available';$('list-toggle').textContent='Try the 3D view';$('list-toggle').href='./index.html';}
if(listOnly)fallback('Equipment list mode. All synthetic example records and source notes are available without 3D graphics.');
else{
 try{const {mountViewer}=await import('./viewer.js');viewer=mountViewer({container:$('scene'),markers:$('room-markers'),onSelect:selectEquipment,onMode:mode=>{
  $('overview').setAttribute('aria-pressed',String(mode==='overview'));$('walk').setAttribute('aria-pressed',String(mode==='walk'));$('walk-help').hidden=mode!=='walk';$('cutaway').disabled=mode==='walk';$('view-status').textContent=mode==='walk'?'Inside an illustrative room · focus the view to use walking keys':'Drag to orbit · scroll to zoom';
 }});
 $('loading').hidden=true;for(const button of document.querySelectorAll('.scene-toolbar button,[data-move],[data-room]'))button.disabled=false;
 $('overview').onclick=()=>viewer.overview();$('walk').onclick=()=>viewer.walk();$('reset').onclick=()=>viewer.overview();$('save-view').onclick=()=>viewer.saveView();
 let cutaway=true;$('cutaway').onclick=()=>{cutaway=!cutaway;viewer.cutaway(cutaway);$('cutaway').setAttribute('aria-pressed',String(cutaway));$('cutaway').textContent=`Cutaway ${cutaway?'on':'off'}`;};
 for(const button of document.querySelectorAll('[data-move]')){button.onpointerdown=e=>{e.preventDefault();button.setPointerCapture(e.pointerId);viewer.moveKey(button.dataset.move,true);};button.onpointerup=button.onpointercancel=()=>viewer.moveKey(button.dataset.move,false);button.onkeydown=e=>{if(e.code==='Space'||e.code==='Enter'){e.preventDefault();viewer.moveKey(button.dataset.move,true);}};button.onkeyup=e=>{if(e.code==='Space'||e.code==='Enter'){e.preventDefault();viewer.moveKey(button.dataset.move,false);}};button.onblur=()=>viewer.moveKey(button.dataset.move,false);}
 renderEquipment();if(selectedId)selectEquipment(selectedId);document.body.dataset.sceneReady=WARD.id;
 }catch(error){console.error('PCU 3D view unavailable',error);fallback('3D graphics are unavailable. Search and select equipment in the adjacent list, or read the source notes.');}
}
