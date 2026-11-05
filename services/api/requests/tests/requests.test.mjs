import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createAuthorization} from '../../auth/index.mjs';
import {createLocalIdentityProvider} from '../../auth/local-identity.mjs';
import {createRequestsHandler} from '../routes.mjs';

// PGlite is the repo's test-only embedded PostgreSQL (installed under services/api/auth). Without it these tests skip.
// It has one connection, so the concurrent claims below are serialized; the native multi-session race is in claim-race.native.test.mjs.
let PGlite=null;
try{const req=createRequire(new URL('../../auth/package.json',import.meta.url));PGlite=(await import(pathToFileURL(req.resolve('@electric-sql/pglite')))).PGlite;}catch{}
const skip=PGlite?false:'PGlite not installed: run npm ci --prefix services/api/auth --ignore-scripts';
const sql=relative=>readFileSync(new URL(relative,import.meta.url),'utf8');
const db=skip?null:new PGlite();
const tokens={},users={};
let orgA,orgB,server,base,available=Promise.resolve();
async function connect(role='sv_auth_test_runtime'){
 const previous=available;let release;available=new Promise(r=>{release=r;});await previous;
 await db.query(role?`SET ROLE ${role}`:'RESET ROLE');
 return {query:(...a)=>db.query(...a),release};
}
const identityProvider=createLocalIdentityProvider({mode:'test'});
const api=(who,path,{method='GET',body,org}={})=>fetch(`${base}/organizations/${org??orgA}${path}`,{method,headers:{authorization:`Bearer ${tokens[who]}`,...(body!==undefined&&{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
const create=(who,items,note)=>api(who,'/requests',{method:'POST',body:{items:items.map(equipmentType=>({equipmentType})),...(note&&{note})}});
const claim=(who,id,line,equipmentId,expectedVersion=0)=>api(who,`/requests/${id}/items/${line}/claim`,{method:'POST',body:{equipmentId,expectedVersion}});
const owner=async(text,params=[])=>{const c=await connect(null);try{return await c.query(text,params);}finally{c.release();}};
const newRequest=async(items,who='operator')=>(await (await create(who,items)).json());
const assignments=async eq=>(await owner("SELECT count(*)::int AS n FROM item_assignment WHERE active AND equipment_id = (SELECT id FROM equipment WHERE external_id = $1 AND organization_id = $2)",[eq,orgA])).rows[0].n;
const events=async id=>(await owner('SELECT kind, actor FROM request_event WHERE request_id = $1 ORDER BY recorded_at, id',[id])).rows;
const expectError=async(res,status,code)=>{const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));assert.equal(body.error,code);};

before(async()=>{
 if(skip)return;
 await db.exec(sql('../../db/migrations/0001_core.up.sql').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
 await db.exec(sql('../../auth/migrations/0001_auth.up.sql'));
 await db.exec(sql('../migrations/0001_requests.up.sql'));
 await db.exec(sql('../../db/seed/seed.sql'));
 orgA=(await db.query("SELECT id FROM organization WHERE name LIKE 'Demo%'")).rows[0].id;
 await db.exec(`
  INSERT INTO equipment (organization_id, external_id, name, equipment_type_id, location_id, status, provenance)
   SELECT organization_id, 'EQ-RACE', 'Race cart', equipment_type_id, location_id, 'available', 'test' FROM equipment WHERE external_id = 'EQ-007';
  INSERT INTO organization (name) VALUES ('Other org');
  INSERT INTO facility (organization_id, name) SELECT id, 'F2' FROM organization WHERE name = 'Other org';
  INSERT INTO ward (organization_id, facility_id, name) SELECT organization_id, id, 'W2' FROM facility WHERE name = 'F2';
  INSERT INTO location (organization_id, ward_id, external_key, name, kind) SELECT organization_id, id, 'room-101', 'Other room', 'room' FROM ward WHERE name = 'W2';
  INSERT INTO equipment_type (organization_id, model_kind, name) SELECT id, 'supply-cart', 'Cart' FROM organization WHERE name = 'Other org';
  INSERT INTO equipment (organization_id, external_id, name, equipment_type_id, location_id, status, provenance)
   SELECT o.id, 'EQ-007', 'Other tenant cart', (SELECT id FROM equipment_type WHERE organization_id = o.id), (SELECT id FROM location WHERE organization_id = o.id), 'available', 'test' FROM organization o WHERE o.name = 'Other org';
  CREATE ROLE sv_auth_test_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
  GRANT USAGE ON SCHEMA public TO sv_auth_test_runtime;
  GRANT SELECT, INSERT, UPDATE, DELETE ON organization, facility, ward, location, equipment_type, equipment, equipment_observation, equipment_event, request, request_item, item_assignment, request_event TO sv_auth_test_runtime;
  GRANT SELECT ON auth_user, auth_membership TO sv_auth_test_runtime;
  GRANT EXECUTE ON FUNCTION auth_resolve_identity(text, text), claim_request_item(uuid, integer, uuid, integer, text) TO sv_auth_test_runtime;`);
 orgB=(await db.query("SELECT id FROM organization WHERE name = 'Other org'")).rows[0].id;
 const people=[['viewer','viewer'],['operator','operator'],['operator2','operator'],['equipment_manager','equipment_manager'],['admin','admin']];
 for(const [i,[name,role]] of people.entries()){
  const id=`00000000-0000-4000-8000-${String(800+i).padStart(12,'0')}`;users[name]=id;
  await db.query('INSERT INTO auth_user(id, issuer, subject) VALUES ($1, $2, $3)',[id,'urn:supply-vanguard:local',name]);
  await db.query('INSERT INTO auth_membership(organization_id, user_id, role) VALUES ($1, $2, $3)',[orgA,id,role]);
  tokens[name]=identityProvider.issue(name);
 }
 const outsider='00000000-0000-4000-8000-000000000999';
 await db.query('INSERT INTO auth_user(id, issuer, subject) VALUES ($1, $2, $3)',[outsider,'urn:supply-vanguard:local','outsider']);
 await db.query("INSERT INTO auth_membership(organization_id, user_id, role) VALUES ($1, $2, 'admin')",[orgB,outsider]);
 tokens.outsider=identityProvider.issue('outsider');
 server=createServer(createRequestsHandler({authorization:createAuthorization({identityProvider,pool:{connect:()=>connect()}})}));
 server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(db){await available;await db.close();}});

test('a request holds several items and its summary is derived from their states',{skip},async()=>{
 const res=await create('operator',['infusion','supply-cart','supply-cart'],'for room 104'),req=await res.json();
 assert.equal(res.status,201);assert.equal(req.items.length,3);
 assert.deepEqual(req.items.map(i=>[i.lineNo,i.equipmentType,i.state,i.assignment]),[[1,'infusion','open',null],[2,'supply-cart','open',null],[3,'supply-cart','open',null]]);
 assert.deepEqual(req.summary,{status:'open',total:3,open:3,assigned:0});assert.equal(req.requestedBy,`user:${users.operator}`);assert.equal(req.note,'for room 104');
 assert.deepEqual((await events(req.id)).map(e=>e.kind),['request-created']);
 const one=await claim('operator',req.id,1,'EQ-003'),after1=await one.json();
 assert.equal(one.status,201);assert.equal(after1.replayed,false);assert.equal(after1.request.items[0].state,'assigned');assert.equal(after1.request.items[0].assignment.equipmentId,'EQ-003');
 assert.deepEqual(after1.request.summary,{status:'partially-assigned',total:3,open:2,assigned:1});
 await claim('operator',req.id,2,'EQ-007');await claim('operator',req.id,3,'EQ-008');
 const done=await (await api('viewer',`/requests/${req.id}`)).json();
 assert.deepEqual(done.summary,{status:'assigned',total:3,open:0,assigned:3});
 assert.deepEqual((await events(req.id)).map(e=>e.kind),['request-created','item-claimed','item-claimed','item-claimed']);
 assert.equal((await owner("SELECT status FROM equipment WHERE external_id = 'EQ-003' AND organization_id = $1",[orgA])).rows[0].status,'available','a claim is provisional: it does not change the asset');
});
test('create validates input and listing is paginated and tenant-scoped',{skip},async()=>{
 const bad=[{items:[]},{items:[{equipmentType:'teleporter'}]},{items:[{equipmentType:'monitor',extra:1}]},{items:'x'},{items:[{equipmentType:'monitor'}],note:'x'.repeat(501)},{items:[{equipmentType:'monitor'}],extra:1},{items:Array.from({length:21},()=>({equipmentType:'monitor'}))}];
 for(const body of bad)assert.equal((await api('operator','/requests',{method:'POST',body})).status,400,JSON.stringify(body).slice(0,60));
 assert.equal((await api('viewer','/requests',{method:'POST',body:{items:[{equipmentType:'monitor'}]}})).status,403);
 assert.equal((await api('operator','/requests',{method:'POST',body:{items:[{equipmentType:'monitor'}]},org:orgB})).status,403);
 for(let i=0;i<4;i++)await create('operator',['monitor']);
 const all=await (await api('viewer','/requests?limit=100')).json(),seen=[];let cursor=null;
 do{const page=await (await api('viewer',`/requests?limit=3${cursor?`&cursor=${cursor}`:''}`)).json();seen.push(...page.items.map(r=>r.id));cursor=page.nextCursor;}while(cursor);
 assert.deepEqual(seen,all.items.map(r=>r.id));assert.ok(seen.length>=5);assert.equal(new Set(seen).size,seen.length);
 for(const q of ['limit=0','limit=101','limit=x','cursor=!!!'])assert.equal((await api('viewer',`/requests?${q}`)).status,400,q);
 assert.deepEqual((await (await api('outsider','/requests',{org:orgB})).json()).items,[]);
 const mine=all.items[0].id;
 assert.equal((await api('outsider',`/requests/${mine}`,{org:orgB})).status,404);
 assert.equal((await api('outsider',`/requests/${mine}`,{org:orgA})).status,403);
 assert.equal((await api('viewer','/requests/not-a-uuid')).status,404);
 assert.equal((await fetch(`${base}/organizations/${orgA}/requests`)).status,401);
});
test('claims are refused for the right reasons and change nothing',{skip},async()=>{
 const id=(await newRequest(['incubator','monitor','supply-cart'])).id;
 await expectError(await claim('operator',id,2,'EQ-001'),422,'wrong_equipment_type');
 await expectError(await claim('operator',id,2,'EQ-005'),422,'not_assignable');
 await expectError(await claim('operator',id,2,'EQ-004'),422,'not_assignable');
 await expectError(await claim('operator',id,1,'EQ-001',5),409,'stale_version');
 await expectError(await claim('operator',id,1,'NOPE'),404,'equipment_not_found');
 await expectError(await claim('operator',id,9,'EQ-001'),404,'item_not_found');
 await expectError(await claim('operator',id,0,'EQ-001'),404,'not_found');
 assert.equal((await api('operator',`/requests/${id}/items/1/claim`,{method:'POST',body:{equipmentId:'EQ-001'}})).status,400);
 assert.equal((await api('operator',`/requests/${id}/items/1/claim`,{method:'POST',body:{equipmentId:'EQ-001',expectedVersion:0,extra:1}})).status,400);
 assert.equal((await claim('viewer',id,1,'EQ-001')).status,403);
 const fresh=await (await api('viewer',`/requests/${id}`)).json();assert.equal(fresh.summary.assigned,0);assert.equal((await events(id)).length,1);
 assert.equal((await claim('operator',id,1,'EQ-001')).status,201);
 const other=await newRequest(['incubator']);
 await expectError(await claim('operator',other.id,1,'EQ-001'),409,'equipment_already_assigned');
});
test('a retry of a successful claim returns the original result; a different actor or asset conflicts',{skip},async()=>{
 const id=(await newRequest(['supply-cart'])).id;
 const first=await claim('operator',id,1,'EQ-RACE');assert.equal(first.status,201);
 const firstAssignment=(await first.json()).request.items[0].assignment.id;
 const again=await claim('operator',id,1,'EQ-RACE'),body=await again.json();
 assert.equal(again.status,200);assert.equal(again.headers.get('idempotent-replay'),'true');assert.equal(body.replayed,true);assert.equal(body.request.items[0].assignment.id,firstAssignment);
 assert.equal((await events(id)).filter(e=>e.kind==='item-claimed').length,1);assert.equal(await assignments('EQ-RACE'),1);
 await expectError(await claim('operator2',id,1,'EQ-RACE'),409,'item_already_assigned');
 await expectError(await claim('operator',id,1,'EQ-008'),409,'item_already_assigned');
});
test('exactly one of many simultaneous claimants wins the same asset',{skip},async()=>{
 await owner(`INSERT INTO equipment (organization_id, external_id, name, equipment_type_id, location_id, status, provenance)
  SELECT organization_id, 'EQ-RACE2', 'Race cart 2', equipment_type_id, location_id, 'available', 'test' FROM equipment WHERE external_id = 'EQ-007' AND organization_id = $1`,[orgA]);
 const who=['operator','operator2','equipment_manager','admin'],requests=[];
 for(let i=0;i<6;i++)requests.push(await newRequest(['supply-cart'],who[i%4]));
 const results=await Promise.all(requests.map((r,i)=>claim(who[i%4],r.id,1,'EQ-RACE2')));
 const codes=await Promise.all(results.map(async r=>[r.status,(await r.json()).error]));
 assert.equal(codes.filter(c=>c[0]===201).length,1,JSON.stringify(codes));
 assert.equal(codes.filter(c=>c[0]===409&&c[1]==='equipment_already_assigned').length,5,JSON.stringify(codes));
 assert.equal(await assignments('EQ-RACE2'),1);
});
test('the database refuses a second active assignment even if the claim function is bypassed',{skip},async()=>{
 const r=await newRequest(['supply-cart']);
 await assert.rejects(owner(`INSERT INTO item_assignment (organization_id, request_item_id, equipment_id, assigned_by)
   SELECT i.organization_id, i.id, (SELECT id FROM equipment WHERE external_id = 'EQ-007' AND organization_id = i.organization_id), 'test' FROM request_item i WHERE i.request_id = $1`,[r.id]),/unique|duplicate/);
 await assert.rejects(owner("UPDATE request_event SET actor = 'x'"),/append-only/);
 await assert.rejects(owner('DELETE FROM request_event'),/append-only/);
});
test('row-level security keeps requests inside their tenant',{skip},async()=>{
 const c=await connect();
 try{
  await c.query('BEGIN');
  await c.query("SELECT set_config('sv.user_id', $1, true), set_config('sv.organization_id', $2, true)",[users.viewer,orgA]);
  assert.ok((await c.query('SELECT count(*)::int AS n FROM request')).rows[0].n>0);
  await assert.rejects(c.query("INSERT INTO request (organization_id, requested_by) VALUES ($1, 'x')",[orgA]),/row-level security/);
  await c.query('ROLLBACK');
  await c.query('BEGIN');
  await c.query("SELECT set_config('sv.user_id', $1, true), set_config('sv.organization_id', $2, true)",['00000000-0000-4000-8000-000000000999',orgB]);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM request')).rows[0].n,0);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM item_assignment')).rows[0].n,0);
  await c.query('ROLLBACK');
 }finally{c.release();}
});
test('the migration rolls back cleanly and can be reapplied',{skip},async()=>{
 await owner('SELECT 1');   // owner() resets the session role, which an earlier test may have left set
 await db.exec(sql('../migrations/0001_requests.down.sql'));
 assert.equal((await owner("SELECT to_regclass('public.request') AS t")).rows[0].t,null);
 await db.exec(sql('../migrations/0001_requests.up.sql'));
 assert.ok((await owner("SELECT to_regclass('public.request') AS t")).rows[0].t);
});
