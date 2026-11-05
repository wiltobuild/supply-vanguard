// HTTP surface for equipment (SV-006). Plain node:http handler; authentication and tenant checks come from the SV-005
// authorization boundary, and every route runs its work inside one authorization.run() transaction.
//   GET   /organizations/:org/equipment?limit&cursor&status&location&q
//   GET   /organizations/:org/equipment/:id
//   PATCH /organizations/:org/equipment/:id               body {expectedVersion, status?, note?}  header Idempotency-Key
//   POST  /organizations/:org/equipment/:id/observations  body {locationId, observedAt, source}    header Idempotency-Key
import {writeAuthError} from '../auth/index.mjs';
import {ApiError,listEquipment,getEquipment,updateEquipment,recordObservation,MAX_LIMIT} from './service.mjs';

const MAX_BODY=16*1024;
const ROUTE=/^\/organizations\/([^/]+)\/equipment(?:\/([^/]+)(\/observations)?)?$/;
function send(res,status,body,headers={}){
 res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});
 res.end(JSON.stringify(body));
}
async function readJson(req){
 const type=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
 if(type!=='application/json')throw new ApiError(415,'unsupported_media_type','Content-Type must be application/json');
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw new ApiError(413,'payload_too_large');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'invalid_request','body is not valid JSON');}
}
const header=(req,name)=>{const v=req.headers[name];return typeof v==='string'&&v.trim()?v.trim():undefined;};
export function writeError(res,error){
 if(error instanceof ApiError){
  const {current}=error;
  return send(res,error.status,{error:error.code,...(error.detail&&{detail:error.detail}),...(current&&{current})});
 }
 return writeAuthError(res,error);
}
export function createEquipmentHandler({authorization}){
 if(typeof authorization?.run!=='function')throw new Error('Authorization required');
 return async function handle(req,res){
  try{
   const url=new URL(req.url,'http://localhost'),match=ROUTE.exec(url.pathname);
   if(!match)throw new ApiError(404,'not_found');
   const organizationId=decodeURIComponent(match[1]),id=match[2]&&decodeURIComponent(match[2]),observations=Boolean(match[3]);
   const common={idempotencyKey:header(req,'idempotency-key'),correlationId:header(req,'x-correlation-id')};
   if(common.correlationId&&common.correlationId.length>100)throw new ApiError(400,'invalid_request','X-Correlation-Id is too long');
   if(req.method==='GET'&&!observations){
    if(!id){
     const p=url.searchParams,limitText=p.get('limit');
     const query={limit:limitText===null?undefined:Number(limitText),cursor:p.get('cursor')??undefined,status:p.get('status')??undefined,location:p.get('location')??undefined,q:p.get('q')??undefined};
     if(limitText!==null&&!/^\d+$/.test(limitText))throw new ApiError(400,'invalid_request',`limit must be a whole number from 1 to ${MAX_LIMIT}`);
     return send(res,200,await authorization.run(req,{organizationId,permission:'inventory:read'},ctx=>listEquipment(ctx,query)));
    }
    return send(res,200,await authorization.run(req,{organizationId,permission:'inventory:read'},ctx=>getEquipment(ctx,id)));
   }
   if(id&&req.method==='PATCH'&&!observations){
    // Authenticate and authorize before reading the body.
    const body=await readJsonAfterAuth(authorization,req,organizationId);
    const out=await authorization.run(req,{organizationId,permission:'equipment:write'},ctx=>updateEquipment(ctx,id,body,common));
    return send(res,200,out,out.replayed?{'Idempotent-Replay':'true'}:{});
   }
   if(id&&req.method==='POST'&&observations){
    const body=await readJsonAfterAuth(authorization,req,organizationId);
    const out=await authorization.run(req,{organizationId,permission:'equipment:write'},ctx=>recordObservation(ctx,id,body,common));
    return send(res,out.applied?201:200,out);
   }
   throw new ApiError(405,'method_not_allowed');
  }catch(error){writeError(res,error);}
 };
}
// Reject unauthenticated or unauthorized callers before parsing any body they sent.
async function readJsonAfterAuth(authorization,req,organizationId){
 await authorization.run(req,{organizationId,permission:'equipment:write'},async()=>{});
 return readJson(req);
}
