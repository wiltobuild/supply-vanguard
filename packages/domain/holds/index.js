// Hold rules (SV-021). Holds stack independently by kind, any active hold blocks assignment, and only the role an
// organization configured for a kind may clear it. No role names or administrator exceptions are built in here.
export const HOLD_KINDS=Object.freeze(['dirty','fault','maintenance','unknown']);
// The existing SV-005 roles (services/api/auth/roles.mjs). A test keeps this list equal to that one.
export const ASSIGNABLE_ROLES=Object.freeze(['viewer','operator','supply_manager','equipment_manager','admin']);
export const MAX_REASON=500;
// Stable codes from the database functions (message 'sv:<code>') and their HTTP meaning.
export const HOLD_ERRORS=Object.freeze({
 equipment_not_found:404,hold_not_found:404,hold_already_cleared:409,no_clearance_rule:422,wrong_role:403
});
const fail=m=>{throw new Error(m);};
const only=(o,allowed,name)=>{if(!o||typeof o!=='object'||Array.isArray(o))fail(`${name} must be an object`);const extra=Object.keys(o).filter(k=>!allowed.includes(k));if(extra.length)fail(`${name} has unsupported fields: ${extra.join(', ')}`);};
export function validateHoldInput(input){
 only(input,['kind','reason'],'Hold');
 if(!HOLD_KINDS.includes(input.kind))fail(`kind must be one of: ${HOLD_KINDS.join(', ')}`);
 if(typeof input.reason!=='undefined'&&(typeof input.reason!=='string'||input.reason.length>MAX_REASON))fail(`reason must be text under ${MAX_REASON} characters`);
 return {kind:input.kind,reason:input.reason};
}
export function validateRuleInput(kind,input){
 if(!HOLD_KINDS.includes(kind))fail(`kind must be one of: ${HOLD_KINDS.join(', ')}`);
 only(input,['role'],'Rule');
 if(!ASSIGNABLE_ROLES.includes(input.role))fail(`role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`);
 return {kind,role:input.role};
}
// An asset is blocked while any hold is active; the active kinds are listed so the cause is visible.
export function summarizeHolds(holds){
 const kinds=HOLD_KINDS.filter(k=>holds.some(h=>h.active&&h.kind===k));
 return {blocked:kinds.length>0,activeKinds:kinds,active:holds.filter(h=>h.active).length,total:holds.length};
}
