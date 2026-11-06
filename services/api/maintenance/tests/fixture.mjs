// Entirely in-memory PostgreSQL and in-process HTTP streams. No listener, external DB or persistent grants.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {Readable} from 'node:stream';
import {createAuthorization} from '../../auth/index.mjs';
import {createMaintenanceHandler} from '../routes.mjs';
import {ROLE_PERMISSIONS} from '../../auth/roles.mjs';

export async function fixture(){
 const db=new PGlite();
 const sql=path=>readFileSync(new URL(path,import.meta.url),'utf8');
 await db.exec(sql('../../db/migrations/0001_core.up.sql').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
 await db.exec(sql('../../auth/migrations/0001_auth.up.sql'));
 await db.exec(sql('../../equipment/migrations/0001_receipts.up.sql'));
 await db.exec(sql('../../requests/migrations/0001_requests.up.sql'));
 const orgs=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
 for(const [i,org] of orgs.entries()){
  await db.query('INSERT INTO organization(id,name) VALUES ($1,$2)',[org,`Synthetic tenant ${i}`]);
  await db.query("INSERT INTO facility(organization_id,name) VALUES ($1,'Synthetic facility')",[org]);
  await db.query("INSERT INTO ward(organization_id,facility_id,name) SELECT $1,id,'Synthetic ward' FROM facility WHERE organization_id=$1",[org]);
  await db.query("INSERT INTO location(organization_id,ward_id,external_key,name,kind) SELECT $1,id,'store','Synthetic store','store' FROM ward WHERE organization_id=$1",[org]);
  await db.query("INSERT INTO equipment_type(organization_id,model_kind,name) VALUES ($1,'monitor','Synthetic monitor')",[org]);
  for(const [n,status] of ['available','available','cleaning','maintenance','in-use','retired'].entries()){
   await db.query(`INSERT INTO equipment(organization_id,external_id,name,equipment_type_id,location_id,status,provenance)
    SELECT $1,$2,'Synthetic monitor',(SELECT id FROM equipment_type WHERE organization_id=$1),(SELECT id FROM location WHERE organization_id=$1),$3,'synthetic-fixture'`,[org,`EQ-${n+1}`,status]);
  }
 }
 // Provisional allocation leaves status=available; ready search must still omit this asset.
 await db.query("INSERT INTO request(organization_id,requested_by) VALUES ($1,'synthetic')",[orgs[0]]);
 await db.query(`INSERT INTO request_item(organization_id,request_id,line_no,equipment_type_id,state)
  SELECT $1,r.id,1,t.id,'assigned' FROM request r JOIN equipment_type t ON t.organization_id=r.organization_id WHERE r.organization_id=$1`,[orgs[0]]);
 await db.query(`INSERT INTO item_assignment(organization_id,request_item_id,equipment_id,assigned_by)
  SELECT $1,i.id,e.id,'synthetic' FROM request_item i JOIN equipment e ON e.organization_id=i.organization_id WHERE i.organization_id=$1 AND e.external_id='EQ-2'`,[orgs[0]]);
 const users={};let n=10;
 for(const [name,role,org] of [...Object.keys(ROLE_PERMISSIONS).map(role=>[role,role,orgs[0]]),['outsider','admin',orgs[1]]]){
  const id=`00000000-0000-4000-8000-${String(n++).padStart(12,'0')}`;users[name]=id;
  await db.query("INSERT INTO auth_user(id,issuer,subject) VALUES ($1,'urn:synthetic-maintenance',$2)",[id,name]);
  await db.query('INSERT INTO auth_membership(organization_id,user_id,role) VALUES ($1,$2,$3)',[org,id,role]);
 }
 await db.exec(`CREATE ROLE maintenance_fixture_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
  GRANT USAGE ON SCHEMA public TO maintenance_fixture_runtime;
  GRANT SELECT ON auth_user,auth_membership,organization,facility,ward,location,equipment_type,item_assignment TO maintenance_fixture_runtime;
  GRANT SELECT,UPDATE ON equipment TO maintenance_fixture_runtime;
  GRANT SELECT,INSERT ON equipment_event,equipment_command_receipt TO maintenance_fixture_runtime;
  GRANT EXECUTE ON FUNCTION auth_resolve_identity(text,text) TO maintenance_fixture_runtime;`);
 let available=Promise.resolve();
 async function connect(role='maintenance_fixture_runtime'){
  const previous=available;let release;available=new Promise(r=>{release=r;});await previous;
  await db.exec(role?`SET ROLE ${role}`:'RESET ROLE');return {query:(...a)=>db.query(...a),release};
 }
 const owner=async(text,params=[])=>{const c=await connect(null);try{return await c.query(text,params);}finally{c.release();}};
 const authorization=createAuthorization({identityProvider:{verify:async req=>{const who=req.headers.authorization?.replace('Bearer ','');return users[who]?{issuer:'urn:synthetic-maintenance',subject:who}:null;}},pool:{connect}});
 const handler=createMaintenanceHandler({authorization});
 async function call(who,path='',{method='GET',body,key='fixture-key',org=orgs[0],headers={}}={}){
  const req=Readable.from(body===undefined?[]:[Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);
  Object.assign(req,{url:`/organizations/${org}/maintenance/equipment${path}`,method,headers:{authorization:`Bearer ${who}`,'content-type':'application/json','idempotency-key':key,...headers}});
  let status,responseHeaders,data;
  const res={writeHead(code,h){status=code;responseHeaders=h;return this;},end(value){data=JSON.parse(value);return this;}};
  await handler(req,res);return {status,headers:responseHeaders,body:data};
 }
 return {db,orgs,users,owner,call,authorization,close:async()=>{await available;await db.close();}};
}
