// Versioned equipment, observation and event contracts (SV-001).
// Two kinds of change are kept apart: administrative edits (status, notes) never touch
// location confidence, and observations (where the item was last seen) never touch status.
export const SCHEMA_VERSION=1;
export const STATUSES=Object.freeze(['available','in-use','cleaning','maintenance','retired']);
// Proposed rules for review: retired is terminal, and equipment must be cleaned before it is available again.
export const TRANSITIONS=Object.freeze({
 available:['in-use','cleaning','maintenance','retired'],
 'in-use':['cleaning','maintenance','retired'],
 cleaning:['available','maintenance','retired'],
 maintenance:['cleaning','available','retired'],
 retired:[]
});
export const OBSERVATION_SOURCES=Object.freeze(['manual-check-in','barcode','qr','rfid','ble','rtls','simulator']);
export const FRESHNESS=Object.freeze({freshMs:5*60*1000,agingMs:30*60*1000});
export const EQUIPMENT_FIELDS=Object.freeze(['schemaVersion','id','name','modelKind','locationId','status','version','lastVerified','lastAdminEditAt','note','provenance']);
export const OBSERVATION_FIELDS=Object.freeze(['schemaVersion','equipmentId','locationId','observedAt','receivedAt','source','actor','correlationId','idempotencyKey']);
export const ADMIN_COMMAND_FIELDS=Object.freeze(['schemaVersion','equipmentId','expectedVersion','actor','status','note','correlationId','idempotencyKey']);
const fail=m=>{throw new Error(m);};
const text=(v,name,max=200)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(`${name} must be non-empty text under ${max} characters`);return v;};
const instant=(v,name)=>{if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v)||!Number.isFinite(Date.parse(v)))fail(`${name} must be a UTC ISO timestamp`);return v;};
const onlyKnown=(o,allowed,name)=>{if(!o||typeof o!=='object'||Array.isArray(o))fail(`${name} must be an object`);const extra=Object.keys(o).filter(k=>!allowed.includes(k));if(extra.length)fail(`${name} has unsupported fields: ${extra.join(', ')}`);if(o.schemaVersion!==SCHEMA_VERSION)fail(`${name} schemaVersion must be ${SCHEMA_VERSION}`);};
const locationOk=(id,locationIds)=>{if(!locationIds.includes(id))fail('Unknown location');return id;};
export function canTransition(from,to){return Object.hasOwn(TRANSITIONS,from)&&TRANSITIONS[from].includes(to);}
// lastVerified is the only place physical-location confidence lives; null means never observed.
export function validateEquipmentRecord(item,locationIds){
 onlyKnown(item,EQUIPMENT_FIELDS,'Equipment');
 text(item.id,'Equipment id',64);text(item.name,'Equipment name');text(item.modelKind,'Model kind',64);
 locationOk(item.locationId,locationIds);
 if(!STATUSES.includes(item.status))fail('Unknown equipment status');
 if(!Number.isInteger(item.version)||item.version<0)fail('Invalid equipment version');
 if(item.lastVerified!==null){const v=item.lastVerified;if(!v||typeof v!=='object'||Object.keys(v).some(k=>!['locationId','observedAt','source'].includes(k)))fail('Invalid lastVerified');locationOk(v.locationId,locationIds);instant(v.observedAt,'lastVerified.observedAt');if(!OBSERVATION_SOURCES.includes(v.source))fail('Unknown observation source');}
 if(item.lastAdminEditAt!==null)instant(item.lastAdminEditAt,'lastAdminEditAt');
 if(typeof item.note!=='undefined'&&(typeof item.note!=='string'||item.note.length>500))fail('Note must be text under 500 characters');
 text(item.provenance,'Provenance',100);
 return item;
}
export function validateObservation(obs,locationIds){
 onlyKnown(obs,OBSERVATION_FIELDS,'Observation');
 text(obs.equipmentId,'equipmentId',64);locationOk(obs.locationId,locationIds);
 instant(obs.observedAt,'observedAt');instant(obs.receivedAt,'receivedAt');
 if(!OBSERVATION_SOURCES.includes(obs.source))fail('Unknown observation source');
 text(obs.idempotencyKey,'idempotencyKey',100);text(obs.actor,'actor',100);
 if(typeof obs.correlationId!=='undefined')text(obs.correlationId,'correlationId',100);
 return obs;
}
export function validateAdminCommand(cmd){
 onlyKnown(cmd,ADMIN_COMMAND_FIELDS,'Command');
 text(cmd.equipmentId,'equipmentId',64);text(cmd.actor,'actor',100);text(cmd.idempotencyKey,'idempotencyKey',100);
 if(!Number.isInteger(cmd.expectedVersion)||cmd.expectedVersion<0)fail('expectedVersion must be a non-negative integer');
 if(typeof cmd.status==='undefined'&&typeof cmd.note==='undefined')fail('Command changes nothing');
 if(typeof cmd.status!=='undefined'&&!STATUSES.includes(cmd.status))fail('Unknown equipment status');
 if(typeof cmd.note!=='undefined'&&(typeof cmd.note!=='string'||cmd.note.length>500))fail('Note must be text under 500 characters');
 return cmd;
}
// Administrative edit: bumps version, records lastAdminEditAt, leaves lastVerified and locationId alone.
export function applyAdminCommand(current,cmd,{now=new Date().toISOString()}={}){
 validateAdminCommand(cmd);
 if(cmd.equipmentId!==current.id)fail('Command targets a different item');
 if(current.version!==cmd.expectedVersion)fail('Conflict: equipment changed; reload before saving');
 if(typeof cmd.status!=='undefined'&&cmd.status!==current.status&&!canTransition(current.status,cmd.status))fail(`Transition ${current.status} to ${cmd.status} is not allowed`);
 if(current.status==='retired')fail('Retired equipment cannot be changed');
 const next={...current,version:current.version+1,lastAdminEditAt:instant(now,'now')};
 if(typeof cmd.status!=='undefined')next.status=cmd.status;
 if(typeof cmd.note!=='undefined')next.note=cmd.note;
 const event={schemaVersion:SCHEMA_VERSION,kind:'admin',equipmentId:current.id,actor:cmd.actor,source:'admin',recordedAt:now,correlationId:cmd.correlationId,idempotencyKey:cmd.idempotencyKey,before:{status:current.status,version:current.version},after:{status:next.status,version:next.version}};
 return {equipment:next,event};
}
// Observation: moves lastVerified and locationId only when it is newer than what we hold, so late or replayed data cannot move an item backward.
export function applyObservation(current,obs,locationIds){
 validateObservation(obs,locationIds);
 if(obs.equipmentId!==current.id)fail('Observation targets a different item');
 if(Date.parse(obs.observedAt)>Date.parse(obs.receivedAt))fail('observedAt cannot be after receivedAt');
 const held=current.lastVerified&&Date.parse(current.lastVerified.observedAt);
 if(held!==null&&held!==undefined&&Date.parse(obs.observedAt)<=held)return {equipment:current,applied:false,reason:'older-than-verified-location'};
 return {equipment:{...current,locationId:obs.locationId,lastVerified:{locationId:obs.locationId,observedAt:obs.observedAt,source:obs.source}},applied:true};
}
// Freshness depends only on the last observation, never on administrative edits.
export function freshness(item,now=Date.now(),thresholds=FRESHNESS){
 if(!item.lastVerified)return 'unknown';
 const age=now-Date.parse(item.lastVerified.observedAt);
 if(!Number.isFinite(age))return 'unknown';
 return age<=thresholds.freshMs?'fresh':age<=thresholds.agingMs?'aging':'stale';
}
