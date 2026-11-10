// Hold rules (SV-021). Holds stack independently by kind, any active hold blocks assignment, and only the role an
// organization configured for a kind may clear it. No role names or administrator exceptions are built in here.
export const HOLD_KINDS=Object.freeze(['dirty','fault','maintenance','unknown']);
// The existing SV-005 roles (services/api/auth/roles.mjs). A test keeps this list equal to that one.
export const ASSIGNABLE_ROLES=Object.freeze(['viewer','operator','supply_manager','equipment_manager','admin']);
export const MAX_REASON=500;
// Stable codes from the database functions (message 'sv:<code>') and their HTTP meaning.
export const HOLD_ERRORS=Object.freeze({
 equipment_not_found:404,hold_not_found:404,hold_already_cleared:409,no_clearance_rule:422,wrong_role:403,
 idempotency_conflict:409,evidence_invalid:422
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

// ---- Clearance evidence (SV-031) ----
// Supplied evidence is a RECORDED ASSERTION. Nothing here says it is sufficient to clear a hold: that policy is an open owner decision.
// Error text below is fixed. It never repeats a field name, value or other text the caller sent.
export const EVIDENCE_SCHEMA_VERSION=1;
export const EVIDENCE_LIMITS=Object.freeze({reference:128,note:500,idempotencyKey:88});
// How a cleared hold was cleared. Legacy clearances (the original /clear route) carry NO evidence and are never read as having it.
export const CLEARANCE_BASIS=Object.freeze({evidence:'evidence-v1',legacy:'legacy-no-additional-evidence'});
const REFERENCE=/^[A-Za-z0-9][A-Za-z0-9 ._:#/-]{0,127}$/;
const OBSERVED_AT=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d{1,6})?Z$/;
const CONTROL=/[\u0000-\u001f\u007f]/;
const KEY=/^[A-Za-z0-9._:-]{1,88}$/;
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const exactly=(o,allowed)=>Object.keys(o).every(k=>allowed.includes(k));
export function validateIdempotencyKey(key){
 if(typeof key!=='string'||!KEY.test(key))fail(`Idempotency-Key is required: 1 to ${EVIDENCE_LIMITS.idempotencyKey} letters, digits, dot, dash, underscore or colon`);
 return key;
}
// Body: {schemaVersion: 1, evidence: {reference, observedAt, note?}}. Anything else, including actor, tenant, role or time fields, is refused.
export function validateClearanceInput(body,{now=Date.now()}={}){
 if(!plain(body)||!exactly(body,['schemaVersion','evidence']))fail('Clearance body must contain only schemaVersion and evidence');
 if(body.schemaVersion!==EVIDENCE_SCHEMA_VERSION)fail(`schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
 const e=body.evidence;
 if(!plain(e)||!exactly(e,['reference','observedAt','note']))fail('evidence must contain only reference, observedAt and an optional note');
 if(typeof e.reference!=='string'||!REFERENCE.test(e.reference))fail(`evidence.reference is required: 1 to ${EVIDENCE_LIMITS.reference} letters, digits, spaces or . _ : # / -`);
 const m=typeof e.observedAt==='string'?OBSERVED_AT.exec(e.observedAt):null;
 if(!m)fail('evidence.observedAt is required as a UTC timestamp like 2026-11-10T09:30:00Z');
 const ms=Date.parse(e.observedAt),iso=Number.isFinite(ms)?new Date(ms).toISOString():'';
 if(!iso||iso.slice(0,19)!==m[1])fail('evidence.observedAt is not a real date and time');
 if(ms>now)fail('evidence.observedAt must not be in the future');
 if(e.note!==undefined&&(typeof e.note!=='string'||e.note.length>EVIDENCE_LIMITS.note||CONTROL.test(e.note)))fail(`evidence.note must be single-line text up to ${EVIDENCE_LIMITS.note} characters`);
 return {schemaVersion:EVIDENCE_SCHEMA_VERSION,evidence:{reference:e.reference,observedAt:iso,...(e.note!==undefined&&{note:e.note})}};
}
