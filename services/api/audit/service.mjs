// Audit search and export (SV-012). Read-only: nothing here writes, and the audit tables stay append-only underneath.
// Runs inside an authorization.run() callback, so SV-005 row-level security applies on top of the explicit tenant filters.
import {ApiError} from '../equipment/service.mjs';
import {BadInput,parseFilters,encodeCursor,redactEvent,toCsv,MAX_EXPORT_ROWS} from './rules.mjs';

const TS="to_char(ev.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')";
const SOURCES={
 equipment:{
  select:`SELECT ev.id, ${TS} AS at, ev.kind, ev.actor, ev.source, e.external_id AS equipment_id, NULL::uuid AS request_id, ev.correlation_id, ev.idempotency_key, ev.before_state, ev.after_state, NULL::jsonb AS detail
   FROM equipment_event ev JOIN equipment e ON e.organization_id = ev.organization_id AND e.id = ev.equipment_id`,
  source:'ev.source',equipment:'e.external_id',request:'NULL'
 },
 request:{
  select:`SELECT ev.id, ${TS} AS at, ev.kind, ev.actor, 'request' AS source, e.external_id AS equipment_id, ev.request_id, NULL::text AS correlation_id, NULL::text AS idempotency_key, NULL::jsonb AS before_state, NULL::jsonb AS after_state, ev.detail
   FROM request_event ev LEFT JOIN equipment e ON e.organization_id = ev.organization_id AND e.id = ev.equipment_id`,
  source:"'request'",equipment:'e.external_id',request:'ev.request_id'
 }
};
function shape(row){
 return {id:row.id,stream:row.stream,at:row.at,kind:row.kind,actor:row.actor,source:row.source,equipmentId:row.equipment_id??null,requestId:row.request_id??null,
  correlationId:row.correlation_id??null,idempotencyKey:row.idempotency_key??null,before:row.before_state??null,after:row.after_state??null,detail:row.detail??null};
}
async function fetchEvents(ctx,f,limit,after){
 const s=SOURCES[f.stream];
 const result=await ctx.query(`${s.select}
  WHERE ev.organization_id = $1 AND ($2::text IS NULL OR ev.actor = $2) AND ($3::text IS NULL OR ${s.source} = $3) AND ($4::text IS NULL OR ev.kind = $4)
   AND ($5::text IS NULL OR ${s.equipment} = $5) AND ($6::uuid IS NULL OR ${s.request} = $6)
   AND ($7::timestamptz IS NULL OR ev.recorded_at >= $7) AND ($8::timestamptz IS NULL OR ev.recorded_at < $8)
   AND ($9::timestamptz IS NULL OR (ev.recorded_at, ev.id) < ($9::timestamptz, $10::uuid))
  ORDER BY ev.recorded_at DESC, ev.id DESC LIMIT $11`,
  [ctx.organizationId,f.actor??null,f.source??null,f.kind??null,f.equipment??null,f.request??null,f.from??null,f.to??null,after?.t??null,after?.id??null,limit]);
 return result.rows.map(r=>shape({...r,stream:f.stream}));
}
// Newest first, keyset pagination on (recorded_at, id) with an exact microsecond cursor.
export async function searchEvents(ctx,params){
 let f;try{f=parseFilters(params);}catch(error){throw error instanceof BadInput?new ApiError(400,'invalid_request',error.message):error;}
 const rows=await fetchEvents(ctx,f,f.limit+1,f.cursor);
 const page=rows.slice(0,f.limit),last=page[page.length-1];
 return {items:page,nextCursor:rows.length>f.limit?encodeCursor(last.at,last.id):null};
}
// Export: the same filters, capped, with free text and identifiers redacted. Asking for more than the cap is an error, not a silent cut.
export async function exportEvents(ctx,params){
 let f;try{f=parseFilters(params,{forExport:true});}catch(error){throw error instanceof BadInput?new ApiError(400,'invalid_request',error.message):error;}
 const rows=await fetchEvents(ctx,f,MAX_EXPORT_ROWS+1,undefined);
 if(rows.length>MAX_EXPORT_ROWS)throw new ApiError(422,'export_too_large',`more than ${MAX_EXPORT_ROWS} events match; narrow the filters`);
 const events=rows.map(e=>redactEvent(e,ctx.organizationId));
 return {format:f.format,events,body:f.format==='csv'?toCsv(events):JSON.stringify({events})};
}
