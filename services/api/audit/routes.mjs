// HTTP surface for audit (SV-012). GET only.
//   GET /organizations/:org/audit/events?stream&actor&source&kind&equipment&request&from&to&limit&cursor   audit:read
//   GET /organizations/:org/audit/export?...same filters...&format=json|csv                                audit:export (redacted)
import {writeAuthError} from '../auth/index.mjs';
import {ApiError} from '../equipment/service.mjs';
import {searchEvents,exportEvents} from './service.mjs';
const ROUTE=/^\/organizations\/([^/]+)\/audit\/(events|export)$/;
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
function writeError(res,error){
 if(error instanceof ApiError)return json(res,error.status,{error:error.code,...(error.detail&&{detail:error.detail})});
 return writeAuthError(res,error);
}
export function createAuditHandler({authorization}){
 if(typeof authorization?.run!=='function')throw new Error('Authorization required');
 return async function handle(req,res){
  try{
   const url=new URL(req.url,'http://localhost'),m=ROUTE.exec(url.pathname);
   if(!m)throw new ApiError(404,'not_found');
   if(req.method!=='GET')throw new ApiError(405,'method_not_allowed');
   const organizationId=decodeURIComponent(m[1]);
   if(m[2]==='events')return json(res,200,await authorization.run(req,{organizationId,permission:'audit:read'},ctx=>searchEvents(ctx,url.searchParams)));
   const out=await authorization.run(req,{organizationId,permission:'audit:export'},ctx=>exportEvents(ctx,url.searchParams));
   res.writeHead(200,{'Content-Type':out.format==='csv'?'text/csv; charset=utf-8':'application/json','Content-Disposition':`attachment; filename="audit-export.${out.format}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   res.end(out.body);
  }catch(error){writeError(res,error);}
 };
}
