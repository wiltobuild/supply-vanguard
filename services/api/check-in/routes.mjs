import {ApiError} from '../equipment/service.mjs';
import {writeError} from '../equipment/routes.mjs';
import {checkIn,listCheckInLocations} from './service.mjs';
const send = (res,status,body) => {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
const header = (req,key) => typeof req.headers[key] === 'string' ? req.headers[key] : undefined;
async function json(req) {
 if (header(req,'content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415,'unsupported_media_type');
 let size=0; const chunks=[];
 for await (const chunk of req) {size+=chunk.length;if(size>2048)throw new ApiError(413,'payload_too_large');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'invalid_request','Invalid JSON');}
}
// Mount only this route in the host's existing authenticated dispatcher; this is not a new server.
export function createCheckInHandler({authorization}) {
 if (typeof authorization?.run !== 'function') throw new Error('Authorization required');
 return async (req,res) => {
  try {
   const match=/^\/organizations\/([^/]+)\/check-ins(\/locations)?$/.exec(new URL(req.url,'http://localhost').pathname);
   if (!match) throw new ApiError(404,'not_found');
   let organizationId;try{organizationId=decodeURIComponent(match[1]);}catch{throw new ApiError(400,'invalid_request');}
   const scope={organizationId,permission:'equipment:write'};
   if (req.method==='GET' && match[2]) return send(res,200,await authorization.run(req,scope,listCheckInLocations));
   if (req.method!=='POST' || match[2]) throw new ApiError(405,'method_not_allowed');
   await authorization.run(req,scope,async()=>{}); // authenticate before reading untrusted data
   const body=await json(req);
   const out=await authorization.run(req,scope,ctx=>checkIn(ctx,body,{idempotencyKey:header(req,'idempotency-key'),correlationId:header(req,'x-correlation-id')}));
   return send(res,out.replayed?200:201,out);
  } catch(error) {writeError(res,error);}
 };
}
