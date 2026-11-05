import {parseEquipmentLabel} from './payload.js';
import {createScanner} from './scanner.js';

// The host supplies its existing authenticated transport. No tokens, localStorage or auth client here.
// request(path,{method,headers,body,signal}) returns a parsed JSON response or throws an error.
export function mountCheckIn(root,{organizationId,request,onCommitted=()=>{},environment=globalThis}) {
 if(typeof request!=='function')throw new Error('Authenticated request function required');
 const doc=root.ownerDocument,base=`/organizations/${encodeURIComponent(organizationId)}/check-ins`;
 const el=(tag,text,attrs={})=>{const n=doc.createElement(tag);if(text)n.textContent=text;for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;};
 root.replaceChildren();root.classList.add('check-in');
 const heading=el('h2','Check in equipment'),intro=el('p','Confirm where you observed this equipment. No patient details are needed.');
 const provenance=el('p','Inventory provenance will appear with the saved result. Location checks are staff observations, not live tracking.',{class:'hint'});
 const form=el('form'),id=el('input',null,{name:'equipmentId',autocomplete:'off',maxlength:'68',required:'',inputmode:'text'});
 const location=el('select',null,{name:'locationId',required:''}),source=el('select',null,{name:'source'});
 let fieldNumber=0;const prefix=`check-in-${environment.crypto.randomUUID()}`;
 const field=(labelText,input)=>{const name=`${prefix}-${++fieldNumber}`;input.id=name;const label=el('label',labelText,{for:name});form.append(label,input);};
 const addOption=(select,value,text)=>{const option=el('option',text,{value});select.append(option);};
 addOption(location,'','Loading known locations…');
 for(const [v,t]of [['manual-check-in','Typed equipment ID'],['barcode','Keyboard barcode scanner'],['qr','Keyboard QR scanner']])addOption(source,v,t);
 field('Equipment ID',id);const hint=el('p','Type the printed ID (for example EQ-001), or scan into this field. Scanning never submits automatically.',{id:`${prefix}-hint`,class:'hint'});id.setAttribute('aria-describedby',hint.id);form.append(hint);
 field('How was the ID entered?',source);field('Observed location',location);
 const actions=el('div',null,{class:'check-in-actions'}),save=el('button','Confirm check-in',{type:'submit',class:'primary',disabled:''});
 const retryLocations=el('button','Reload locations',{type:'button'}),start=el('button','Start camera',{type:'button'}),stop=el('button','Stop camera',{type:'button'}),reset=el('button','New check-in',{type:'button'}),cancel=el('button','Cancel request',{type:'button'});
 actions.append(save,cancel,reset);form.append(actions);
 const scannerActions=el('div',null,{class:'check-in-actions'});scannerActions.append(start,stop,retryLocations);
 const video=el('video',null,{playsinline:'',muted:'',hidden:'','aria-label':'Equipment label camera preview'});video.muted=true;
 const status=el('p','Loading locations…',{role:'status','aria-live':'polite',tabindex:'-1'}),error=el('p','',{role:'alert',class:'field-error'});
 root.append(heading,intro,provenance,form,scannerActions,video,status,error);
 let attempt=null,busy=false,disposed=false,controller=null,locationController=null,locationsReady=false;
 const showError=message=>{error.textContent=message;};
 const scanner=createScanner({video,environment,onError:showError,onScan:(value,kind)=>{
  if(busy||disposed)return;
  // Submission compares normalized fields; an equivalent prefixed rescan must retain its retry key.
  id.value=value;source.value=kind;status.textContent='Label read. Choose the observed location, then confirm check-in.';id.focus();
 }});
 const edit=()=>{if(!busy){status.textContent='Review the equipment and observed location before confirming.';id.removeAttribute('aria-invalid');location.removeAttribute('aria-invalid');showError('');}};
 id.addEventListener('input',edit);source.addEventListener('change',edit);location.addEventListener('change',edit);
 id.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();status.textContent='ID entered. Review the observed location, then activate Confirm check-in.';save.focus();}});
 const setBusy=value=>{busy=value;for(const control of [id,source,location,save,start,reset,retryLocations])control.disabled=value||control===save&&!locationsReady;form.setAttribute('aria-busy',String(value));};
 const loadLocations=async()=>{
  locationController?.abort();locationController=new environment.AbortController();locationsReady=false;save.disabled=true;
  const loading=locationController;
  try {const data=await request(`${base}/locations`,{method:'GET',signal:loading.signal});if(disposed||loading!==locationController)return;
   const selected=location.value;location.replaceChildren();addOption(location,'','Choose a known location');
   for(const item of data.items)addOption(location,item.id,item.name);
   location.value=selected;locationsReady=true;save.disabled=busy;status.textContent='Ready for manual entry or a scanner.';showError('');
  } catch {if(!disposed&&loading===locationController){status.textContent='Locations could not be loaded.';showError('Check your connection and reload locations. Your equipment ID is preserved.');}}
 };
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!locationsReady||disposed)return;
  showError('');let equipmentId;
  try{equipmentId=parseEquipmentLabel(id.value);}catch(e){id.setAttribute('aria-invalid','true');showError(e.message);id.focus();return;}
  if(!location.value||!Array.from(location.options).some(o=>o.value===location.value)){location.setAttribute('aria-invalid','true');showError('Choose a known location.');location.focus();return;}
  if(attempt && (attempt.body.equipmentId!==equipmentId || attempt.body.locationId!==location.value || attempt.body.source!==source.value))attempt=null;
  if(attempt?.result){status.textContent='This check-in is already saved. Choose New check-in to record another observation.';return;}
  // Freeze observed time and key through network failure/cancel/retry and repeated scans.
  attempt??={key:environment.crypto.randomUUID(),body:{equipmentId,locationId:location.value,source:source.value,observedAt:new Date().toISOString()}};
  scanner.stop();controller=new environment.AbortController();setBusy(true);status.textContent='Saving check-in…';
  try {
   const result=await request(base,{method:'POST',headers:{'Idempotency-Key':attempt.key,'Content-Type':'application/json'},body:JSON.stringify(attempt.body),signal:controller.signal});
   if(disposed)return;attempt.result=result;
   status.textContent=`${result.replayed?'Previously saved':'Saved'} ${result.observation.equipmentId} at ${result.observation.locationId}. Observed ${result.observation.observedAt}; received ${result.observation.receivedAt}. Source: ${result.observation.source}. ${result.applied?'Location confirmed.':'Kept in history; a newer location remains current.'}`;
   provenance.textContent=`Inventory provenance: ${result.record.provenance}. Recorded by ${result.observation.actor}.`;
   try{await onCommitted(result);}catch{showError('Check-in was saved. Refresh the equipment list to see its latest state.');}
  } catch(e) {if(!disposed){status.textContent='Check-in has not been confirmed in this view.';showError(e?.status===404?'Unknown equipment ID. Check the printed label.':e?.status===409?'This request key conflicts. Refresh your session before starting a new check-in.':e?.status===403||e?.status===401?'Your session cannot check in equipment. Sign in with an authorized membership.':'The request may have reached the server. Retry unchanged to safely retrieve or save this same check-in.');}}
  finally{if(!disposed)setBusy(false);}
 });
 start.addEventListener('click',()=>{showError('');scanner.start();});stop.addEventListener('click',()=>{scanner.stop();status.textContent='Camera stopped. Manual entry is available.';});
 cancel.addEventListener('click',()=>{controller?.abort();scanner.stop();});
 reset.addEventListener('click',()=>{if(busy)return;attempt=null;showError('');status.textContent='Ready for a new observation. Confirm only after observing the equipment again.';id.focus();});
 retryLocations.addEventListener('click',loadLocations);
 const hide=()=>{if(doc.hidden)scanner.stop();};doc.addEventListener('visibilitychange',hide);
 const leave=()=>scanner.stop();environment.addEventListener?.('pagehide',leave);
 loadLocations();
 return {destroy(){disposed=true;scanner.stop();controller?.abort();locationController?.abort();doc.removeEventListener('visibilitychange',hide);environment.removeEventListener?.('pagehide',leave);root.replaceChildren();}};
}
