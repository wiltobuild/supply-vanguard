// SYNTHETIC TEST ONLY: no operational defaults, persistent grants, network or native cluster.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createAuthorization} from '../../auth/index.mjs';
import {createSupplies} from '../../supplies/index.mjs';
import {createReplenishment} from '../service.mjs';
import {createReplenishmentHandler} from '../http.mjs';

export async function fixture() {
  const db=new PGlite(), A=randomUUID(),B=randomUUID(), users={manager:randomUUID(),other:randomUUID(),viewer:randomUUID(),operator:randomUUID(),outsider:randomUUID()};
  const sql=relative=>readFileSync(new URL(relative,import.meta.url),'utf8');
  await db.exec(sql('../../db/migrations/0001_core.up.sql').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
  for(const id of [A,B]) {
    await db.query('INSERT INTO organization(id,name) VALUES ($1,$2)',[id,'Synthetic test organization']);
    await db.query('INSERT INTO facility(id,organization_id,name) VALUES ($1,$1,$2)',[id,'Synthetic test facility']);
    await db.query('INSERT INTO ward(id,organization_id,facility_id,name) VALUES ($1,$1,$1,$2)',[id,'Synthetic test ward']);
    await db.query("INSERT INTO location(id,organization_id,ward_id,external_key,name,kind) VALUES ($1,$1,$1,'synthetic','Synthetic test store','store')",[id]);
  }
  await db.exec(sql('../../auth/migrations/0001_auth.up.sql'));
  for(const [subject,id] of Object.entries(users)) {
    await db.query("INSERT INTO auth_user(id,issuer,subject) VALUES ($1,'synthetic-sv010-test',$2)",[id,subject]);
    await db.query('INSERT INTO auth_membership(organization_id,user_id,role) VALUES ($1,$2,$3)',
      [subject==='outsider'?B:A,id,subject==='viewer'?'viewer':subject==='operator'?'operator':'supply_manager']);
  }
  await db.exec(`CREATE ROLE sv010_schema_owner NOSUPERUSER NOBYPASSRLS NOLOGIN;
    GRANT USAGE,CREATE ON SCHEMA public TO sv010_schema_owner;
    GRANT REFERENCES ON organization,location,auth_user TO sv010_schema_owner;
    GRANT SELECT ON auth_user,auth_membership TO sv010_schema_owner;
    SET ROLE sv010_schema_owner;`);
  await db.exec(sql('../../supplies/migrations/0001_supplies.up.sql'));
  await db.exec(sql('../migrations/0001_replenishment.up.sql'));
  await db.exec(`RESET ROLE;
    CREATE ROLE sv010_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
    GRANT USAGE ON SCHEMA public TO sv010_runtime;
    GRANT SELECT ON auth_user,auth_membership,organization,facility,ward,location,equipment_type,equipment,equipment_event,equipment_observation TO sv010_runtime;
    GRANT EXECUTE ON FUNCTION auth_resolve_identity(text,text) TO sv010_runtime;
    GRANT SELECT ON supply_sku,supply_bin,supply_bin_stock,supply_stock_transaction,replenishment_par,replenishment_task,replenishment_event,replenishment_receipt TO sv010_runtime;
    GRANT INSERT ON supply_sku,supply_bin,supply_stock_transaction,replenishment_par,replenishment_task,replenishment_event,replenishment_receipt TO sv010_runtime;
    GRANT UPDATE(status,assignee_id,version,completed_at) ON replenishment_task TO sv010_runtime;`);
  // PGlite has ONE SQL connection. Concurrent JS calls are serialized here; never native race proof.
  let available=Promise.resolve(), afterQuery;
  async function connect(role='sv010_runtime') {
    const previous=available;let release;available=new Promise(resolve=>{release=resolve;});await previous;
    await db.exec(role?`SET ROLE ${role}`:'RESET ROLE');
    return {query:async (statement,params)=>{const result=await db.query(statement,params);if(afterQuery)await afterQuery(statement,params,result);return result;},release};
  }
  const auth=createAuthorization({pool:{connect},identityProvider:{verify:async request=>{
    const subject=request?.who || request?.headers?.['x-sv010-test-user'];
    return subject?{issuer:'synthetic-sv010-test',subject}:null;
  }}});
  const supplies=createSupplies({authorization:auth}),service=createReplenishment({authorization:auth});
  const request=(who='manager')=>({who});
  const manager=request();
  const owner=async (statement,params)=>{const c=await connect(null);try{return await c.query(statement,params);}finally{c.release();}};
  const sku=await supplies.createSku(manager,A,{code:'SYNTHETIC-TEST-ONLY',name:'Synthetic test supply',unit:'ml'});
  const newBin=()=>supplies.createBin(manager,A,{skuId:sku.id,locationId:A,code:`SYN-TEST-${randomUUID().slice(0,8)}`});
  const command=(bin,extra={})=>({binId:bin.id,idempotencyKey:randomUUID(),reason:'Synthetic test only',source:'synthetic-test',...extra});
  const stock=(bin,extra={})=>supplies.postStock(manager,A,command(bin,{kind:'restock',delta:'1.125',expectedVersion:0,...extra}));
  const handler=createReplenishmentHandler({replenishment:service});
  const fetchImpl=async (url,options={})=>{
    const input=Readable.from(options.body?[Buffer.from(options.body)]:[]);
    input.url=url;input.method=options.method||'GET';input.headers={'x-sv010-test-user':'manager',...options.headers};
    let status,headers,payload;
    await handler(input,{writeHead(s,h){status=s;headers=h;},end(body){payload=body;}});
    return new Response(payload,{status,headers});
  };
  return {db,A,B,users,auth,supplies,service,request,manager,owner,newBin,command,stock,fetchImpl,
    setAfterQuery(fn){afterQuery=fn;},sql,close:()=>db.close()};
}
