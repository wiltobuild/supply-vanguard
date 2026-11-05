// HTTP surface for requests (SV-020), same pattern as the equipment routes.
//   POST /organizations/:org/requests                          body {note?, items:[{equipmentType}]}        equipment:write
//   GET  /organizations/:org/requests?limit&cursor                                                          inventory:read
//   GET  /organizations/:org/requests/:id                                                                   inventory:read
//   POST /organizations/:org/requests/:id/items/:line/claim    body {equipmentId, expectedVersion}          equipment:write
import {writeAuthError} from '../auth/index.mjs';
import {ApiError} from '../equipment/service.mjs';
import {createRequest,getRequest,listRequests,claimItem,MAX_LIMIT} from './service.mjs';

const MAX_BODY=16*1024;
const ROUTE=/^\/organizations\/([^/]+)\/requests(?:\/([^/]+)(?:\/items\/([^/]+)\/claim)?)?$/;
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
export function createRequestsHandler({authorization}){
 if(typeof authorization?.run!=='function')throw new Error('Authorization required');
 const run=(req,organizationId,permission,work)=>authorization.run(req,{organizationId,permission},work);
 return async function handle(req,res){
  try{
   const url=new URL(req.url,'http://localhost'),m=ROUTE.exec(url.pathname);
   if(!m)throw new ApiError(404,'not_found');
   const org=decodeURIComponent(m[1]),id=m[2]&&decodeURIComponent(m[2]),line=m[3]&&decodeURIComponent(m[3]);
   if(req.method==='GET'&&!line){
    if(id)return send(res,200,await run(req,org,'inventory:read',ctx=>getRequest(ctx,id)));
    const p=url.searchParams,limitText=p.get('limit');
    if(limitText!==null&&!/^\d+$/.test(limitText))throw new ApiError(400,'invalid_request',`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    return send(res,200,await run(req,org,'inventory:read',ctx=>listRequests(ctx,{limit:limitText===null?undefined:Number(limitText),cursor:p.get('cursor')??undefined})));
   }
   if(req.method==='POST'&&(!id||line)){
    await run(req,org,'equipment:write',async()=>{});   // authenticate and authorize before reading the body
    const body=await readJson(req);
    if(!id)return send(res,201,await run(req,org,'equipment:write',ctx=>createRequest(ctx,body)));
    const out=await run(req,org,'equipment:write',ctx=>claimItem(ctx,id,line,body));
    return send(res,out.replayed?200:201,out,out.replayed?{'Idempotent-Replay':'true'}:{});
   }
   throw new ApiError(405,'method_not_allowed');
  }catch(error){writeError(res,error);}
 };
}
