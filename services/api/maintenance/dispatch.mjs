// Compose the existing public handlers around one injected authorization/pool/verifier. No new server or auth.
import {createEquipmentHandler} from '../equipment/routes.mjs';
import {createMaintenanceHandler} from './routes.mjs';
import {ApiError} from '../equipment/service.mjs';
import {writeError} from '../equipment/routes.mjs';
export function createEquipmentMaintenanceHandler({authorization}){
 const equipment=createEquipmentHandler({authorization}),maintenance=createMaintenanceHandler({authorization});
 return (req,res)=>{
  let path;try{path=new URL(req.url,'http://localhost').pathname;}catch{return writeError(res,new ApiError(400,'invalid_request','Invalid request target'));}
  return /^\/organizations\/[^/]+\/maintenance(?:\/|$)/.test(path)?maintenance(req,res):equipment(req,res);
 };
}
