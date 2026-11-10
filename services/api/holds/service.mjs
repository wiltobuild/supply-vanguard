// Hold queries and commands (SV-021). Runs inside an authorization.run() callback like the other services. Placing and
// clearing are database functions, so the lock order, the stacking rule and the role check live next to the data.
import {createHash} from 'node:crypto';
import {validateHoldInput,validateRuleInput,summarizeHolds,validateClearanceInput,validateIdempotencyKey,HOLD_KINDS,HOLD_ERRORS,CLEARANCE_BASIS,EVIDENCE_SCHEMA_VERSION} from '../../../packages/domain/holds/index.js';
import {ApiError} from '../equipment/service.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid=detail=>new ApiError(400,'invalid_request',detail);
const iso=v=>v===null||v===undefined?null:new Date(v).toISOString();
const holdId=id=>{if(!UUID.test(id))throw new ApiError(404,'hold_not_found');return id;};
// clearance is null while a hold is active. A hold cleared with evidence (SV-031) shows it; one cleared the original way shows
// basis legacy-no-additional-evidence and evidence null. A placement reason is never evidence.
const shapeClearance=r=>r.active?null:r.evidence_id
 ?{basis:CLEARANCE_BASIS.evidence,evidence:{id:r.evidence_id,schemaVersion:r.evidence_schema_version,reference:r.evidence_reference,observedAt:iso(r.evidence_observed_at),note:r.evidence_note??null,recordedBy:r.evidence_recorded_by,recordedAt:iso(r.evidence_recorded_at)}}
 :{basis:CLEARANCE_BASIS.legacy,evidence:null};
const shapeHold=r=>({id:r.id,equipmentId:r.equipment_external_id,kind:r.kind,reason:r.reason??null,active:r.active,placedBy:r.placed_by,placedAt:iso(r.placed_at),clearedBy:r.cleared_by??null,clearedAt:iso(r.cleared_at),clearance:shapeClearance(r)});
const HOLD_ROWS=`SELECT h.id, e.external_id AS equipment_external_id, h.kind, h.reason, h.active, h.placed_by, h.placed_at, h.cleared_by, h.cleared_at,
 ev.id AS evidence_id, ev.schema_version AS evidence_schema_version, ev.reference AS evidence_reference, ev.observed_at AS evidence_observed_at,
 ev.note AS evidence_note, ev.recorded_by AS evidence_recorded_by, ev.recorded_at AS evidence_recorded_at
 FROM equipment_hold h JOIN equipment e ON e.organization_id = h.organization_id AND e.id = h.equipment_id
 LEFT JOIN hold_clearance_evidence ev ON ev.organization_id = h.organization_id AND ev.hold_id = h.id`;
async function equipmentUuid(ctx,externalId){
 if(typeof externalId!=='string'||!externalId||externalId.length>64)throw new ApiError(404,'equipment_not_found');
 const r=await ctx.query('SELECT id FROM equipment WHERE organization_id = $1 AND external_id = $2',[ctx.organizationId,externalId]);
 if(!r.rows.length)throw new ApiError(404,'equipment_not_found');
 return r.rows[0].id;
}
const mapDbError=error=>{
 const code=/sv:([a-z_]+)/.exec(error?.message??'')?.[1];
 return code&&Object.hasOwn(HOLD_ERRORS,code)?new ApiError(HOLD_ERRORS[code],code):error;
};
export async function listHolds(ctx,externalId,{state='all'}={}){
 if(!['all','active','cleared'].includes(state))throw invalid('state must be all, active or cleared');
 const uuid=await equipmentUuid(ctx,externalId);
 const r=await ctx.query(`${HOLD_ROWS} WHERE h.organization_id = $1 AND h.equipment_id = $2 ORDER BY h.placed_at, h.id`,[ctx.organizationId,uuid]);
 const all=r.rows.map(shapeHold);
 return {equipmentId:externalId,summary:summarizeHolds(all),holds:state==='all'?all:all.filter(h=>h.active===(state==='active'))};
}
export async function placeHold(ctx,externalId,body){
 let input;try{input=validateHoldInput(body);}catch(error){throw invalid(error.message);}
 const uuid=await equipmentUuid(ctx,externalId);
 let outcome;
 try{outcome=(await ctx.query('SELECT public.place_equipment_hold($1, $2, $3, $4) AS result',[uuid,input.kind,input.reason??null,`user:${ctx.userId}`])).rows[0].result;}
 catch(error){throw mapDbError(error);}
 const hold=(await ctx.query(`${HOLD_ROWS} WHERE h.organization_id = $1 AND h.id = $2`,[ctx.organizationId,outcome.holdId])).rows[0];
 return {hold:shapeHold(hold),placed:outcome.placed,...(await listHolds(ctx,externalId,{state:'active'}))};
}
export async function clearHold(ctx,id){
 holdId(id);
 try{await ctx.query('SELECT public.clear_equipment_hold($1, $2)',[id,`user:${ctx.userId}`]);}
 catch(error){throw mapDbError(error);}
 const hold=(await ctx.query(`${HOLD_ROWS} WHERE h.organization_id = $1 AND h.id = $2`,[ctx.organizationId,id])).rows[0];
 return {hold:shapeHold(hold),...(await listHolds(ctx,hold.equipment_external_id,{state:'active'}))};
}
// Clear a hold WITH evidence (SV-031). The actor and the time are the authenticated session and the database clock, never the request.
// Clearance, evidence and the retry receipt commit together or not at all (one database function). An exact retry returns the original
// result; a changed payload, or a key someone else used, is the same 409 idempotency_conflict.
export const clearanceRequestHash=(holdId,input)=>createHash('sha256').update(JSON.stringify(['hold-clearance',EVIDENCE_SCHEMA_VERSION,String(holdId).toLowerCase(),input.evidence.reference,input.evidence.observedAt,input.evidence.note??null])).digest('hex');
export async function clearHoldWithEvidence(ctx,id,body,{idempotencyKey}={}){
 holdId(id);
 let input,key;
 try{key=validateIdempotencyKey(idempotencyKey);input=validateClearanceInput(body);}catch(error){throw invalid(error.message);}
 let outcome;
 try{outcome=(await ctx.query('SELECT public.clear_equipment_hold_with_evidence($1, $2, $3, $4, $5::timestamptz, $6) AS result',[id,key,clearanceRequestHash(id,input),input.evidence.reference,input.evidence.observedAt,input.evidence.note??null])).rows[0].result;}
 catch(error){throw mapDbError(error);}
 const hold=(await ctx.query(`${HOLD_ROWS} WHERE h.organization_id = $1 AND h.id = $2`,[ctx.organizationId,id])).rows[0];
 return {hold:shapeHold(hold),replayed:Boolean(outcome.replayed),...(await listHolds(ctx,hold.equipment_external_id,{state:'active'}))};
}
export async function listRules(ctx){
 const r=await ctx.query('SELECT kind, role FROM hold_clearance_rule WHERE organization_id = $1',[ctx.organizationId]);
 const byKind=new Map(r.rows.map(x=>[x.kind,x.role]));
 return {rules:HOLD_KINDS.map(kind=>({kind,role:byKind.get(kind)??null}))};
}
export async function setRule(ctx,kind,body){
 let input;try{input=validateRuleInput(kind,body);}catch(error){throw invalid(error.message);}
 await ctx.query(`INSERT INTO hold_clearance_rule (organization_id, kind, role) VALUES ($1, $2, $3)
  ON CONFLICT (organization_id, kind) DO UPDATE SET role = EXCLUDED.role`,[ctx.organizationId,input.kind,input.role]);
 return listRules(ctx);
}
