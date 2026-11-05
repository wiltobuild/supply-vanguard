// Request queries and commands (SV-020). Run inside an authorization.run() callback like the equipment service,
// so everything shares one tenant-scoped transaction. The claim itself is one database function (claim_request_item).
import {validateRequestInput,validateClaimInput,summarize,CLAIM_ERRORS,MAX_ITEMS} from '../../../packages/domain/requests/index.js';
import {ApiError} from '../equipment/service.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid=detail=>new ApiError(400,'invalid_request',detail);
const iso=v=>v===null||v===undefined?null:new Date(v).toISOString();
const requestId=id=>{if(!UUID.test(id))throw new ApiError(404,'not_found');return id;};
export const MAX_LIMIT=100,DEFAULT_LIMIT=25;
function shape(request,rows){
 const items=rows.map(r=>({lineNo:r.line_no,equipmentType:r.model_kind,state:r.state,assignment:r.assignment_id?{id:r.assignment_id,equipmentId:r.equipment_external_id,assignedBy:r.assigned_by,assignedAt:iso(r.assigned_at)}:null}));
 return {id:request.id,requestedBy:request.requested_by,note:request.note??null,createdAt:iso(request.created_at),summary:summarize(items),items};
}
const ITEM_ROWS=`SELECT i.line_no, t.model_kind, i.state, a.id AS assignment_id, e.external_id AS equipment_external_id, a.assigned_by, a.assigned_at
 FROM request_item i
 JOIN equipment_type t ON t.organization_id = i.organization_id AND t.id = i.equipment_type_id
 LEFT JOIN item_assignment a ON a.organization_id = i.organization_id AND a.request_item_id = i.id AND a.active
 LEFT JOIN equipment e ON e.organization_id = a.organization_id AND e.id = a.equipment_id
 WHERE i.organization_id = $1 AND i.request_id = $2 ORDER BY i.line_no`;
export async function getRequest(ctx,id){
 requestId(id);
 const r=await ctx.query('SELECT id, requested_by, note, created_at FROM request WHERE organization_id = $1 AND id = $2',[ctx.organizationId,id]);
 if(!r.rows.length)throw new ApiError(404,'not_found');
 return shape(r.rows[0],(await ctx.query(ITEM_ROWS,[ctx.organizationId,id])).rows);
}
export async function createRequest(ctx,body){
 let input;
 try{input=validateRequestInput(body);}catch(error){throw invalid(error.message);}
 const types=await ctx.query('SELECT id, model_kind FROM equipment_type WHERE organization_id = $1',[ctx.organizationId]);
 const byKind=new Map(types.rows.map(t=>[t.model_kind,t.id]));
 for(const [i,item] of input.items.entries())if(!byKind.has(item.equipmentType))throw invalid(`Item ${i+1}: unknown equipment type`);
 const actor=`user:${ctx.userId}`;
 const made=await ctx.query('INSERT INTO request (organization_id, requested_by, note) VALUES ($1, $2, $3) RETURNING id',[ctx.organizationId,actor,input.note??null]);
 const id=made.rows[0].id;
 for(const [i,item] of input.items.entries())await ctx.query('INSERT INTO request_item (organization_id, request_id, line_no, equipment_type_id) VALUES ($1, $2, $3, $4)',[ctx.organizationId,id,i+1,byKind.get(item.equipmentType)]);
 await ctx.query(`INSERT INTO request_event (organization_id, request_id, kind, actor, detail) VALUES ($1, $2, 'request-created', $3, $4::jsonb)`,[ctx.organizationId,id,actor,JSON.stringify({items:input.items.length})]);
 return getRequest(ctx,id);
}
// Keyset pagination on (created_at, id): stable while new requests arrive.
export async function listRequests(ctx,{limit,cursor}={}){
 const n=limit===undefined?DEFAULT_LIMIT:limit;
 if(!Number.isInteger(n)||n<1||n>MAX_LIMIT)throw invalid(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
 let after=null;
 if(cursor!==undefined){try{const v=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(typeof v.t!=='string'||!Number.isFinite(Date.parse(v.t))||!UUID.test(v.id))throw new Error();after=v;}catch{throw invalid('cursor is not valid');}}
 const page=await ctx.query(`SELECT id, requested_by, note, created_at FROM request
  WHERE organization_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid)) ORDER BY created_at, id LIMIT $4`,[ctx.organizationId,after?.t??null,after?.id??null,n+1]);
 const rows=page.rows.slice(0,n),items=[];
 for(const row of rows)items.push(shape(row,(await ctx.query(ITEM_ROWS,[ctx.organizationId,row.id])).rows));
 const last=rows[rows.length-1];
 return {items,nextCursor:page.rows.length>n?Buffer.from(JSON.stringify({t:new Date(last.created_at).toISOString(),id:last.id}),'utf8').toString('base64url'):null};
}
// Claim: look up the asset by its external ID, then let the database function decide atomically.
export async function claimItem(ctx,id,lineText,body){
 requestId(id);
 const line=/^\d+$/.test(lineText)?Number(lineText):NaN;
 if(!Number.isInteger(line)||line<1||line>MAX_ITEMS)throw new ApiError(404,'not_found');
 let input;
 try{input=validateClaimInput(body);}catch(error){throw invalid(error.message);}
 const eq=await ctx.query('SELECT id FROM equipment WHERE organization_id = $1 AND external_id = $2',[ctx.organizationId,input.equipmentId]);
 if(!eq.rows.length)throw new ApiError(404,'equipment_not_found');
 let outcome;
 try{outcome=(await ctx.query('SELECT public.claim_request_item($1, $2, $3, $4, $5) AS result',[id,line,eq.rows[0].id,input.expectedVersion,`user:${ctx.userId}`])).rows[0].result;}
 catch(error){
  const code=/sv:([a-z_]+)/.exec(error?.message??'')?.[1];
  if(code&&Object.hasOwn(CLAIM_ERRORS,code))throw new ApiError(CLAIM_ERRORS[code],code);
  throw error;
 }
 return {request:await getRequest(ctx,id),replayed:Boolean(outcome.replayed)};
}
