import {createServer} from 'node:http';
import {createAuthorization} from '../auth/index.mjs';
import {ApiError} from '../equipment/service.mjs';
import {createEquipmentHandler,writeError} from '../equipment/routes.mjs';
import {createCheckInHandler} from './routes.mjs';

export class CheckInHostError extends Error {
 constructor(code,message){super(message);this.name='CheckInHostError';this.code=code;}
}
const fail=(code,message)=>new CheckInHostError(code,message);
const TABLES=['organization','facility','ward','location','equipment_type','equipment','equipment_observation','equipment_event','auth_user','auth_membership','equipment_command_receipt','check_in_receipt'];
const FUNCTIONS=['auth_resolve_identity(text,text)','auth_user_id()','auth_organization_id()','auth_has_permission(text)'];
const GRANTS=[...['organization','location','equipment_type','equipment','equipment_observation','equipment_event','auth_user','auth_membership','equipment_command_receipt','check_in_receipt'].map(t=>[t,'SELECT']),
 ['equipment','UPDATE'],['equipment_observation','INSERT'],['equipment_event','INSERT'],['equipment_command_receipt','INSERT'],['check_in_receipt','INSERT'],['check_in_receipt','UPDATE']];

// Read-only startup inspection. No fixture, identity issuance, migration or grant implementation here.
async function verifyProvisioning(pool) {
 let client,begun=false,discard;
 try {
  client=await pool.connect();
  if(typeof client?.query!=='function'||typeof client?.release!=='function')throw fail('invalid_pool','The supplied pool must lease an exclusive query client with release().');
  // A rejected acknowledgement can still mean BEGIN reached the server. Attempt rollback
  // and conservatively discard that client using the pg-compatible release(error) contract.
  begun=true;
  try{await client.query('BEGIN READ ONLY');}catch(error){discard=error;throw error;}
  const missing=await client.query(`SELECT ARRAY(SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass('public.'||name) IS NULL) AS tables,
   ARRAY(SELECT name FROM unnest($2::text[]) AS name WHERE to_regprocedure('public.'||name) IS NULL) AS functions`,[TABLES,FUNCTIONS]);
  if(missing.rows[0]?.tables?.length||missing.rows[0]?.functions?.length)throw fail('missing_schema','Required core, auth, equipment-receipt or check-in schema is missing. Apply approved provisioning separately.');
  if(!missing.rows[0]||!Array.isArray(missing.rows[0].tables)||!Array.isArray(missing.rows[0].functions))throw fail('invalid_pool','The supplied pool did not return provisioning metadata.');
  const safety=await client.query(`SELECT r.rolsuper OR r.rolbypassrls OR EXISTS (
   SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND
    (NOT c.relrowsecurity OR (c.relname<>'auth_user' AND NOT c.relforcerowsecurity) OR pg_has_role(current_user,c.relowner,'USAGE'))
   ) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`,[TABLES]);
  if(safety.rows[0]?.unsafe!==false)throw fail('unsafe_runtime_role','Supply the approved non-owner NOSUPERUSER NOBYPASSRLS runtime pool with required RLS enabled.');
  const grants=await client.query(`SELECT bool_and(has_table_privilege(current_user,('public.'||table_name)::regclass,privilege_name)) AS tables,
   has_function_privilege(current_user,'public.auth_resolve_identity(text,text)','EXECUTE') AS resolver
   FROM unnest($1::text[],$2::text[]) AS requirements(table_name,privilege_name)`,
   [GRANTS.map(g=>g[0]),GRANTS.map(g=>g[1])]);
  if(grants.rows[0]?.tables!==true||grants.rows[0]?.resolver!==true)throw fail('missing_runtime_grants','The supplied runtime role lacks required existing API/receipt grants. Provision them through the approved procedure separately.');
  await client.query('COMMIT');begun=false;
 } catch(error) {
  if(begun){try{await client.query('ROLLBACK');}catch(rollbackError){discard=rollbackError;}}
  if(error instanceof CheckInHostError)throw error;
  throw fail('provisioning_unavailable','Cannot validate the supplied runtime database. Check its approved provisioning and connection separately.');
 } finally {
  if(typeof client?.release==='function'){try{client.release(discard);}catch{throw fail('connection_release_failed','Could not release the provisioning connection safely.');}}
 }
}

// The caller owns the supplied pool/verifier and their lifecycle. One existing authorization
// instance is shared by both public handlers; requests and body streams are passed unchanged.
export function createCheckInHost(configuration={}) {
 if(!configuration||typeof configuration!=='object'||Array.isArray(configuration))throw fail('invalid_configuration','An explicitly supplied runtime pool and identity verifier are required.');
 const {pool,identityProvider}=configuration;
 if(typeof pool?.connect!=='function'||typeof identityProvider?.verify!=='function')throw fail('invalid_configuration','An explicitly supplied runtime pool and identity verifier are required.');
 const authorization=createAuthorization({pool,identityProvider});
 const equipment=createEquipmentHandler({authorization}),checkIn=createCheckInHandler({authorization});
 let readiness,startPromise,closePromise,stopping=false,bound=false,state='idle',lastError=null;
 let activeRequests=0,drained,resolveDrained;
 const drainRequests=()=>activeRequests?(drained??=new Promise(resolve=>resolveDrained=resolve)):Promise.resolve();
 const ready=()=>{
  if(stopping)return Promise.reject(fail('host_closed','The local check-in host is closing or closed.'));
  return readiness??=verifyProvisioning(pool);
 };
 const handle=async(req,res)=>{
  let admitted=false;
  try {
   if(stopping)throw new ApiError(503,'host_closed');
   admitted=true;activeRequests++;
   if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes('#'))throw new ApiError(400,'invalid_request');
   const path=req.url.split('?')[0];
   if(new URL(req.url,'http://localhost').pathname!==path)throw new ApiError(400,'invalid_request');
   const target=/^\/organizations\/[^/]+\/check-ins(?:\/locations)?$/.test(path)?checkIn:
    /^\/organizations\/[^/]+\/equipment(?:\/[^/]+(?:\/observations)?)?$/.test(path)?equipment:null;
   if(!target)throw new ApiError(404,'not_found');
   await ready();
   if(stopping)throw new ApiError(503,'host_closed');
   return await target(req,res);
  }catch(error){writeError(res,error instanceof CheckInHostError?new ApiError(503,'host_not_ready','Local database provisioning is not ready.'):error);}
  finally{if(admitted&&--activeRequests===0)resolveDrained?.();}
 };
 const server=createServer(handle);
 server.on('error',()=>{if(bound){lastError=fail('server_failed','The local HTTP server reported an error. Close the host and inspect the caller-owned runtime.');stopping=true;state='failed';}});
 function listen(options={}) {
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>k!=='port'))return Promise.reject(fail('invalid_listen_options','Only a loopback port may be configured.'));
  const port=options.port??4181;
  if(!Number.isInteger(port)||port<1||port>65535)return Promise.reject(fail('invalid_port','Port must be an integer from 1 to 65535.'));
  if(stopping||state!=='idle')return Promise.reject(fail('invalid_lifecycle','The local host is already starting, listening or closed.'));
  state='starting';
  startPromise=(async()=>{
   try {
    await ready();if(stopping)throw fail('host_closed','The local host closed during startup.');
    await new Promise((resolve,reject)=>{
     const failed=()=>{cleanup();reject(fail('listen_failed','Could not bind the local check-in host on 127.0.0.1.'));};
     const listening=()=>{cleanup();bound=true;resolve();};
     const cleanup=()=>{server.off('error',failed);server.off('listening',listening);};
     server.once('error',failed);server.once('listening',listening);
     try{server.listen({host:'127.0.0.1',port});}catch{failed();}
    });
    state='listening';return {host:'127.0.0.1',port};
   } catch(error){state=stopping?'closing':'idle';throw error;}
  })();
  return startPromise;
 }
 function close() {
  if(closePromise)return closePromise;
  stopping=true;
  closePromise=(async()=>{
   if(startPromise){try{await startPromise;}catch{/* startup failure already reaches its caller */}}
   else if(readiness){try{await readiness;}catch{/* readiness failure already reaches its caller */}}
   state='closing';
   const listenerClosed=bound?new Promise((resolve,reject)=>{try{server.close(error=>{if(error){state='close_failed';lastError=fail('close_failed','Could not close the local HTTP server; shutdown is not confirmed.');reject(lastError);}else{bound=false;resolve();}});}catch{state='close_failed';lastError=fail('close_failed','Could not close the local HTTP server; shutdown is not confirmed.');reject(lastError);}}):Promise.resolve();
   // Listener shutdown alone cannot drain direct handle() calls. Wait for both, including
   // mapped errors/cancellation and verifier, transaction and lease cleanup in the handlers.
   const [listener]=await Promise.allSettled([listenerClosed,drainRequests()]);
   if(listener.status==='rejected')throw listener.reason;
   state='closed';
  })();
  return closePromise;
 }
 return Object.freeze({handle,ready,listen,close,get state(){return state;},get lastError(){return lastError;}});
}
