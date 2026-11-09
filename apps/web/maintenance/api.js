import {validateEquipmentRecord} from '../../../packages/domain/contracts.js';
export class MaintenanceError extends Error{
 constructor(message,{status=0,uncertain=false}={}){super(message);Object.assign(this,{status,uncertain});}
}
export function createMaintenanceApi({organizationId,token,fetcher=fetch,base='',timeoutMs=15000,onAuthorizationLoss=()=>{}}){
 if(!organizationId?.trim()||!token?.trim())throw new MaintenanceError('Organization and session are required.');
 const root=`${base}/organizations/${encodeURIComponent(organizationId.trim())}/maintenance/equipment`;
 async function request(path='',{method='GET',body,key,signal}={}){
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(abort,timeoutMs);
  try{
   const res=await fetcher(root+path,{method,signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error',headers:{Authorization:`Bearer ${token}`,...(body&&{'Content-Type':'application/json','Idempotency-Key':key})},...(body&&{body:JSON.stringify(body)})});
   // HTTP denial is authoritative even when a gateway returns HTML, an empty body or broken JSON.
   if(!res.ok){const error=new MaintenanceError(res.status===401?'Session expired. Reconnect.':res.status===403?'This session cannot perform this action for this organization.':res.status===409?'Conflict: refresh and review the preserved draft before submitting again.':res.status===422?'Transition refused. Existing unavailable status must be preserved.':'The service rejected the request.',{status:res.status,uncertain:method!=='GET'&&res.status>=500});if(res.status===401||(res.status===403&&path.startsWith('?')))onAuthorizationLoss(error);throw error;}
   let data;try{data=await res.json();}catch{throw new MaintenanceError('Unreadable response. Check current state and retry the same command.',{status:res.status,uncertain:method!=='GET'});}
   return data;
  }catch(error){if(error instanceof MaintenanceError)throw error;throw new MaintenanceError('Connection interrupted. Refresh current state; retry only the same command.',{uncertain:method!=='GET'});}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 return {
  async list({view,q,cursor,signal}={}){
   const p=new URLSearchParams({view:view??'cleaning',limit:'25'});if(q?.trim())p.set('q',q.trim());if(cursor)p.set('cursor',cursor);
   const page=await request(`?${p}`,{signal});
   if(!page||!Array.isArray(page.items)||!(page.nextCursor===null||typeof page.nextCursor==='string'))throw new MaintenanceError('Invalid equipment response.');
   try{for(const item of page.items)validateEquipmentRecord(item,[item.locationId,item.lastVerified?.locationId]);}catch{throw new MaintenanceError('Invalid equipment record. Refresh current state.');}
   if(new Set(page.items.map(item=>item.id)).size!==page.items.length)throw new MaintenanceError('Repeated equipment identities. Refresh current state.');
   return page;
  },
  history:(id,cursor)=>request(`/${encodeURIComponent(id)}/history?limit=25${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`),
  service:async(id,body,key)=>{
   const result=await request(`/${encodeURIComponent(id)}/service`,{method:'POST',body,key});
   if(!result?.record||typeof result.replayed!=='boolean')throw new MaintenanceError('Unconfirmed save response. Retry the same command.',{uncertain:true});
   return result;
  }
 };
}
