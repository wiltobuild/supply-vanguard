// Throwaway test harness, using the public auth/equipment modules unchanged.
// No token logs, persistence, issuance endpoint, or production identity provisioning.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync,existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Readable,Writable} from 'node:stream';
import {createAuthorization} from '../../../services/api/auth/index.mjs';
import {createLocalIdentityProvider} from '../../../services/api/auth/local-identity.mjs';
import {createEquipmentMaintenanceHandler} from '../../../services/api/maintenance/dispatch.mjs';
import {createWebHandler} from '../serve.mjs';
export async function startFixture({transport='http',PGlite:injectedPGlite,maintenanceExamples=false,port=0}={}){
 if(!['http','in-process','preview'].includes(transport))throw Error('Unknown fixture transport');
 const require=createRequire(new URL('../../../services/api/auth/package.json',import.meta.url));
 const PGlite=injectedPGlite??(await import(pathToFileURL(require.resolve('@electric-sql/pglite')))).PGlite;
 const db=new PGlite(),sql=p=>readFileSync(new URL('../../../services/api/'+p,import.meta.url),'utf8');
 let available=Promise.resolve();
 async function connect(role='sv_web_test_runtime'){const prior=available;let release;available=new Promise(r=>{release=r;});await prior;await db.query(role?`SET ROLE ${role}`:'RESET ROLE');return {query:(...a)=>db.query(...a),release};}
 await db.exec(sql('db/migrations/0001_core.up.sql').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
 await db.exec(sql('auth/migrations/0001_auth.up.sql'));
 const receiptMigration=new URL('../../../services/api/equipment/migrations/0001_receipts.up.sql',import.meta.url);
 const hasReceipts=existsSync(receiptMigration);
 if(hasReceipts)await db.exec(`BEGIN; ${readFileSync(receiptMigration,'utf8')} COMMIT;`);
 await db.exec(sql('requests/migrations/0001_requests.up.sql'));
 await db.exec(sql('holds/migrations/0001_holds.up.sql'));
 await db.exec(sql('db/seed/seed.sql'));
 const organizationId=(await db.query('SELECT id FROM organization')).rows[0].id;
 await db.exec(sql('db/seed/seed.sql'));
 const otherOrganizationId=(await db.query('SELECT id FROM organization WHERE id<>$1',[organizationId])).rows[0].id;
 if(maintenanceExamples){
  await db.query("INSERT INTO equipment_hold(organization_id,equipment_id,kind,placed_by) SELECT $1,id,'dirty','synthetic-fixture' FROM equipment WHERE organization_id=$1 AND external_id='EQ-001'",[organizationId]);
  await db.query("INSERT INTO request(organization_id,requested_by) VALUES ($1,'synthetic-fixture')",[organizationId]);
  await db.query(`INSERT INTO request_item(organization_id,request_id,line_no,equipment_type_id,state) SELECT $1,r.id,1,e.equipment_type_id,'assigned' FROM request r JOIN equipment e ON e.organization_id=r.organization_id WHERE r.organization_id=$1 AND e.external_id='EQ-003'`,[organizationId]);
  await db.query(`INSERT INTO item_assignment(organization_id,request_item_id,equipment_id,assigned_by) SELECT $1,i.id,e.id,'synthetic-fixture' FROM request_item i JOIN equipment e ON e.organization_id=i.organization_id WHERE i.organization_id=$1 AND e.external_id='EQ-003'`,[organizationId]);
 }
 await db.exec(`CREATE ROLE sv_web_test_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
 GRANT USAGE ON SCHEMA public TO sv_web_test_runtime;
 GRANT SELECT, INSERT, UPDATE ON organization,facility,ward,location,equipment_type,equipment,equipment_observation,equipment_event TO sv_web_test_runtime;
 GRANT SELECT ON auth_user,auth_membership TO sv_web_test_runtime;
 GRANT SELECT ON item_assignment,equipment_hold TO sv_web_test_runtime;
 GRANT EXECUTE ON FUNCTION auth_resolve_identity(text,text) TO sv_web_test_runtime;`);
 if(hasReceipts)await db.exec('GRANT SELECT, INSERT ON equipment_command_receipt TO sv_web_test_runtime');
 const identityProvider=createLocalIdentityProvider({mode:'test'}),tokens={};
 for(const role of ['equipment_manager','viewer','operator','other']){
  const {rows}=await db.query('INSERT INTO auth_user(issuer,subject) VALUES ($1,$2) RETURNING id',['urn:supply-vanguard:local','synthetic-web-'+role]);
  await db.query('INSERT INTO auth_membership(organization_id,user_id,role) VALUES ($1,$2,$3)',[role==='other'?otherOrganizationId:organizationId,rows[0].id,role==='other'?'equipment_manager':role]);
  tokens[role]=identityProvider.issue('synthetic-web-'+role);
 }
 const authorization=createAuthorization({identityProvider,pool:{connect}}),apiHandler=createEquipmentMaintenanceHandler({authorization});
 const handler=createWebHandler({apiHandler});let api,web,base='http://synthetic.invalid';
 if(transport==='http'){
  api=createServer(apiHandler);api.listen(0,'127.0.0.1');await once(api,'listening');
  web=createServer(createWebHandler({apiOrigin:`http://127.0.0.1:${api.address().port}`}));
 }else if(transport==='preview')web=createServer(handler);
 if(web){web.listen(port,'127.0.0.1');await once(web,'listening');base=`http://127.0.0.1:${web.address().port}`;}
 async function fetcher(url,options={}){
  if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
  const req=Readable.from(options.body===undefined?[]:[Buffer.from(options.body)]);
  Object.assign(req,{url:String(url).startsWith(base)?String(url).slice(base.length)||'/':String(url),method:options.method??'GET',headers:Object.fromEntries(new Headers(options.headers)),socket:{remoteAddress:'127.0.0.1'}});
  const chunks=[],res=new Writable({write(chunk,encoding,callback){chunks.push(Buffer.from(chunk));callback();}});res.statusCode=200;res.headers={};
  res.writeHead=(status,headers)=>{res.statusCode=status;res.headers=headers;res.headersSent=true;return res;};const done=once(res,'finish');
  await handler(req,res);await done;return new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers});
 }
 return {base,organizationId,otherOrganizationId,tokens,handler,apiHandler,authorization,fetcher,
  async owner(text,params=[]){const client=await connect(null);try{return await client.query(text,params);}finally{client.release();}},
  revoke:(role='equipment_manager')=>identityProvider.revoke(tokens[role]),
  async close(){await Promise.all([web,api].filter(Boolean).map(server=>new Promise(r=>server.close(r))));await available;await db.close();}
 };
}
