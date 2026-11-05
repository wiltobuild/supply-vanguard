// Same-origin API adapter. Credentials and inventory live only in memory.
import {validateEquipmentRecord} from '../../../packages/domain/contracts.js';
export class EquipmentError extends Error {
 constructor(message,{status=0,code='network',uncertain=false}={}){super(message);Object.assign(this,{status,code,uncertain});}
}
export const errorMessage=status=>status===401?'Your session expired or is invalid. Connect again with a current session.':status===403?'This session does not have permission for this organization or action.':status===409?'Someone changed this equipment. Load the latest record, review your draft, and save again.':status===422?'This status transition is not allowed. Review the current status and choose another.':status>=500?'The equipment service could not complete this request. Retry when it is available.':'The equipment service rejected this request. Review your entries.';
export function createEquipmentApi({organizationId,token,fetcher=fetch,base='',timeoutMs=15000}){
 if(!organizationId?.trim()||!token?.trim())throw new EquipmentError('Organization and session token are required.',{code:'configuration'});
 const root=`${base}/organizations/${encodeURIComponent(organizationId.trim())}/equipment`;
 async function request(path='',{method='GET',body,key,signal}={}){
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;abort();},timeoutMs);
  try{
   const response=await fetcher(root+path,{method,signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error',headers:{Authorization:`Bearer ${token}`,...(body&&{'Content-Type':'application/json','Idempotency-Key':key})},...(body&&{body:JSON.stringify(body)})});
   let data;try{data=await response.json();}catch{throw new EquipmentError('The equipment service returned an unreadable response.',{status:response.ok?0:response.status,code:'response',uncertain:method!=='GET'});}
   if(!response.ok)throw new EquipmentError(errorMessage(response.status),{status:response.status,code:data.error||'request'});
   return data;
  }catch(error){
   if(error instanceof EquipmentError)throw error;
   throw new EquipmentError(timedOut?'Request timed out. Refresh to check committed state before trying again.':controller.signal.aborted?'Request stopped. Refresh to check committed state before trying again.':'Cannot reach the equipment service. Check your connection and retry.',{code:timedOut?'timeout':controller.signal.aborted?'cancelled':'network',uncertain:method!=='GET'});
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 return {
  async list({signal}={}){
   const items=[],cursors=new Set();let cursor=null;
   do{const page=await request(`?limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{signal});
    if(!Array.isArray(page.items)||!(page.nextCursor===null||typeof page.nextCursor==='string'))throw new EquipmentError('The equipment list response is invalid.',{code:'response'});
    try{for(const item of page.items){if(typeof item?.locationId!=='string'||!item.locationId.trim())throw Error();validateEquipmentRecord(item,[item.locationId,item.lastVerified?.locationId]);}}
    catch{throw new EquipmentError('The equipment service returned an invalid record. Refresh or contact the service owner.',{code:'response'});}
    items.push(...page.items);cursor=page.nextCursor;if(cursor&&cursors.has(cursor))throw new EquipmentError('The service repeated an equipment page. Retry the refresh.',{code:'response'});cursors.add(cursor);
   }while(cursor);
   if(new Set(items.map(i=>i.id)).size!==items.length)throw new EquipmentError('The service returned duplicate equipment identities.',{code:'response'});
   return items;
  },
  admin:(id,body,options={})=>request(`/${encodeURIComponent(id)}`,{method:'PATCH',body,...options}),
  observe:(id,body,options={})=>request(`/${encodeURIComponent(id)}/observations`,{method:'POST',body,...options})
 };
}
// Refresh after every command/replay: a replay response can be an older committed snapshot.
// A cancelled write may already have committed. Require a fresh read; never silently retry.
export function createEquipmentSession(api,{onChange=()=>{}}={}){
 let state={items:[],phase:'idle',error:null,busy:false,needsRefresh:false},read=null,write=null,generation=0,closed=false;
 const emit=patch=>{state={...state,...patch};if(!closed)onChange(state);};
 async function refresh({background=false}={}){
  const gen=++generation;read?.abort();read=new AbortController();
  // Keep the failed-refresh warning visible during automatic retries, until a read succeeds.
  if(!background)emit({phase:'loading'});
  try{const items=await api.list({signal:read.signal});if(gen===generation&&!closed)emit({items,phase:'ready',error:null,needsRefresh:false});return items;}
  catch(error){if(gen===generation&&!closed)emit({phase:'error',error});throw error;}
 }
 return {
  get state(){return state;},refresh,
  cancelRead(){generation++;read?.abort();emit({phase:'idle',error:new EquipmentError('Refresh cancelled. Use Refresh to try again.',{code:'cancelled'})});},
  cancelWrite(){write?.abort();},
  async mutate(kind,id,body,{key=crypto.randomUUID()}={}){
   if(state.busy)throw new EquipmentError('A save is already in progress.',{code:'busy'});
   if(state.needsRefresh)throw new EquipmentError('Refresh committed state before saving again.',{code:'refresh_required'});
   generation++;read?.abort();write=new AbortController();emit({busy:true,error:null});
   let committed=false;
   try{
    const result=await api[kind](id,body,{key,signal:write.signal});committed=true;
    await refresh();return result;
   }catch(error){
    if(committed||error.uncertain||error.status===409)emit({needsRefresh:true});
    if(error.status===409){try{await refresh();}catch{/* retain the original conflict and the draft */}}
    if(committed)throw new EquipmentError('The save was accepted, but refresh failed. Refresh before making another change.',{code:'refresh_required',uncertain:true});
    throw error;
   }finally{write=null;emit({busy:false});}
  },
  close(){closed=true;generation++;read?.abort();write?.abort();state={items:[],phase:'idle',error:null,busy:false,needsRefresh:false};}
 };
}
