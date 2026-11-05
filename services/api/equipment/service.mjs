// Equipment queries and commands (SV-006). Every function runs inside an authorization.run() callback, so all
// statements share one transaction: a change and its audit event commit together or not at all. ctx.query is
// pg-compatible (query(text, params) -> {rows}). Tenant filters are explicit here and row-level security backs them up.
import {STATUSES,validateAdminCommand,applyAdminCommand,applyObservation,SCHEMA_VERSION} from '../../../packages/domain/contracts.js';

export class ApiError extends Error {
 constructor(status,code,detail){super(code);this.name='ApiError';this.status=status;this.code=code;this.detail=detail;}
}
const invalid=detail=>new ApiError(400,'invalid_request',detail);
export const MAX_LIMIT=100,DEFAULT_LIMIT=25;
const iso=v=>v===null||v===undefined?null:new Date(v).toISOString();
const text=(v,name,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw invalid(`${name} must be non-empty text under ${max} characters`);return v;};
const affected=r=>r.rowCount??r.affectedRows??0;
const FROM=`FROM equipment e
 JOIN equipment_type t ON t.organization_id = e.organization_id AND t.id = e.equipment_type_id
 JOIN location l ON l.organization_id = e.organization_id AND l.id = e.location_id
 LEFT JOIN location lv ON lv.organization_id = e.organization_id AND lv.id = e.last_verified_location_id`;
const COLUMNS=`e.id AS uuid, e.external_id, e.name, t.model_kind, l.external_key AS location_key, e.status, e.version, e.note,
 e.last_admin_edit_at, lv.external_key AS verified_location_key, e.last_verified_at, e.last_verified_source, e.provenance`;
// The public record is the SV-001 equipment contract: id is the stable external ID, locations are stable external keys.
export function toRecord(row){
 const record={schemaVersion:SCHEMA_VERSION,id:row.external_id,name:row.name,modelKind:row.model_kind,locationId:row.location_key,status:row.status,version:row.version,
  lastVerified:row.last_verified_at?{locationId:row.verified_location_key,observedAt:iso(row.last_verified_at),source:row.last_verified_source}:null,
  lastAdminEditAt:iso(row.last_admin_edit_at),provenance:row.provenance};
 if(row.note!==null&&row.note!==undefined)record.note=row.note;
 return record;
}
export const encodeCursor=after=>Buffer.from(JSON.stringify({after}),'utf8').toString('base64url');
export function decodeCursor(cursor){
 try{const v=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(typeof v.after==='string'&&v.after.length>0&&v.after.length<=64)return v.after;}catch{}
 throw invalid('cursor is not valid');
}
// Keyset pagination on the unique external ID: stable under inserts and never skips or repeats a row.
export async function listEquipment(ctx,{limit,cursor,status,location,q}={}){
 const n=limit===undefined?DEFAULT_LIMIT:limit;
 if(!Number.isInteger(n)||n<1||n>MAX_LIMIT)throw invalid(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
 if(status!==undefined&&!STATUSES.includes(status))throw invalid('status is not a known equipment status');
 if(location!==undefined)text(location,'location',64);
 if(q!==undefined)text(q,'q',100);
 const after=cursor===undefined?null:decodeCursor(cursor);
 const pattern=q===undefined?null:`%${q.replace(/[\\%_]/g,'\\$&')}%`;
 const result=await ctx.query(`SELECT ${COLUMNS} ${FROM}
  WHERE e.organization_id = $1 AND ($2::text IS NULL OR e.status = $2) AND ($3::text IS NULL OR l.external_key = $3)
   AND ($4::text IS NULL OR e.name ILIKE $4 ESCAPE '\\' OR e.external_id ILIKE $4 ESCAPE '\\') AND ($5::text IS NULL OR e.external_id > $5)
  ORDER BY e.external_id LIMIT $6`,[ctx.organizationId,status??null,location??null,pattern,after,n+1]);
 const page=result.rows.slice(0,n);
 return {items:page.map(toRecord),nextCursor:result.rows.length>n?encodeCursor(page[n-1].external_id):null};
}
async function load(ctx,externalId,{lock=false}={}){
 text(externalId,'equipment id',64);
 // A joined locking read can lose a row during PostgreSQL's EvalPlanQual recheck when the
 // lock holder changes location_id. Lock the tenant's equipment alone, then use a fresh
 // READ COMMITTED statement snapshot for the joins (also used by observation commands).
 if(lock){
  const locked=await ctx.query('SELECT id FROM equipment WHERE organization_id = $1 AND external_id = $2 FOR UPDATE',[ctx.organizationId,externalId]);
  if(!locked.rows.length)throw new ApiError(404,'not_found');
 }
 const result=await ctx.query(`SELECT ${COLUMNS} ${FROM} WHERE e.organization_id = $1 AND e.external_id = $2`,[ctx.organizationId,externalId]);
 if(!result.rows.length)throw new ApiError(404,'not_found');
 return result.rows[0];
}
export async function getEquipment(ctx,externalId){return toRecord(await load(ctx,externalId));}
const ADMIN_BODY=['expectedVersion','status','note'];
const eventKey=(kind,key)=>`${kind}:${key}`;
const conflictBody=record=>({current:{version:record.version,status:record.status,lastAdminEditAt:record.lastAdminEditAt}});
async function saveReceipt(ctx,row,key,request,result,correlationId){
 try{
  await ctx.query(`INSERT INTO equipment_command_receipt
   (organization_id, equipment_id, actor_id, idempotency_key, request, result, correlation_id)
   VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
   [ctx.organizationId,row.uuid,ctx.userId,key,JSON.stringify(request),JSON.stringify(result),correlationId??null]);
 }catch(error){
  if(error?.code==='23505')throw new ApiError(409,'idempotency_key_reused');
  throw error;
 }
}
function mapDomainError(error){
 if(error instanceof ApiError)return error;
 if(/^Conflict/.test(error.message))return new ApiError(409,'version_conflict');
 if(/not allowed|Retired equipment|changes nothing/.test(error.message))return new ApiError(422,'transition_not_allowed',error.message);
 return invalid(error.message);
}
// Administrative edit: lock the row, check the version, apply the SV-001 rules, then write the row and its audit event.
export async function updateEquipment(ctx,externalId,body,{idempotencyKey,correlationId}={}){
 if(!body||typeof body!=='object'||Array.isArray(body))throw invalid('body must be a JSON object');
 const extra=Object.keys(body).filter(k=>!ADMIN_BODY.includes(k));
 if(extra.length)throw invalid(`unsupported fields: ${extra.join(', ')}`);
 text(idempotencyKey,'Idempotency-Key',100);
 if(!Number.isInteger(body.expectedVersion)||body.expectedVersion<0)throw invalid('expectedVersion must be a non-negative whole number');
 // Fixed field order normalizes JSON member order, while retaining optional-field presence.
 const request={expectedVersion:body.expectedVersion};
 for(const field of ['status','note'])if(Object.hasOwn(body,field)){
  if(field==='status'&&!STATUSES.includes(body[field]))throw invalid('Unknown equipment status');
  if(field==='note'&&(typeof body[field]!=='string'||body[field].length>500))throw invalid('Note must be text under 500 characters');
  request[field]=body[field];
 }
 const row=await load(ctx,externalId,{lock:true}),current=toRecord(row),key=eventKey('admin',idempotencyKey);
 // RLS exposes only the verified actor's receipts under their current equipment:write permission.
 // Check AFTER the row lock, BEFORE the version: an overlapping identical command may just have committed.
 const prior=await ctx.query(`SELECT equipment_id, request, result FROM equipment_command_receipt
  WHERE organization_id = $1 AND actor_id = $2 AND idempotency_key = $3`,[ctx.organizationId,ctx.userId,key]);
 if(prior.rows.length){
  const p=prior.rows[0],same=p.equipment_id===row.uuid&&Object.keys(p.request).length===Object.keys(request).length&&Object.keys(request).every(k=>Object.hasOwn(p.request,k)&&p.request[k]===request[k]);
  if(!same)throw new ApiError(409,'idempotency_key_reused');
  return {...p.result,changed:false,replayed:true};
 }
 if(current.version!==body.expectedVersion)throw Object.assign(new ApiError(409,'version_conflict'),conflictBody(current));
 if((body.status===undefined||body.status===current.status)&&(body.note===undefined||body.note===(current.note??undefined))){
  const result={record:current,changed:false,replayed:false};
  await saveReceipt(ctx,row,key,request,result,correlationId);
  return result;
 }
 const cmd={schemaVersion:SCHEMA_VERSION,equipmentId:current.id,expectedVersion:body.expectedVersion,actor:`user:${ctx.userId}`,idempotencyKey,...(body.status!==undefined&&{status:body.status}),...(body.note!==undefined&&{note:body.note}),...(correlationId&&{correlationId})};
 let result;
 try{validateAdminCommand(cmd);result=applyAdminCommand(current,cmd);}catch(error){throw mapDomainError(error);}
 const next=result.equipment;
 await ctx.query('UPDATE equipment SET status = $3, note = $4, version = $5, last_admin_edit_at = $6 WHERE organization_id = $1 AND id = $2',[ctx.organizationId,row.uuid,next.status,next.note??null,next.version,next.lastAdminEditAt]);
 const e=result.event;
 // Plain INSERT, not ON CONFLICT: Postgres also needs SELECT rights on equipment_event for ON CONFLICT, and operators
 // cannot read the audit log. A reused key raises a unique violation, and throwing rolls back the equipment update above too.
 try{
  await ctx.query(`INSERT INTO equipment_event (organization_id, equipment_id, kind, actor, source, correlation_id, idempotency_key, before_state, after_state)
   VALUES ($1, $2, 'admin', $3, 'admin', $4, $5, $6::jsonb, $7::jsonb)`,
   [ctx.organizationId,row.uuid,e.actor,correlationId??null,key,JSON.stringify({...e.before,note:current.note??null}),JSON.stringify({...e.after,note:next.note??null})]);
 }catch(error){
  if(error?.code==='23505')throw new ApiError(409,'idempotency_key_reused');
  throw error;
 }
 const response={record:next,changed:true,replayed:false};
 await saveReceipt(ctx,row,key,request,response,correlationId);
 return response;
}
const OBS_BODY=['locationId','observedAt','source'];
// Observation: always recorded in the append-only history; it moves the item's verified location only if it is newer.
export async function recordObservation(ctx,externalId,body,{idempotencyKey,correlationId}={}){
 if(!body||typeof body!=='object'||Array.isArray(body))throw invalid('body must be a JSON object');
 const extra=Object.keys(body).filter(k=>!OBS_BODY.includes(k));
 if(extra.length)throw invalid(`unsupported fields: ${extra.join(', ')}`);
 text(idempotencyKey,'Idempotency-Key',100);
 const row=await load(ctx,externalId,{lock:true}),current=toRecord(row);
 const locations=await ctx.query('SELECT id, external_key FROM location WHERE organization_id = $1',[ctx.organizationId]);
 const byKey=new Map(locations.rows.map(l=>[l.external_key,l.id]));
 const obs={schemaVersion:SCHEMA_VERSION,equipmentId:current.id,locationId:body.locationId,observedAt:body.observedAt,receivedAt:new Date().toISOString(),source:body.source,actor:`user:${ctx.userId}`,idempotencyKey,...(correlationId&&{correlationId})};
 let outcome;
 try{outcome=applyObservation(current,obs,[...byKey.keys()]);}catch(error){throw mapDomainError(error);}
 const insertedObs=await ctx.query(`INSERT INTO equipment_observation (organization_id, equipment_id, location_id, observed_at, received_at, source, actor, correlation_id, idempotency_key)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
  [ctx.organizationId,row.uuid,byKey.get(obs.locationId),obs.observedAt,obs.receivedAt,obs.source,obs.actor,correlationId??null,idempotencyKey]);
 if(affected(insertedObs)!==1)return {record:current,applied:false,reason:'duplicate-idempotency-key'};
 if(!outcome.applied)return {record:current,applied:false,reason:outcome.reason};
 const next=outcome.equipment;
 await ctx.query('UPDATE equipment SET location_id = $3, last_verified_location_id = $3, last_verified_at = $4, last_verified_source = $5 WHERE organization_id = $1 AND id = $2',[ctx.organizationId,row.uuid,byKey.get(next.locationId),next.lastVerified.observedAt,next.lastVerified.source]);
 await ctx.query(`INSERT INTO equipment_event (organization_id, equipment_id, kind, actor, source, correlation_id, idempotency_key, before_state, after_state)
  VALUES ($1, $2, 'observation', $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
  [ctx.organizationId,row.uuid,obs.actor,obs.source,correlationId??null,eventKey('observation',idempotencyKey),JSON.stringify({locationId:current.locationId,lastVerified:current.lastVerified,version:current.version}),JSON.stringify({locationId:next.locationId,lastVerified:next.lastVerified,version:next.version})]);
 return {record:next,applied:true};
}
