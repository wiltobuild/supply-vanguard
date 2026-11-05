// Pure audit rules (SV-012): filter validation, exact-microsecond cursors, redaction for export, CSV with formula-injection protection.
// No database or HTTP here, so everything is testable in Node.
import {createHash} from 'node:crypto';
export const STREAMS=Object.freeze(['equipment','request']);
export const KINDS=Object.freeze({equipment:['admin','observation'],request:['request-created','item-claimed']});
export const MAX_LIMIT=100,DEFAULT_LIMIT=25,MAX_EXPORT_ROWS=5000;
export class BadInput extends Error{constructor(message){super(message);this.name='BadInput';}}
const bad=m=>{throw new BadInput(m);};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/;
const CURSOR_TIME=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const text=(v,name,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max)bad(`${name} must be non-empty text under ${max} characters`);return v;};
const instant=(v,name)=>{if(typeof v!=='string'||!TIME.test(v)||!Number.isFinite(Date.parse(v)))bad(`${name} must be a UTC ISO timestamp like 2026-11-05T10:00:00Z`);return v;};
export const encodeCursor=(t,id)=>Buffer.from(JSON.stringify({t,id}),'utf8').toString('base64url');
export function decodeCursor(cursor){
 try{const v=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(typeof v.t==='string'&&CURSOR_TIME.test(v.t)&&typeof v.id==='string'&&UUID.test(v.id))return v;}catch{}
 return bad('cursor is not valid');
}
// Query parameters in, a validated filter object out. Unknown parameters are rejected rather than ignored.
export function parseFilters(params,{forExport=false}={}){
 const allowed=['stream','actor','source','kind','equipment','request','from','to',...(forExport?['format']:['limit','cursor'])];
 for(const key of params.keys())if(!allowed.includes(key))bad(`unsupported parameter: ${key}`);
 const get=k=>params.has(k)?params.get(k):undefined;
 const stream=get('stream')??'equipment';
 if(!STREAMS.includes(stream))bad(`stream must be one of: ${STREAMS.join(', ')}`);
 const f={stream};
 if(get('actor')!==undefined)f.actor=text(get('actor'),'actor',100);
 if(get('source')!==undefined)f.source=text(get('source'),'source',40);
 if(get('kind')!==undefined){f.kind=get('kind');if(!KINDS[stream].includes(f.kind))bad(`kind for ${stream} must be one of: ${KINDS[stream].join(', ')}`);}
 if(get('equipment')!==undefined)f.equipment=text(get('equipment'),'equipment',64);
 if(get('request')!==undefined){if(stream!=='request')bad('request can only filter the request stream');if(!UUID.test(get('request')))bad('request must be a request ID');f.request=get('request');}
 if(get('from')!==undefined)f.from=instant(get('from'),'from');
 if(get('to')!==undefined)f.to=instant(get('to'),'to');
 if(f.from&&f.to&&Date.parse(f.from)>=Date.parse(f.to))bad('from must be earlier than to');
 if(forExport){
  const format=get('format')??'json';if(!['json','csv'].includes(format))bad('format must be json or csv');f.format=format;
 }else{
  const limit=get('limit');
  if(limit===undefined)f.limit=DEFAULT_LIMIT;else{if(!/^\d+$/.test(limit)||Number(limit)<1||Number(limit)>MAX_LIMIT)bad(`limit must be a whole number from 1 to ${MAX_LIMIT}`);f.limit=Number(limit);}
  if(get('cursor')!==undefined)f.cursor=decodeCursor(get('cursor'));
 }
 return f;
}
// ---- export redaction: free text and client-supplied identifiers never leave the system ----
export const REDACTED='[redacted]';
const scrub=value=>{
 if(Array.isArray(value))return value.map(scrub);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/^note$/i.test(k)&&v!==null&&v!==undefined?REDACTED:scrub(v)]));
 return value;
};
// A stable per-tenant pseudonym: the same person maps to the same label inside one organization's export, and the label is
// not reversible without the original identifier.
export const pseudonym=(actor,organizationId)=>`user:${createHash('sha256').update(`${organizationId}|${actor}`).digest('hex').slice(0,12)}`;
export function redactEvent(event,organizationId){
 return {id:event.id,stream:event.stream,at:event.at,kind:event.kind,actor:pseudonym(event.actor,organizationId),source:event.source,
  equipmentId:event.equipmentId,requestId:event.requestId,before:scrub(event.before),after:scrub(event.after),detail:scrub(event.detail)};
}
// Spreadsheet programs run cells that start with = + - @ tab or CR. Prefix those with an apostrophe and quote every cell.
export function csvCell(value){
 let s=value===null||value===undefined?'':String(value);
 if(/^[=+\-@\t\r]/.test(s))s=`'${s}`;
 return `"${s.replace(/"/g,'""')}"`;
}
export const CSV_COLUMNS=['at','stream','kind','actor','source','equipment','request','status_from','status_to','version_from','version_to'];
export function toCsv(events){
 const lines=[CSV_COLUMNS.map(csvCell).join(',')];
 for(const e of events)lines.push([e.at,e.stream,e.kind,e.actor,e.source,e.equipmentId,e.requestId,e.before?.status,e.after?.status,e.before?.version,e.after?.version].map(csvCell).join(','));
 return lines.join('\r\n')+'\r\n';
}
