// Use inside the existing authorization.run transaction; no new roles, tables or clearance policy.
import {ApiError,getEquipment,listEquipment,toRecord,decodeCursor,encodeCursor,updateEquipment} from '../equipment/service.mjs';
import {searchEvents} from '../audit/service.mjs';
import {canTransition} from '../../../packages/domain/contracts.js';

const invalid=detail=>new ApiError(400,'invalid_request',detail);
export const ACTIONS=Object.freeze(['start-cleaning','start-maintenance','record-service']);
export async function serviceEquipment(ctx,id,body,{idempotencyKey,correlationId}={}){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['action','expectedVersion','note'].includes(k)))throw invalid('Expected action, expectedVersion and optional note only');
 if(!ACTIONS.includes(body.action))throw invalid('Unknown service action; readiness clearance is not supported');
 if(typeof idempotencyKey!=='string'||!idempotencyKey.trim()||idempotencyKey.length>88)throw invalid('Idempotency-Key must be non-empty text up to 88 characters');
 if(typeof id!=='string'||!id.trim()||id.length>64)throw invalid('Invalid equipment id');
 if(!Number.isInteger(body.expectedVersion)||body.expectedVersion<0)throw invalid('expectedVersion must be a non-negative whole number');
 if(body.note!==undefined&&(typeof body.note!=='string'||body.note.length>500))throw invalid('Note must be text up to 500 characters');
 if(body.action==='record-service'&&!body.note?.trim())throw invalid('A service entry needs a note');
 // Same row/lock order as equipment updates and request assignments. Hold it through receipt, audit and commit.
 const lock=await ctx.query('SELECT id FROM equipment WHERE organization_id = $1 AND external_id = $2 FOR UPDATE',[ctx.organizationId,id]);
 if(!lock.rows.length)throw new ApiError(404,'not_found');
 const current=await getEquipment(ctx,id),key=`maintenance:${idempotencyKey}`;
 const request={expectedVersion:body.expectedVersion};
 if(body.action!=='record-service')request.status=body.action==='start-cleaning'?'cleaning':'maintenance';
 if(body.note!==undefined)request.note=body.note;
 // Delegate exact-body/target/actor replay validation to the merged receipt implementation, even if state moved on.
 const prior=await ctx.query('SELECT equipment_id FROM equipment_command_receipt WHERE organization_id = $1 AND actor_id = $2 AND idempotency_key = $3',[ctx.organizationId,ctx.userId,`admin:${key}`]);
 if(!prior.rows.length){
  if(current.version!==body.expectedVersion)throw Object.assign(new ApiError(409,'version_conflict'),{current:{version:current.version,status:current.status,lastAdminEditAt:current.lastAdminEditAt}});
  if(body.action==='record-service'){
   if(!['cleaning','maintenance'].includes(current.status))throw new ApiError(422,'transition_not_allowed','Service notes require a cleaning or maintenance status');
  }else if(!['available','in-use'].includes(current.status)||!canTransition(current.status,request.status)){
   throw new ApiError(422,'transition_not_allowed','Existing unavailable status is preserved; changing or clearing overlapping holds requires the separate hold policy');
  }
 }
 // A service entry changes only the administrative note. It cannot release, relocate or refresh an asset.
 return updateEquipment(ctx,id,request,{idempotencyKey:key,correlationId});
}

export async function serviceHistory(ctx,id,params=new URLSearchParams()){
 await getEquipment(ctx,id); // Guessed IDs remain tenant-scoped, including an empty history.
 for(const key of params.keys())if(!['limit','cursor'].includes(key))throw invalid(`unsupported parameter: ${key}`);
 const filters=new URLSearchParams(params);filters.set('stream','equipment');filters.set('kind','admin');filters.set('equipment',id);
 return searchEvents(ctx,filters);
}

export async function searchEquipment(ctx,params=new URLSearchParams()){
 for(const key of params.keys())if(!['view','limit','cursor','q','location'].includes(key))throw invalid(`unsupported parameter: ${key}`);
 const view=params.get('view')??'cleaning',raw=params.get('limit'),limit=raw===null?25:Number(raw);
 if(!['all','cleaning','maintenance','ready'].includes(view))throw invalid('Unknown equipment view');
 if(raw!==null&&!/^\d+$/.test(raw)||!Number.isInteger(limit)||limit<1||limit>100)throw invalid('limit must be a whole number from 1 to 100');
 const options={limit,cursor:params.get('cursor')??undefined,q:params.get('q')??undefined,location:params.get('location')??undefined};
 if(view!=='ready')return listEquipment(ctx,{...options,...(view!=='all'&&{status:view})});
 for(const [name,max] of [['q',100],['location',64]])if(options[name]!==undefined&&(!options[name].trim()||options[name].length>max))throw invalid(`Invalid ${name}`);
 const after=options.cursor===undefined?null:decodeCursor(options.cursor),pattern=options.q===undefined?null:`%${options.q.replace(/[\\%_]/g,'\\$&')}%`;
 // Filter BEFORE pagination, in one SQL snapshot. Assignments and independent holds do not change status/version.
 const result=await ctx.query(`SELECT e.external_id, e.name, t.model_kind, l.external_key AS location_key, e.status, e.version, e.note,
  e.last_admin_edit_at, lv.external_key AS verified_location_key, e.last_verified_at, e.last_verified_source, e.provenance
  FROM equipment e
  JOIN equipment_type t ON t.organization_id = e.organization_id AND t.id = e.equipment_type_id
  JOIN location l ON l.organization_id = e.organization_id AND l.id = e.location_id
  LEFT JOIN location lv ON lv.organization_id = e.organization_id AND lv.id = e.last_verified_location_id
  WHERE e.organization_id = $1 AND e.status = 'available'
   AND NOT EXISTS (SELECT 1 FROM item_assignment a WHERE a.organization_id = e.organization_id AND a.equipment_id = e.id AND a.active)
   AND NOT EXISTS (SELECT 1 FROM equipment_hold h WHERE h.organization_id = e.organization_id AND h.equipment_id = e.id AND h.active)
   AND ($2::text IS NULL OR l.external_key = $2)
   AND ($3::text IS NULL OR e.name ILIKE $3 ESCAPE '\\' OR e.external_id ILIKE $3 ESCAPE '\\')
   AND ($4::text IS NULL OR e.external_id > $4)
  ORDER BY e.external_id LIMIT $5`,[ctx.organizationId,options.location??null,pattern,after,limit+1]);
 const page=result.rows.slice(0,limit);
 return {items:page.map(toRecord),nextCursor:result.rows.length>limit?encodeCursor(page.at(-1).external_id):null};
}
