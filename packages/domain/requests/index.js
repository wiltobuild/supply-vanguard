// Request rules (SV-020): a request holds several items, and its summary is derived from the item states, never stored.
export const MAX_ITEMS=20,MAX_NOTE=500;
export const ITEM_STATES=Object.freeze(['open','assigned']);
// Stable codes returned by the database claim function (message 'sv:<code>') and their HTTP meaning.
export const CLAIM_ERRORS=Object.freeze({
 equipment_not_found:404,item_not_found:404,
 item_already_assigned:409,stale_version:409,equipment_already_assigned:409,
 wrong_equipment_type:422,not_assignable:422,
 equipment_on_hold:422   // SV-021: raised by the item_assignment trigger while any hold on the asset is active
});
const fail=m=>{throw new Error(m);};
const text=(v,name,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(`${name} must be non-empty text under ${max} characters`);return v;};
const only=(o,allowed,name)=>{if(!o||typeof o!=='object'||Array.isArray(o))fail(`${name} must be an object`);const extra=Object.keys(o).filter(k=>!allowed.includes(k));if(extra.length)fail(`${name} has unsupported fields: ${extra.join(', ')}`);};
export function validateRequestInput(input){
 only(input,['note','items'],'Request');
 if(typeof input.note!=='undefined'&&(typeof input.note!=='string'||input.note.length>MAX_NOTE))fail(`note must be text under ${MAX_NOTE} characters`);
 if(!Array.isArray(input.items)||input.items.length<1||input.items.length>MAX_ITEMS)fail(`items must list 1 to ${MAX_ITEMS} requested items`);
 const items=input.items.map((item,i)=>{only(item,['equipmentType'],`Item ${i+1}`);return {equipmentType:text(item.equipmentType,`Item ${i+1} equipmentType`,64)};});
 return {note:input.note,items};
}
export function validateClaimInput(input){
 only(input,['equipmentId','expectedVersion'],'Claim');
 text(input.equipmentId,'equipmentId',64);
 if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)fail('expectedVersion must be a non-negative whole number');
 return {equipmentId:input.equipmentId,expectedVersion:input.expectedVersion};
}
export function summarize(items){
 const counts={total:items.length,open:items.filter(i=>i.state==='open').length,assigned:items.filter(i=>i.state==='assigned').length};
 const status=counts.total===0||counts.assigned===0?'open':counts.open===0?'assigned':'partially-assigned';
 return {status,...counts};
}
