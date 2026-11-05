// Pure helpers for the web app. Legacy save parsers are retained for compatibility tests only.
import {freshness as recordFreshness} from '../../../packages/domain/contracts.js';
export const STORAGE_KEY='supply-vanguard-demo-v1';
const clip=(v,max=200)=>typeof v==='string'?v.slice(0,max):'';
const state=o=>o&&typeof o==='object'?{roomId:clip(o.roomId,64),status:clip(o.status,32),version:Number.isInteger(o.version)?o.version:0}:{roomId:'',status:'',version:0};
// Persisted events are untrusted text: keep known string fields only, clipped. The UI also renders them as text, never as HTML.
export function sanitizeEvent(e){
 if(!e||typeof e!=='object'||typeof e.equipmentId!=='string'||!e.equipmentId)return null;
 return {id:clip(e.id,64),equipmentId:clip(e.equipmentId,64),actor:clip(e.actor,100),at:clip(e.at,40),source:clip(e.source,40),note:clip(e.note,500),before:state(e.before),after:state(e.after)};
}
// Returns {items,events,notice}. items is null when nothing usable was saved, so the caller falls back to sample data.
export function parseSaved(text,{validate,roomIds,expectedCount}){
 if(text===null||text===undefined)return {items:null,events:[],notice:null};
 try{
  const s=JSON.parse(text);
  if(!s||!Array.isArray(s.items)||s.items.length!==expectedCount||new Set(s.items.map(i=>i&&i.id)).size!==expectedCount)throw new Error('shape');
  s.items.forEach(i=>validate(i,roomIds));
  const events=(Array.isArray(s.events)?s.events:[]).map(sanitizeEvent).filter(Boolean).slice(-100);
  return {items:s.items,events,notice:null};
 }catch{return {items:null,events:[],notice:'Saved data could not be read, so sample data is shown instead.'};}
}
export function filterEquipment(items,query='',status='all'){
 const q=query.trim().toLowerCase();
 return items.filter(i=>(status==='all'||i.status===status)&&(!q||`${i.id} ${i.name} ${i.roomId} ${i.status}`.toLowerCase().includes(q)));
}
export function describeFreshness(item,stale){
 if(Object.hasOwn(item,'lastVerified')){
  const f=recordFreshness(item);
  return f==='unknown'?{state:'unverified',text:'Not yet verified'}:f==='aging'?{state:'stale',text:'Location observation aging'}:f==='stale'?{state:'stale',text:'Location needs verification'}:{state:'fresh',text:'Location recently observed'};
 }
 if(!item.lastSeenAt)return {state:'unverified',text:'Not yet verified'};
 return stale(item)?{state:'stale',text:'Location needs verification'}:{state:'fresh',text:'Recently updated'};
}
// First item whose location is unverified or stale, for the workspace panel. null when everything is current.
export function nextToReview(items,stale){return items.find(i=>describeFreshness(i,stale).state!=='fresh')||null;}
export function summarize(items,stale){
 return {total:items.length,available:items.filter(i=>i.status==='available').length,needsVerification:items.filter(i=>describeFreshness(i,stale).state!=='fresh').length};
}
export function latestUpdate(items){
 const times=items.map(i=>Date.parse(i.lastSeenAt)).filter(Number.isFinite);
 return times.length?new Date(Math.max(...times)):null;
}
export function webglAvailable(createCanvas){
 try{const c=createCanvas();return !!(c.getContext('webgl2')||c.getContext('webgl'));}catch{return false;}
}
// Compatibility boundary for the existing scene. Keep canonical wire fields and provenance.
export const presentEquipment=record=>({...record,roomId:record.locationId,lastSeenAt:record.lastVerified?.observedAt??null,source:record.lastVerified?.source??record.provenance});
