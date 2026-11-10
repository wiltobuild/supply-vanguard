// HTTP surface for holds (SV-021), same pattern as the other handlers.
//   GET  /organizations/:org/equipment/:id/holds?state=all|active|cleared     inventory:read
//   POST /organizations/:org/equipment/:id/holds         body {kind, reason?}  equipment:write
//   POST /organizations/:org/holds/:holdId/clear                                any member; the database allows only the configured role (legacy: no evidence)
//   POST /organizations/:org/holds/:holdId/clearances   body {schemaVersion:1, evidence:{reference, observedAt, note?}}   header Idempotency-Key   same role rule (SV-031)
//   GET  /organizations/:org/holds/clearance-rules                              inventory:read
//   PUT  /organizations/:org/holds/clearance-rules/:kind  body {role}           organization:manage
import {writeAuthError} from '../auth/index.mjs';
import {ApiError} from '../equipment/service.mjs';
import {listHolds,placeHold,clearHold,clearHoldWithEvidence,listRules,setRule} from './service.mjs';

const MAX_BODY=16*1024;
const ROUTE=/^\/organizations\/([^/]+)\/(?:equipment\/([^/]+)\/holds|holds\/(clearance-rules)(?:\/([^/]+))?|holds\/([^/]+)\/(clear|clearances))$/;
const send=(res,status,body,headers={})=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify(body));};
async function readJson(req){
 if(String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')throw new ApiError(415,'unsupported_media_type','Content-Type must be application/json');
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw new ApiError(413,'payload_too_large');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'invalid_request','body is not valid JSON');}
}
function writeError(res,error){
 if(error instanceof ApiError)return send(res,error.status,{error:error.code,...(error.detail&&{detail:error.detail})});
 return writeAuthError(res,error);
}
export function createHoldsHandler({authorization}){
 if(typeof authorization?.run!=='function')throw new Error('Authorization required');
 const run=(req,organizationId,permission,work)=>authorization.run(req,{organizationId,permission},work);
 return async function handle(req,res){
  try{
   const url=new URL(req.url,'http://localhost'),m=ROUTE.exec(url.pathname);
   if(!m)throw new ApiError(404,'not_found');
   const org=decodeURIComponent(m[1]),equipment=m[2]&&decodeURIComponent(m[2]),rules=m[3],kind=m[4]&&decodeURIComponent(m[4]),hold=m[5]&&decodeURIComponent(m[5]),holdAction=m[6];
   if(equipment&&req.method==='GET')return send(res,200,await run(req,org,'inventory:read',ctx=>listHolds(ctx,equipment,{state:url.searchParams.get('state')??undefined})));
   if(equipment&&req.method==='POST'){
    await run(req,org,'equipment:write',async()=>{});   // authenticate and authorize before reading the body
    const body=await readJson(req),out=await run(req,org,'equipment:write',ctx=>placeHold(ctx,equipment,body));
    return send(res,out.placed?201:200,out,out.placed?{}:{'Idempotent-Replay':'true'});
   }
   if(rules&&!kind&&req.method==='GET')return send(res,200,await run(req,org,'inventory:read',ctx=>listRules(ctx)));
   if(rules&&kind&&req.method==='PUT'){
    await run(req,org,'organization:manage',async()=>{});
    const body=await readJson(req);
    return send(res,200,await run(req,org,'organization:manage',ctx=>setRule(ctx,kind,body)));
   }
   if(hold&&holdAction==='clearances'&&req.method==='POST'){
    await run(req,org,'inventory:read',async()=>{});   // authenticate and authorize before reading the body
    const body=await readJson(req),key=req.headers['idempotency-key'];
    const out=await run(req,org,'inventory:read',ctx=>clearHoldWithEvidence(ctx,hold,body,{idempotencyKey:Array.isArray(key)?undefined:key}));
    return send(res,out.replayed?200:201,out,out.replayed?{'Idempotent-Replay':'true'}:{});
   }
   if(hold&&holdAction==='clear'&&req.method==='POST')return send(res,200,await run(req,org,'inventory:read',ctx=>clearHold(ctx,hold)));
   throw new ApiError(405,'method_not_allowed');
  }catch(error){writeError(res,error);}
 };
}
