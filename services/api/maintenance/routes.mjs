import {ApiError} from '../equipment/service.mjs';
import {writeError} from '../equipment/routes.mjs';
import {searchEquipment,serviceEquipment,serviceHistory} from './service.mjs';
const route=/^\/organizations\/([^/]+)\/maintenance\/equipment(?:\/([^/]+)\/(service|history))?$/;
const send=(res,status,body,headers={})=>res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers}).end(JSON.stringify(body));
async function readJson(req){
 if(String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')throw new ApiError(415,'unsupported_media_type');
 let size=0;const chunks=[];
 for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>16384)throw new ApiError(413,'payload_too_large');chunks.push(Buffer.from(chunk));}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'invalid_request','Invalid JSON');}
}
export function createMaintenanceHandler({authorization}){
 if(typeof authorization?.run!=='function')throw Error('Authorization required');
 return async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost'),m=route.exec(url.pathname);
   if(!m)throw new ApiError(404,'not_found');
   let org,id;try{org=decodeURIComponent(m[1]);id=m[2]&&decodeURIComponent(m[2]);}catch{throw new ApiError(400,'invalid_request');}
   const run=(permission,work)=>authorization.run(req,{organizationId:org,permission},work);
   if(req.method==='GET'&&!id)return send(res,200,await run('inventory:read',ctx=>searchEquipment(ctx,url.searchParams)));
   if(req.method==='GET'&&m[3]==='history')return send(res,200,await run('audit:read',ctx=>serviceHistory(ctx,id,url.searchParams)));
   if(req.method==='POST'&&m[3]==='service'){
    await run('equipment:write',async()=>{}); // Reject before reading untrusted body; reauthorize inside the write transaction.
    if(url.search)throw new ApiError(400,'invalid_request','Service command does not accept query parameters');
    const body=await readJson(req),idempotencyKey=req.headers['idempotency-key'],correlationId=req.headers['x-correlation-id'];
    if(correlationId!==undefined&&(typeof correlationId!=='string'||!correlationId.trim()||correlationId.length>100))throw new ApiError(400,'invalid_request','Invalid correlation id');
    const result=await run('equipment:write',ctx=>serviceEquipment(ctx,id,body,{idempotencyKey,correlationId}));
    return send(res,200,result,result.replayed?{'Idempotent-Replay':'true'}:{});
   }
   throw new ApiError(405,'method_not_allowed');
  }catch(error){writeError(res,error);}
 };
}
