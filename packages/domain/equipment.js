export const STATUSES=Object.freeze(['available','in-use','cleaning','maintenance','retired']);
export function validateEquipment(item,roomIds){
 if(!item||typeof item.id!=='string'||!item.id||typeof item.name!=='string'||!item.name)throw new Error('Equipment ID and name are required');
 if(!STATUSES.includes(item.status))throw new Error('Unknown equipment status');
 if(!roomIds.includes(item.roomId))throw new Error('Unknown room');
 if(!Number.isInteger(item.version)||item.version<0)throw new Error('Invalid equipment version');
 return item;
}
// Version checks protect this demo adapter from stale edits. Production must enforce them on the server.
export function updateEquipment(current,patch,{expectedVersion,actor,roomIds,now=new Date().toISOString()}){
 if(current.version!==expectedVersion)throw new Error('Conflict: equipment changed; reload before saving');
 if(!actor)throw new Error('Actor is required');
 if(current.status==='retired')throw new Error('Retired equipment cannot be changed through normal operations');
 const keys=Object.keys(patch);if(keys.some(k=>!['roomId','status','note'].includes(k)))throw new Error('Unsupported field');
 if(typeof patch.note!=='undefined'&&(typeof patch.note!=='string'||patch.note.length>500))throw new Error('Note must be text under 500 characters');
 const next=validateEquipment({...current,...patch,version:current.version+1,lastSeenAt:now},roomIds);
 const event={id:globalThis.crypto.randomUUID(),equipmentId:current.id,actor,at:now,source:'manual-demo',before:{roomId:current.roomId,status:current.status,version:current.version},after:{roomId:next.roomId,status:next.status,version:next.version},note:patch.note||''};
 return {equipment:next,event};
}
export function isStale(item,now=Date.now(),maxAgeMs=30*60*1000){const at=Date.parse(item.lastSeenAt);return !Number.isFinite(at)||now-at>maxAgeMs;}
