import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {database,sql} from './database.mjs';
import {createAuthorization} from '../../auth/index.mjs';
import {createLocalIdentityProvider} from '../../auth/local-identity.mjs';
import {createCheckInHost} from '../host.mjs';
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const users={operator:'00000000-0000-4000-8000-000000000901',other:'00000000-0000-4000-8000-000000000902',viewer:'00000000-0000-4000-8000-000000000903',outsider:'00000000-0000-4000-8000-000000000904'};
let db,server,base,auth,dispatch,host;const identity=createLocalIdentityProvider({mode:'test'}),tokens={};
// In-process HTTP request/response streams still invoke the real route, authorization and SQL.
// Set CHECK_IN_HTTP=network only in an environment with authorized loopback socket access.
async function http(url,options={}) {
 if(process.env.CHECK_IN_HTTP==='network')return fetch(url,options);
 const bytes=options.body===undefined?null:Buffer.from(options.body);
 const req=Readable.from(bytes===null?[]:[bytes.subarray(0,7),bytes.subarray(7)]);
 req.url=new URL(url).pathname;req.method=options.method||'GET';req.headers=Object.fromEntries(Object.entries(options.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));req.socket={remoteAddress:'127.0.0.1'};
 let status,headers,response;const res={writeHead(s,h){status=s;headers=h;},end(data){response=new Response(data,{status,headers});}};
 await dispatch(req,res);return response;
}
const body=(id='EQ-001',location='room-102',time=-60000)=>({equipmentId:id,locationId:location,observedAt:new Date(Date.now()+time).toISOString(),source:'manual-check-in'});
const call=(data,key,who='operator',org=A,options={})=>http(`${base}/organizations/${org}/check-ins`,{method:'POST',headers:{authorization:`Bearer ${tokens[who]}`,'content-type':'application/json','idempotency-key':key,...options.headers},body:typeof data==='string'?data:JSON.stringify(data)});
const owner=async(text,params=[])=>{if(!db.native)await db.query('RESET ROLE');return db.query(text,params);};
const ownerExec=async text=>{if(!db.native)await db.query('RESET ROLE');return db.exec(text);};
const count=async table=>(await owner(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const current=async(id='EQ-001')=>(await owner('SELECT location_id,last_verified_at,status,version,provenance FROM equipment WHERE organization_id=$1 AND external_id=$2',[A,id])).rows[0];
before(async()=>{
 db=await database();
 await db.exec(sql('../../db/migrations/0001_core.up.sql').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
 // Seed before forced RLS: this fixture does not patch the reserved bootstrap implementation.
 await db.exec(sql('../../db/seed/seed.sql'));
 const generated=(await db.query('SELECT id FROM organization')).rows[0].id;
 // Copy synthetic inventory to fixed tenant IDs before forced RLS is enabled.
 await db.exec(`INSERT INTO organization(id,name) VALUES ('${A}','Synthetic check-in A'),('${B}','Synthetic check-in B');
 INSERT INTO facility(id,organization_id,name) VALUES ('${A}','${A}','Fictional A'),('${B}','${B}','Fictional B');
 INSERT INTO ward(id,organization_id,facility_id,name) VALUES ('${A}','${A}','${A}','NICU A'),('${B}','${B}','${B}','NICU B');
 INSERT INTO location(organization_id,ward_id,external_key,name,kind)
 SELECT '${A}','${A}',external_key,name,kind FROM location WHERE organization_id='${generated}';
 INSERT INTO location(organization_id,ward_id,external_key,name,kind) VALUES ('${B}','${B}','room-102','Other room','room');
 INSERT INTO equipment_type(organization_id,model_kind,name) VALUES ('${A}','monitor','Fictional monitor'),('${B}','monitor','Fictional monitor B');
 INSERT INTO equipment(organization_id,external_id,name,equipment_type_id,location_id,status,provenance)
 SELECT '${A}',external_id,name,(SELECT id FROM equipment_type WHERE organization_id='${A}'),(SELECT id FROM location WHERE organization_id='${A}' AND external_key='room-101'),status,provenance FROM equipment WHERE organization_id='${generated}';
 INSERT INTO equipment(organization_id,external_id,name,equipment_type_id,location_id,status,provenance)
 SELECT '${B}','EQ-001','Other synthetic equipment',(SELECT id FROM equipment_type WHERE organization_id='${B}'),(SELECT id FROM location WHERE organization_id='${B}'),'available','synthetic-test';`);
 await db.exec(sql('../../auth/migrations/0001_auth.up.sql'));
 // The merged equipment PATCH service requires its private receipts. Keep SET LOCAL and
 // legacy-key backfill inside the same disposable-fixture migration transaction.
 await db.exec(`BEGIN;\n${sql('../../equipment/migrations/0001_receipts.up.sql')}\nCOMMIT;`);
 await db.exec(sql('../migrations/0001_check_in.up.sql'));
 // PGlite runs its fixture owner as superuser, native PostgreSQL uses a disposable local owner.
 for(const [name,id]of Object.entries(users)) {
  await db.query('INSERT INTO auth_user(id,issuer,subject) VALUES ($1,$2,$3)',[id,'urn:supply-vanguard:local',name]);
  await db.query('INSERT INTO auth_membership(organization_id,user_id,role) VALUES ($1,$2,$3)',[name==='outsider'?B:A,id,name==='viewer'?'viewer':'operator']);tokens[name]=identity.issue(name);
 }
 await db.exec(`CREATE ROLE sv_check_in_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
 GRANT USAGE ON SCHEMA public TO sv_check_in_runtime;
 GRANT SELECT,INSERT,UPDATE ON equipment,equipment_observation,equipment_event,check_in_receipt TO sv_check_in_runtime;
 GRANT SELECT,INSERT ON equipment_command_receipt TO sv_check_in_runtime;
 GRANT SELECT ON organization,location,equipment_type,auth_user,auth_membership TO sv_check_in_runtime;
 GRANT EXECUTE ON FUNCTION auth_resolve_identity(text,text) TO sv_check_in_runtime;`);
 auth=createAuthorization({identityProvider:identity,pool:{connect:()=>db.connect()}});
 host=createCheckInHost({identityProvider:identity,pool:{connect:()=>db.connect()}});await host.ready();
 dispatch=host.handle;
 base='http://127.0.0.1';
 if(process.env.CHECK_IN_HTTP==='network'){server=createServer(dispatch);server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 console.log(`Check-in SQL backend: ${db.native?'native PostgreSQL, independent connections':'PGlite, serialized connections'}`);
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(host)await host.close();if(db)await db.close();});

test('manual, QR and barcode check-ins preserve identity, attribution, provenance and truthful times',async()=>{
 for(const [i,source]of ['manual-check-in','qr','barcode'].entries()){
  const input={...body(`EQ-00${i+1}`),source},res=await call(input,`entry-${i}`,'operator',A,{headers:{'x-correlation-id':`entry-correlation-${i}`}}),out=await res.json();assert.equal(res.status,201,JSON.stringify(out));
  assert.equal(out.record.id,input.equipmentId);assert.equal(out.record.provenance,'synthetic-seed');assert.equal(out.observation.source,source);
  assert.equal(out.observation.actor,`user:${users.operator}`);assert.equal(out.observation.observedAt,input.observedAt);assert.ok(Date.parse(out.observation.receivedAt)>=Date.parse(input.observedAt));assert.equal(out.record.version,0);
  const observation=(await owner('SELECT actor,correlation_id FROM equipment_observation WHERE organization_id=$1 AND idempotency_key=$2',[A,`check-in:entry-${i}`])).rows[0];assert.deepEqual(observation,{actor:`user:${users.operator}`,correlation_id:`entry-correlation-${i}`});
 }
 const result=await http(`${base}/organizations/${A}/check-ins/locations`,{headers:{authorization:`Bearer ${tokens.operator}`}});assert.equal(result.status,200);assert.equal((await result.json()).items.length,10);
});
test('check-in and administrative PATCH replays retain original snapshots after later edits without duplicate history',async()=>{
 const input=body('EQ-004'),first=await (await call(input,'replay')).json();
 const newer={...body('EQ-004','room-103',-1000),source:'qr'};assert.equal((await call(newer,'intervening')).status,201);
 const patch=(body,key)=>http(`${base}/organizations/${A}/equipment/EQ-004`,{method:'PATCH',headers:{authorization:`Bearer ${tokens.operator}`,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
 const adminBody={expectedVersion:0,note:'Synthetic later administrative edit'},edit=await patch(adminBody,'after-check-in');assert.equal(edit.status,200);
 const adminFirst=await edit.json();assert.equal(adminFirst.record.version,1);assert.equal(adminFirst.record.note,adminBody.note);
 assert.equal((await patch({expectedVersion:1,note:'Synthetic newest administrative edit'},'after-check-in-newer')).status,200);
 const n=await count('equipment_observation'),e=await count('equipment_event'),r=await count('equipment_command_receipt'),c=await count('check_in_receipt');
 const adminRetry=await patch(adminBody,'after-check-in');assert.equal(adminRetry.status,200);assert.equal(adminRetry.headers.get('Idempotent-Replay'),'true');assert.deepEqual(await adminRetry.json(),{...adminFirst,changed:false,replayed:true});
 const retry=await call(input,'replay'),out=await retry.json();assert.equal(retry.status,200);assert.deepEqual(out,{...first,replayed:true});assert.equal(await count('equipment_observation'),n);assert.equal(await count('equipment_event'),e);
 assert.equal(await count('equipment_command_receipt'),r);assert.equal(await count('check_in_receipt'),c);
 const currentRecord=await http(`${base}/organizations/${A}/equipment/EQ-004`,{headers:{authorization:`Bearer ${tokens.operator}`}}).then(r=>r.json());assert.equal(currentRecord.locationId,'room-103');assert.equal(currentRecord.version,2);assert.equal(currentRecord.note,'Synthetic newest administrative edit');
 const receipt=(await owner("SELECT actor_id,request,result FROM equipment_command_receipt WHERE organization_id=$1 AND idempotency_key='admin:after-check-in'",[A])).rows[0];assert.equal(receipt.actor_id,users.operator);assert.deepEqual(receipt.request,adminBody);assert.deepEqual(receipt.result,adminFirst);
});
test('fixture grants only SELECT and INSERT on merged equipment receipts to its runtime role',async()=>{
 const privileges=(await owner(`SELECT has_table_privilege('sv_check_in_runtime','equipment_command_receipt','SELECT') AS can_select,
 has_table_privilege('sv_check_in_runtime','equipment_command_receipt','INSERT') AS can_insert,
 has_table_privilege('sv_check_in_runtime','equipment_command_receipt','UPDATE') AS can_update,
 has_table_privilege('sv_check_in_runtime','equipment_command_receipt','DELETE') AS can_delete`)).rows[0];
 assert.deepEqual(privileges,{can_select:true,can_insert:true,can_update:false,can_delete:false});
 const policy=(await owner("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='equipment_command_receipt'::regclass")).rows[0];assert.deepEqual(policy,{relrowsecurity:true,relforcerowsecurity:true});
});
test('changed payload, target, source, time, correlation and actor cannot reuse a successful key',async()=>{
 const input=body('EQ-005');assert.equal((await call(input,'bound')).status,201);
 for(const changed of [{...input,equipmentId:'EQ-006'},{...input,locationId:'room-104'},{...input,source:'qr'},{...input,observedAt:new Date(Date.parse(input.observedAt)-1000).toISOString()}])assert.equal((await call(changed,'bound')).status,409);
 assert.equal((await call(input,'bound','other')).status,409);
 assert.equal((await call(input,'bound','operator',A,{headers:{'x-correlation-id':'new'}})).status,409);
 assert.equal((await call(input,'bound','operator',B)).status,403);
 assert.equal((await call({...input,equipmentId:'EQ-001'},'bound','outsider',B)).status,201,'tenant key namespaces are isolated');
});
test('unknown IDs, invalid locations, unsafe payloads and malformed HTTP requests have no effects',async()=>{
 const n=await count('equipment_observation'),r=await count('check_in_receipt');
 const cases=[[body('UNKNOWN'),404],[body('EQ-001','nowhere'),400],[{...body(),actor:'fake'},400],[{...body(),source:'rtls'},400],[{...body(),equipmentId:'https://evil.test'},400],[{...body(),equipmentId:'<img>'},400],[{...body(),equipmentId:'A'.repeat(65)},400],[{...body(),observedAt:'2026-02-30T12:00:00Z'},400],[body('EQ-001','room-101',3600000),400]];
 for(const [input,status]of cases){const res=await call(input,'invalid');assert.equal(res.status,status,await res.text());}
 assert.equal((await call('{bad','invalid')).status,400);assert.equal((await call('x'.repeat(2049),'invalid')).status,413);
 assert.equal((await call(body(),'invalid','operator',A,{headers:{'content-type':'text/plain'}})).status,415);
 assert.equal((await call(body(),'!invalid')).status,400);assert.equal(await count('equipment_observation'),n);assert.equal(await count('check_in_receipt'),r);
});
test('authorization is current on retries and audit history stays restricted',async()=>{
 const input=body('EQ-006');assert.equal((await call(input,'revoked')).status,201);
 assert.equal((await call(input,'viewer','viewer')).status,403);
 assert.equal((await http(`${base}/organizations/${A}/check-ins`,{method:'POST',body:'{bad'})).status,401);
 assert.equal((await call(input,'foreign','outsider',A)).status,403);
 await owner('UPDATE auth_membership SET active=false WHERE organization_id=$1 AND user_id=$2',[A,users.operator]);
 assert.equal((await call(input,'revoked')).status,403);
 await owner('UPDATE auth_membership SET active=true WHERE organization_id=$1 AND user_id=$2',[A,users.operator]);
 const events=await auth.run({headers:{authorization:`Bearer ${tokens.operator}`},socket:{remoteAddress:'127.0.0.1'}}, {organizationId:A,permission:'equipment:write'},ctx=>ctx.query('SELECT * FROM equipment_event'));
 assert.equal(events.rows.length,0);
});
test('late observation is recorded once without teleporting verified equipment backward',async()=>{
 const first=body('EQ-007','room-104',-1000);assert.equal((await call(first,'fresh')).status,201);
 const old=body('EQ-007','room-105',-3600000),out=await (await call(old,'late')).json();assert.equal(out.applied,false);assert.equal(out.record.locationId,'room-104');assert.equal(out.observation.locationId,'room-105');
 assert.equal((await call(old,'late')).status,200);
});
test('failure after observation and equipment writes rolls back state, event and reservation',async()=>{
 const before=await current('EQ-008'),n=await count('equipment_observation'),e=await count('equipment_event'),r=await count('check_in_receipt');
 await ownerExec(`CREATE FUNCTION fail_check_in_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.idempotency_key='observation:check-in:rollback' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER fail_check_in_test BEFORE INSERT ON equipment_event FOR EACH ROW EXECUTE FUNCTION fail_check_in_test();`);
 assert.equal((await call(body('EQ-008'),'rollback')).status,500);
 assert.deepEqual(await current('EQ-008'),before);assert.equal(await count('equipment_observation'),n);assert.equal(await count('equipment_event'),e);assert.equal(await count('check_in_receipt'),r);
 await ownerExec('DROP TRIGGER fail_check_in_test ON equipment_event; DROP FUNCTION fail_check_in_test();');
 assert.equal((await call(body('EQ-008'),'rollback')).status,201);
});
test('concurrent identical requests produce exactly one observation and audit event',async()=>{
 const input=body('EQ-001','room-106',-100),n=await count('equipment_observation'),e=await count('equipment_event');
 const responses=await Promise.all(Array.from({length:8},()=>call(input,'concurrent')));
 assert.equal(responses.filter(r=>r.status===201).length,1);assert.equal(responses.filter(r=>r.status===200).length,7);
 assert.equal(await count('equipment_observation'),n+1);assert.equal(await count('equipment_event'),e+1);
});
test('competing changed-key requests and actor collisions cannot duplicate or misattribute an observation',async()=>{
 const input=body('EQ-003','room-104',-10),n=await count('equipment_observation');
 const results=await Promise.all([call(input,'competing'),call({...input,locationId:'room-105'},'competing'),call(input,'competing','other')]);
 assert.equal(results.filter(r=>r.status===201).length,1);assert.equal(results.filter(r=>r.status===409).length,2);assert.equal(await count('equipment_observation'),n+1);
 const obs=(await owner("SELECT actor,location_id FROM equipment_observation WHERE organization_id=$1 AND idempotency_key='check-in:competing'",[A])).rows[0];
 assert.ok([`user:${users.operator}`,`user:${users.other}`].includes(obs.actor));
});
test('receipts are private to their actor and immutable after success; inactive users cannot replay',async()=>{
 const input=body('EQ-005','room-106',-10);assert.equal((await call(input,'private')).status,201);
 const request=who=>({headers:{authorization:`Bearer ${tokens[who]}`},socket:{remoteAddress:'127.0.0.1'}}),scope={organizationId:A,permission:'equipment:write'};
 const hidden=await auth.run(request('other'),scope,ctx=>ctx.query("SELECT result FROM check_in_receipt WHERE idempotency_key='private'"));assert.equal(hidden.rows.length,0);
 await assert.rejects(()=>auth.run(request('operator'),scope,ctx=>ctx.query("UPDATE check_in_receipt SET result='{}'::jsonb WHERE idempotency_key='private'")),/immutable/);
 await owner('UPDATE auth_user SET active=false WHERE id=$1',[users.operator]);assert.equal((await call(input,'private')).status,401);await owner('UPDATE auth_user SET active=true WHERE id=$1',[users.operator]);
 assert.equal((await call(input,'private')).status,200);
});
test('failure while finalizing receipt rolls back the already-written observation and event',async()=>{
 const before=await current('EQ-006'),n=await count('equipment_observation'),e=await count('equipment_event');
 await ownerExec(`CREATE FUNCTION fail_receipt_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.idempotency_key='receipt-failure' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER fail_receipt_test BEFORE UPDATE ON check_in_receipt FOR EACH ROW EXECUTE FUNCTION fail_receipt_test();`);
 assert.equal((await call(body('EQ-006','room-106',-10),'receipt-failure')).status,500);assert.deepEqual(await current('EQ-006'),before);assert.equal(await count('equipment_observation'),n);assert.equal(await count('equipment_event'),e);
 await ownerExec('DROP TRIGGER fail_receipt_test ON check_in_receipt; DROP FUNCTION fail_receipt_test();');
 assert.equal((await call(body('EQ-006','room-106',-10),'receipt-failure')).status,201);
});
test('native lock waiter reads fresh equipment after a different observation commits',async t=>{
 if(!db.native){t.skip('PGlite serializes; independent native lock waiter required');return;}
 const blocker=await db.connect();const input=body('EQ-002','room-106',-10);
 try{
  await blocker.query('BEGIN');await blocker.query("SELECT set_config('sv.user_id',$1,true),set_config('sv.organization_id',$2,true)",[users.operator,A]);
  await blocker.query("UPDATE equipment SET location_id=(SELECT id FROM location WHERE organization_id=$1 AND external_key='room-103') WHERE organization_id=$1 AND external_id='EQ-002'",[A]);
  const waiting=call(input,'lock-wait');let blocked=false;
  for(let i=0;i<100;i++){const r=await owner("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='sv_check_in_runtime' AND wait_event_type='Lock'");if(r.rows[0].n){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}
  assert.equal(blocked,true,'proved independent request waited on a live row lock');await blocker.query('COMMIT');
  const response=await waiting;assert.equal(response.status,201,await response.clone().text());assert.equal((await response.json()).record.locationId,'room-106');
 }finally{await blocker.query('ROLLBACK');blocker.release();}
});
