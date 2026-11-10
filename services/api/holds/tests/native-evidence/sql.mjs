// SV-034: statement builders for the native evidence cases. Pure strings; nothing here connects or runs anything.
// Every interpolated value is either a UUID/identifier already validated by the contract or a fixed token produced by this harness,
// and is checked again here before it can reach SQL.
import {validateClearanceInput} from '../../../../../packages/domain/holds/index.js';
import {clearanceRequestHash} from '../../service.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_TEXT=/^[A-Za-z0-9 ._:#/@-]{0,200}$/;     // no quote, backslash or control character can pass
const SAFE_NAME=/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
export class SqlBuildError extends Error {constructor(code){super(code);this.name='SqlBuildError';this.code=code;}}
export const lit=value=>{
  if(typeof value!=='string'||!SAFE_TEXT.test(value))throw new SqlBuildError('unsafe_literal');
  return `'${value}'`;
};
// Function signatures (only ever fixed names from this harness): schema-qualified name plus a type list, nothing else.
export const sigLit=value=>{if(typeof value!=='string'||!/^public\.[a-z_]+\([a-z0-9, ]*\)$/.test(value))throw new SqlBuildError('unsafe_signature');return `'${value}'`;};
export const uuidLit=value=>{if(typeof value!=='string'||!UUID.test(value))throw new SqlBuildError('not_a_uuid');return `'${value}'::uuid`;};
export const ident=value=>{if(typeof value!=='string'||!SAFE_NAME.test(value))throw new SqlBuildError('unsafe_identifier');return value;};

// Opens a transaction for one actor, exactly as the API's authorization.run does: tenant and user come from transaction-local settings.
// SET LOCAL produces no output, so result rows contain only what the cases select.
export function beginAs(contract,actorName){
  const actor=contract.fixture.actors[actorName];
  if(!actor)throw new SqlBuildError('unknown_actor');
  const org=contract.fixture.organizations[actor.organization];
  return `BEGIN;\nSET LOCAL sv.user_id = ${lit(actor.userId)};\nSET LOCAL sv.organization_id = ${lit(org)};`;
}
export const beginAsOrg=(contract,actorName,orgKey)=>{
  const actor=contract.fixture.actors[actorName];if(!actor)throw new SqlBuildError('unknown_actor');
  const org=contract.fixture.organizations[orgKey];if(!org)throw new SqlBuildError('unknown_organization');
  return `BEGIN;\nSET LOCAL sv.user_id = ${lit(actor.userId)};\nSET LOCAL sv.organization_id = ${lit(org)};`;
};

// The same preparation the API performs, so the hash is the one a real request would carry.
export function prepareClear({holdId,reference,observedAt,note},now=Date.now()){
  const body=validateClearanceInput({schemaVersion:1,evidence:{reference,observedAt,...(note!==undefined&&{note})}},{now});
  return Object.freeze({holdId,reference:body.evidence.reference,observedAt:body.evidence.observedAt,note:body.evidence.note??null,hash:clearanceRequestHash(holdId,body)});
}
export function clearCall(p,key){
  return `SELECT public.clear_equipment_hold_with_evidence(${uuidLit(p.holdId)}, ${lit(key)}, ${lit(p.hash)}, ${lit(p.reference)}, ${lit(p.observedAt)}::timestamptz, ${p.note===null?'NULL':lit(p.note)});`;
}
// Transaction left OPEN after the call on purpose: the per-hold advisory lock stays held until COMMIT or ROLLBACK.
export const clearOpen=(contract,actorName,p,key,orgKey)=>`${orgKey?beginAsOrg(contract,actorName,orgKey):beginAs(contract,actorName)}\n${clearCall(p,key)}`;
export const COMMIT='COMMIT;';
export const ROLLBACK='ROLLBACK;';

const wholeNumber=(v,min,max)=>{if(!Number.isInteger(v)||v<min||v>max)throw new SqlBuildError('bad_number');return v;};
export const claimCall=(requestId,line,equipmentUuid,version,actor)=>
  `SELECT public.claim_request_item(${uuidLit(requestId)}, ${wholeNumber(line,1,20)}, ${uuidLit(equipmentUuid)}, ${wholeNumber(version,0,1000000)}, ${lit(actor)});`;
export const actorString=userId=>`user:${userId}`;

// Read-only facts for assertions, run as a given actor.
export const q={
  equipmentByExternalId:(externalId)=>`SELECT id, version FROM equipment WHERE external_id = ${lit(externalId)};`,
  holdState:holdId=>`SELECT active, kind, coalesce(cleared_by, '-') FROM equipment_hold WHERE id = ${uuidLit(holdId)};`,
  evidenceForHold:holdId=>`SELECT id, reference, recorded_by FROM hold_clearance_evidence WHERE hold_id = ${uuidLit(holdId)} ORDER BY id;`,
  receiptsForKey:key=>`SELECT hold_id, evidence_id, actor FROM hold_clearance_receipt WHERE idempotency_key = ${lit(key)} ORDER BY id;`,
  activeHoldKinds:equipmentExternalId=>`SELECT h.kind FROM equipment_hold h JOIN equipment e ON e.id = h.equipment_id AND e.organization_id = h.organization_id WHERE e.external_id = ${lit(equipmentExternalId)} AND h.active ORDER BY h.kind;`,
  assignmentsForEquipment:equipmentUuid=>`SELECT count(*) FROM item_assignment WHERE equipment_id = ${uuidLit(equipmentUuid)} AND active;`,
  tryUpdateEvidence:holdId=>`UPDATE hold_clearance_evidence SET reference = 'TAMPERED' WHERE hold_id = ${uuidLit(holdId)};`,
  tryDeleteReceipt:key=>`DELETE FROM hold_clearance_receipt WHERE idempotency_key = ${lit(key)};`,
  lockWaiters:appName=>`SELECT count(*) FROM pg_stat_activity WHERE application_name = ${lit(appName)} AND datname = current_database() AND state = 'active' AND wait_event_type = 'Lock' AND wait_event = 'advisory';`,
};

// A database error carries a stable code in the message ('sv:wrong_role'); everything else is an unexpected failure.
export const svCode=message=>/sv:([a-z_]+)/.exec(String(message??''))?.[1]??null;
export function parseJsonCell(row){
  try{const v=JSON.parse(row);return v!==null&&typeof v==='object'?v:null;}catch{return null;}
}
