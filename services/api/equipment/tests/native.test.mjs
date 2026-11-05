// Native PostgreSQL only: no skip/fallback to a single-connection emulator.
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createAuthorization} from '../../auth/index.mjs';
import {createLocalIdentityProvider} from '../../auth/local-identity.mjs';
import {createEquipmentHandler} from '../routes.mjs';
import {updateEquipment,recordObservation,getEquipment} from '../service.mjs';

const sql=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const identityProvider=createLocalIdentityProvider({mode:'test'});
const ids={},tokens={};
let embedded,admin,pool,authorization,server,base,orgA,orgB,control,database;
const runtimeRole=`sv_equipment_${randomUUID().replaceAll('-','')}`;
const owner=(text,values=[])=>admin.query(text,values);
const key=()=>randomUUID();
const request=who=>({socket:{remoteAddress:'127.0.0.1'},headers:{authorization:`Bearer ${tokens[who]}`}});
const run=(who,work,org=orgA)=>authorization.run(request(who),{organizationId:org,permission:'equipment:write'},work);
const edit=(who,id,body,idem,org)=>run(who,ctx=>updateEquipment(ctx,id,body,{idempotencyKey:idem}),org);
const read=(id,org=orgA)=>run('operator',ctx=>getEquipment(ctx,id),org);
const patch=async(who,id,body,idem,{org=orgA,correlationId}={})=>{
 const response=await fetch(`${base}/organizations/${org}/equipment/${id}`,{method:'PATCH',headers:{authorization:`Bearer ${tokens[who]}`,'content-type':'application/json','idempotency-key':idem,...(correlationId&&{'x-correlation-id':correlationId})},body:JSON.stringify(body)});
 return {status:response.status,replay:response.headers.get('idempotent-replay'),body:await response.json()};
};
const counts=async(id,org=orgA)=>(await owner(`SELECT e.version,
 (SELECT count(*)::int FROM equipment_event WHERE organization_id=e.organization_id AND equipment_id=e.id) AS events,
 (SELECT count(*)::int FROM equipment_command_receipt WHERE organization_id=e.organization_id AND equipment_id=e.id AND NOT legacy) AS receipts,
 (SELECT count(*)::int FROM equipment_observation WHERE organization_id=e.organization_id AND equipment_id=e.id) AS observations
 FROM equipment e WHERE e.organization_id=$1 AND e.external_id=$2`,[org,id])).rows[0];
const conflict=error=>error.status===409;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function waitForBlock(pid,blocker){
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){
  const {rows}=await owner('SELECT pg_blocking_pids($1) AS blockers',[pid]);
  if(rows[0].blockers.includes(blocker))return;
  await delay(10);
 }
 throw new Error(`Session ${pid} never waited on session ${blocker}`);
}
// A executes the real command, holds the transaction open, B submits on another native
// session, and pg_blocking_pids proves B actually waited before A is allowed to commit.
async function overlap(commandA,commandB){
 const held=deferred(),release=deferred(),started=deferred();
 const first=run('operator',async ctx=>{
  const pid=(await ctx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const result=await commandA(ctx);held.resolve({pid,result});await release.promise;return result;
 });
 // Always observe errors even when a barrier assertion fails.
 const firstResult=first.then(value=>({value}),error=>({error}));
 let secondResult;
 try{
  const a=await Promise.race([held.promise,firstResult.then(r=>{if(r.error)throw r.error;throw new Error('Missing hold');})]);
  secondResult=run('operator',async ctx=>{
   const pid=(await ctx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;started.resolve(pid);
   return commandB(ctx);
  }).then(value=>({value}),error=>({error}));
  const pid=await started.promise;assert.notEqual(pid,a.pid);
  await waitForBlock(pid,a.pid);
 }finally{release.resolve();}
 const [a,b]=await Promise.all([firstResult,secondResult]);
 if(a.error)throw a.error;
 return {a:a.value,b};
}

before(async()=>{
 let config;
 if(process.env.EQUIPMENT_TEST_DATABASE_URL){
  // This URL must refer to an explicitly disposable local test cluster with CREATE DATABASE.
  config={connectionString:process.env.EQUIPMENT_TEST_DATABASE_URL};
 }else{
  const {default:EmbeddedPostgres}=await import('embedded-postgres');
  // No OS account or persistent service. Bind only loopback with a random per-run password.
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const password=randomUUID();
  embedded=new EmbeddedPostgres({databaseDir:mkdtempSync(join(tmpdir(),'sv023-native-')),user:'sv_fixture',password,port,
   persistent:false,createPostgresUser:false,autoRehydrateSymlinks:true,
   postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await embedded.initialise();await embedded.start();
  config={host:'127.0.0.1',port,user:'sv_fixture',password,database:'postgres'};
 }
 control=new pg.Client(config);await control.connect();
 database=`sv023_${randomUUID().replaceAll('-','')}`;
 await control.query(`CREATE DATABASE ${database}`);
 config=config.connectionString?{connectionString:config.connectionString.replace(/\/[^/?]*(\?.*)?$/,`/${database}$1`)}:{...config,database};
 admin=new pg.Client(config);await admin.connect();
 console.log(`Native fixture: ${(await owner('SELECT version() AS version')).rows[0].version}; pg ${pg.version??'8.23.1'}`);
 await owner(sql('../../db/migrations/0001_core.up.sql'));
 // Fixture loading precedes FORCE RLS; this does not exercise or repair the reserved SV-019 bootstrap.
 await owner(sql('../../db/seed/seed.sql'));
 orgA=(await owner("SELECT id FROM organization WHERE name LIKE 'Demo%'")).rows[0].id;
 orgB=(await owner("INSERT INTO organization(name) VALUES ('SV023 other synthetic tenant') RETURNING id")).rows[0].id;
 await owner(`WITH f AS (INSERT INTO facility(organization_id,name) VALUES ($1,'test') RETURNING id),
  w AS (INSERT INTO ward(organization_id,facility_id,name) SELECT $1,id,'test' FROM f RETURNING id)
  INSERT INTO location(organization_id,ward_id,external_key,name,kind) SELECT $1,id,'room-101','test','room' FROM w`,[orgB]);
 await owner("INSERT INTO equipment_type(organization_id,model_kind,name) VALUES ($1,'monitor','test')",[orgB]);
 await owner(`INSERT INTO equipment(organization_id,external_id,name,equipment_type_id,location_id,status,provenance)
  SELECT $1,'EQ-001','other tenant',t.id,l.id,'available','synthetic-test' FROM equipment_type t JOIN location l USING(organization_id) WHERE t.organization_id=$1`,[orgB]);
 // Additional task-only synthetic records give every test independent versions and keys.
 for(const id of ['REPLAY','NOOP','SAMEKEY','SAMEVERSION','ROLLBACK','RECEIPTFAIL','LEGACY','CROSS','IMMUTABLE','REVOKE','KEYRACE-A','KEYRACE-B']){
  await owner(`INSERT INTO equipment(organization_id,external_id,name,equipment_type_id,location_id,status,provenance)
   SELECT organization_id,$2,$2,equipment_type_id,location_id,'available','synthetic-test' FROM equipment WHERE organization_id=$1 AND external_id='EQ-001'`,[orgA,id]);
 }
 await owner(`INSERT INTO equipment_event(organization_id,equipment_id,kind,actor,source,idempotency_key,after_state)
  SELECT organization_id,id,'admin','legacy-actor','admin','admin:legacy-key','{"status":"available","version":0}' FROM equipment WHERE external_id='LEGACY'`);
 await owner(sql('../../auth/migrations/0001_auth.up.sql'));
 for(const [who,role] of [['operator','operator'],['other','operator'],['manager','equipment_manager'],['viewer','viewer']]){
  ids[who]=(await owner('INSERT INTO auth_user(issuer,subject) VALUES ($1,$2) RETURNING id',['urn:supply-vanguard:local',who])).rows[0].id;
  await owner('INSERT INTO auth_membership(organization_id,user_id,role) VALUES ($1,$2,$3)',[orgA,ids[who],role]);
  tokens[who]=identityProvider.issue(who);
 }
 await owner("INSERT INTO auth_membership(organization_id,user_id,role) VALUES ($1,$2,'operator')",[orgB,ids.operator]);
 await owner(`BEGIN; ${sql('../migrations/0001_receipts.up.sql')} COMMIT;`);
 await owner(`CREATE ROLE ${runtimeRole} NOSUPERUSER NOBYPASSRLS NOLOGIN;
  GRANT USAGE ON SCHEMA public TO ${runtimeRole};
  GRANT SELECT,INSERT,UPDATE,DELETE ON organization,facility,ward,location,equipment_type,equipment,equipment_observation,equipment_event TO ${runtimeRole};
  GRANT SELECT ON auth_user,auth_membership TO ${runtimeRole};
  GRANT SELECT,INSERT ON equipment_command_receipt TO ${runtimeRole};
  GRANT EXECUTE ON FUNCTION auth_resolve_identity(text,text) TO ${runtimeRole};`);
 pool=new pg.Pool({...config,max:12});
 authorization=createAuthorization({identityProvider,pool:{connect:async()=>{
  const client=await pool.connect();await client.query(`SET ROLE ${runtimeRole}`);return client;
 }}});
 server=createServer(createEquipmentHandler({authorization}));server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{
 if(server)await new Promise(r=>server.close(r));
 if(pool)await pool.end();
 if(admin)await admin.end();
 if(control){
  if(database)await control.query(`DROP DATABASE ${database}`);
  await control.query(`DROP ROLE IF EXISTS ${runtimeRole}`);await control.end();
 }
 if(embedded)await embedded.stop();
});

test('operator replay retains original full snapshot after later edits/observations; audit remains private',async()=>{
 const idem=key(),body={expectedVersion:0,status:'cleaning',note:''};
 const first=await patch('operator','REPLAY',body,idem,{correlationId:'first-attempt'});
 assert.equal(first.status,200);assert.equal(first.body.changed,true);
 await edit('manager','REPLAY',{expectedVersion:1,note:'later'},key());
 await run('operator',ctx=>recordObservation(ctx,'REPLAY',{locationId:'room-104',observedAt:new Date(Date.now()-1000).toISOString(),source:'barcode'},{idempotencyKey:key()}));
 const before=await counts('REPLAY');
 const again=await patch('operator','REPLAY',{note:'',status:'cleaning',expectedVersion:0},idem,{correlationId:'retry-trace'});
 assert.equal(again.status,200);assert.equal(again.replay,'true');
 assert.deepEqual(again.body,{record:first.body.record,changed:false,replayed:true});
 assert.deepEqual(await counts('REPLAY'),before);
 assert.equal((await read('REPLAY')).note,'later');assert.equal((await read('REPLAY')).locationId,'room-104');
 await run('operator',async ctx=>{
  assert.deepEqual((await ctx.query('SELECT * FROM equipment_event')).rows,[]);
  const receipts=(await ctx.query('SELECT * FROM equipment_command_receipt')).rows;
  const receipt=receipts.find(r=>r.idempotency_key===`admin:${idem}`);
  assert.equal(receipt.correlation_id,'first-attempt');assert.deepEqual(receipt.result,first.body);
 });
});
test('changed/omitted fields, different actor and target cannot reuse a receipt',async()=>{
 const idem=key(),body={expectedVersion:0,status:'cleaning',note:''};
 await edit('operator','CROSS',body,idem);
 for(const bad of [{expectedVersion:0,status:'cleaning'},{expectedVersion:0,note:''},{...body,note:'x'},{...body,expectedVersion:1}]){
  assert.equal((await patch('operator','CROSS',bad,idem)).status,409);
 }
 assert.equal((await patch('other','CROSS',{expectedVersion:1,note:'stolen'},idem)).status,409);
 assert.equal((await patch('manager','CROSS',body,idem)).status,409);
 assert.equal((await patch('operator','EQ-001',{expectedVersion:0,status:'cleaning',note:''},idem)).status,409);
 assert.equal((await read('CROSS')).note,'');assert.equal((await counts('CROSS')).events,1);
 await run('other',async ctx=>assert.deepEqual((await ctx.query('SELECT * FROM equipment_command_receipt WHERE idempotency_key=$1',[`admin:${idem}`])).rows,[]));
});
test('tenant-scoped keys expose no foreign snapshots; unauthorized tenant fails',async()=>{
 const idem=key();
 const a=await patch('operator','EQ-001',{expectedVersion:0,note:'tenant A'},idem);
 const b=await patch('operator','EQ-001',{expectedVersion:0,note:'tenant B'},idem,{org:orgB});
 assert.equal(a.status,200);assert.equal(b.status,200);
 assert.equal((await patch('operator','EQ-001',{expectedVersion:0,note:'tenant A'},idem,{org:orgB})).status,409);
 assert.equal((await patch('other','EQ-001',{expectedVersion:0,note:'tenant B'},idem,{org:orgB})).status,403);
 assert.equal((await patch('operator','EQ-001',{expectedVersion:0,note:'tenant A'},idem)).body.record.note,'tenant A');
 await run('operator',async ctx=>assert.ok((await ctx.query('SELECT organization_id FROM equipment_command_receipt')).rows.every(r=>r.organization_id===orgA)));
});
test('successful no-ops receive immutable snapshots and reserve keys, including empty body fields',async()=>{
 const idem=key(),empty=key();
 const first=await edit('operator','NOOP',{expectedVersion:0,status:'available'},idem);
 assert.equal(first.changed,false);assert.equal(first.replayed,false);
 await edit('operator','NOOP',{expectedVersion:0},empty);
 await edit('operator','NOOP',{expectedVersion:0,note:'later'},key());
 assert.deepEqual(await edit('operator','NOOP',{expectedVersion:0,status:'available'},idem),{...first,replayed:true});
 assert.equal((await edit('operator','NOOP',{expectedVersion:0},empty)).record.version,0);
 await assert.rejects(edit('operator','NOOP',{expectedVersion:0},idem),conflict);
 await assert.rejects(edit('other','NOOP',{expectedVersion:1,status:'available'},idem),conflict);
 assert.deepEqual(await counts('NOOP'),{version:1,events:1,receipts:3,observations:0});
});
test('membership, permission and identity revocation deny receipt replay',async()=>{
 const idem=key(),body={expectedVersion:0,note:'first'};
 await edit('other','REVOKE',body,idem);
 for(const [disable,restore] of [
  ["UPDATE auth_membership SET active=false WHERE user_id=$1","UPDATE auth_membership SET active=true WHERE user_id=$1"],
  ["UPDATE auth_membership SET role='viewer' WHERE user_id=$1","UPDATE auth_membership SET role='operator' WHERE user_id=$1"],
  ["UPDATE auth_user SET active=false WHERE id=$1","UPDATE auth_user SET active=true WHERE id=$1"]]){
  await owner(disable,[ids.other]);
  try{assert.ok([401,403].includes((await patch('other','REVOKE',body,idem)).status));}
  finally{await owner(restore,[ids.other]);}
 }
 assert.equal((await patch('other','REVOKE',body,idem)).status,200);
});
test('native overlapping same-key retry waits, then returns original success with one write',async()=>{
 const idem=key(),body={expectedVersion:0,note:'exactly once'};
 const {a,b}=await overlap(ctx=>updateEquipment(ctx,'SAMEKEY',body,{idempotencyKey:idem}),ctx=>updateEquipment(ctx,'SAMEKEY',body,{idempotencyKey:idem}));
 assert.ifError(b.error);assert.deepEqual(b.value,{...a,changed:false,replayed:true});
 assert.deepEqual(await counts('SAMEKEY'),{version:1,events:1,receipts:1,observations:0});
});
test('native overlapping same-version distinct keys have exactly one winner',async()=>{
 const {b}=await overlap(ctx=>updateEquipment(ctx,'SAMEVERSION',{expectedVersion:0,note:'winner'},{idempotencyKey:key()}),ctx=>updateEquipment(ctx,'SAMEVERSION',{expectedVersion:0,note:'loser'},{idempotencyKey:key()}));
 assert.equal(b.error?.code,'version_conflict');assert.equal((await read('SAMEVERSION')).note,'winner');
 assert.deepEqual(await counts('SAMEVERSION'),{version:1,events:1,receipts:1,observations:0});
});
test('native same-key cross-target race rolls the losing update and its event back',async()=>{
 const idem=key(),body={expectedVersion:0,note:'one target only'};
 const {b}=await overlap(ctx=>updateEquipment(ctx,'KEYRACE-A',body,{idempotencyKey:idem}),ctx=>updateEquipment(ctx,'KEYRACE-B',body,{idempotencyKey:idem}));
 assert.equal(b.error?.code,'idempotency_key_reused');
 assert.deepEqual(await counts('KEYRACE-A'),{version:1,events:1,receipts:1,observations:0});
 assert.deepEqual(await counts('KEYRACE-B'),{version:0,events:0,receipts:0,observations:0});
});
test('newer observation waiting behind a location change is recorded and applied, never false 404',async()=>{
 const older=new Date(Date.now()-60000).toISOString(),newer=new Date(Date.now()-1000).toISOString();
 const {a,b}=await overlap(ctx=>recordObservation(ctx,'EQ-002',{locationId:'room-103',observedAt:older,source:'barcode'},{idempotencyKey:'wait-observation-A'}),ctx=>recordObservation(ctx,'EQ-002',{locationId:'room-104',observedAt:newer,source:'qr'},{idempotencyKey:'wait-observation-B'}));
 assert.ifError(b.error);assert.equal(a.applied,true);assert.equal(b.value.applied,true);
 assert.equal(b.value.record.locationId,'room-104');assert.deepEqual(b.value.record.lastVerified,{locationId:'room-104',observedAt:newer,source:'qr'});
 assert.deepEqual(await counts('EQ-002'),{version:0,events:2,receipts:0,observations:2});
 const history=(await owner("SELECT before_state,after_state FROM equipment_event WHERE idempotency_key='observation:wait-observation-B'")).rows[0];
 assert.equal(history.before_state.locationId,'room-103');assert.equal(history.after_state.locationId,'room-104');
});
test('PATCH waiting behind a location change reads the fresh joined location and preserves confidence',async()=>{
 const observedAt=new Date(Date.now()-1000).toISOString();
 const {b}=await overlap(ctx=>recordObservation(ctx,'EQ-004',{locationId:'room-103',observedAt,source:'manual-check-in'},{idempotencyKey:key()}),ctx=>updateEquipment(ctx,'EQ-004',{expectedVersion:0,status:'cleaning'},{idempotencyKey:key()}));
 assert.ifError(b.error);assert.equal(b.value.record.locationId,'room-103');
 assert.deepEqual(b.value.record.lastVerified,{locationId:'room-103',observedAt,source:'manual-check-in'});
 assert.deepEqual(await counts('EQ-004'),{version:1,events:2,receipts:1,observations:1});
});
test('audit-key collision and receipt insertion failure roll state, audit and receipt back together',async()=>{
 await owner(`INSERT INTO equipment_event(organization_id,equipment_id,kind,actor,source,idempotency_key,after_state)
  SELECT organization_id,id,'admin','legacy','admin','admin:late-collision','{}' FROM equipment WHERE external_id='ROLLBACK'`);
 const before=await read('ROLLBACK');
 await assert.rejects(edit('operator','ROLLBACK',{expectedVersion:0,note:'must roll back'},'late-collision'),conflict);
 assert.deepEqual(await read('ROLLBACK'),before);assert.equal((await counts('ROLLBACK')).receipts,0);
 await owner(`CREATE FUNCTION sv023_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.idempotency_key='admin:injected-failure' THEN RAISE EXCEPTION 'fixture receipt failure'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER sv023_fail_receipt BEFORE INSERT ON equipment_command_receipt FOR EACH ROW EXECUTE FUNCTION sv023_fail_receipt();`);
 try{
  await assert.rejects(edit('operator','RECEIPTFAIL',{expectedVersion:0,note:'must roll back'},'injected-failure'),/fixture receipt failure/);
  assert.deepEqual(await counts('RECEIPTFAIL'),{version:0,events:0,receipts:0,observations:0});
  assert.equal((await read('RECEIPTFAIL')).note,undefined);
 }finally{await owner('DROP TRIGGER sv023_fail_receipt ON equipment_command_receipt; DROP FUNCTION sv023_fail_receipt()');}
});
test('legacy keys are reserved without fabricated snapshots, including no-op collision',async()=>{
 for(const who of ['operator','manager']){
  await assert.rejects(edit(who,'LEGACY',{expectedVersion:0,status:'available'},'legacy-key'),conflict);
  await assert.rejects(edit(who,'LEGACY',{expectedVersion:0,note:'must roll back'},'legacy-key'),conflict);
 }
 assert.deepEqual(await counts('LEGACY'),{version:0,events:1,receipts:0,observations:0});
 const legacy=(await owner("SELECT actor_id,request,result,legacy FROM equipment_command_receipt WHERE idempotency_key='admin:legacy-key'")).rows[0];
 assert.deepEqual(legacy,{actor_id:null,request:null,result:null,legacy:true});
});
test('receipt FORCE RLS, append-only trigger, grants and tenant/actor foreign keys enforce the boundary',async()=>{
 await edit('operator','IMMUTABLE',{expectedVersion:0,note:'first'},'immutable');
 assert.deepEqual((await owner("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='equipment_command_receipt'::regclass")).rows[0],{relrowsecurity:true,relforcerowsecurity:true});
 for(const statement of ["UPDATE equipment_command_receipt SET result='{}' WHERE idempotency_key='admin:immutable'","DELETE FROM equipment_command_receipt WHERE idempotency_key='admin:immutable'"]){
  await assert.rejects(owner(statement),/append-only/);
  await assert.rejects(run('operator',ctx=>ctx.query(statement)),/permission denied/);
 }
 await assert.rejects(run('operator',ctx=>ctx.query(`INSERT INTO equipment_command_receipt(organization_id,equipment_id,actor_id,idempotency_key,request,result)
  SELECT organization_id,id,$1,'admin:spoof','{}','{}' FROM equipment WHERE external_id='IMMUTABLE'`,[ids.other])),/row-level security/);
 const foreignEquipment=(await owner("SELECT id FROM equipment WHERE organization_id=$1",[orgB])).rows[0].id;
 await assert.rejects(owner(`INSERT INTO equipment_command_receipt(organization_id,equipment_id,actor_id,idempotency_key,request,result) VALUES ($1,$2,$3,'admin:bad-fk','{}','{}')`,[orgA,foreignEquipment,ids.operator]),/foreign key/);
});
