// Hold queries and commands (SV-021). Runs inside an authorization.run() callback like the other services. Placing and
// clearing are database functions, so the lock order, the stacking rule and the role check live next to the data.
import {validateHoldInput,validateRuleInput,summarizeHolds,HOLD_KINDS,HOLD_ERRORS} from '../../../packages/domain/holds/index.js';
import {ApiError} from '../equipment/service.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid=detail=>new ApiError(400,'invalid_request',detail);
const iso=v=>v===null||v===undefined?null:new Date(v).toISOString();
const holdId=id=>{if(!UUID.test(id))throw new ApiError(404,'hold_not_found');return id;};
const shapeHold=r=>({id:r.id,equipmentId:r.equipment_external_id,kind:r.kind,reason:r.reason??null,active:r.active,placedBy:r.placed_by,placedAt:iso(r.placed_at),clearedBy:r.cleared_by??null,clearedAt:iso(r.cleared_at)});
const HOLD_ROWS=`SELECT h.id, e.external_id AS equipment_external_id, h.kind, h.reason, h.active, h.placed_by, h.placed_at, h.cleared_by, h.cleared_at
 FROM equipment_hold h JOIN equipment e ON e.organization_id = h.organization_id AND e.id = h.equipment_id`;
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
