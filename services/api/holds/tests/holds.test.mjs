import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createAuthorization} from '../../auth/index.mjs';
import {createLocalIdentityProvider} from '../../auth/local-identity.mjs';
import {createHoldsHandler} from '../routes.mjs';
import {createRequestsHandler} from '../../requests/routes.mjs';

// PGlite is the repo's test-only embedded PostgreSQL (installed under services/api/auth). Without it these tests skip.
// The role-to-kind rules below are TEST FIXTURES. The product ships with no rules: each organization configures its own.
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
const call=(who,path,{method='GET',body,org}={})=>fetch(`${base}/organizations/${org??orgA}${path}`,{method,headers:{authorization:`Bearer ${tokens[who]}`,...(body!==undefined&&{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
const place=(who,eq,kind,reason,org)=>call(who,`/equipment/${eq}/holds`,{method:'POST',body:{kind,...(reason&&{reason})},org});
const clear=(who,id,org)=>call(who,`/holds/${id}/clear`,{method:'POST',org});
const setRule=(who,kind,role)=>call(who,`/holds/clearance-rules/${kind}`,{method:'PUT',body:{role}});
const claim=(who,requestId,equipmentId)=>call(who,`/requests/${requestId}/items/1/claim`,{method:'POST',body:{equipmentId,expectedVersion:0}});
const owner=async(text,params=[])=>{const c=await connect(null);try{return await c.query(text,params);}finally{c.release();}};
const expectError=async(res,status,code)=>{const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));assert.equal(body.error,code);return body;};
const active=async eq=>(await (await call('viewer',`/equipment/${eq}/holds?state=active`)).json());

before(async()=>{
 if(skip)return;
 await db.exec(sql('../../db/migrations/0001_core.up.sql').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
 await db.exec(sql('../../auth/migrations/0001_auth.up.sql'));
 await db.exec(sql('../../requests/migrations/0001_requests.up.sql'));
 await db.exec(sql('../migrations/0001_holds.up.sql'));
 await db.exec(sql('../migrations/0002_hold_clearance_evidence.up.sql'));   // SV-031: the shapes below must still work with the evidence tables present
 await db.exec(sql('../../db/seed/seed.sql'));
 orgA=(await db.query("SELECT id FROM organization WHERE name LIKE 'Demo%'")).rows[0].id;
 await db.exec(`
  INSERT INTO organization (name) VALUES ('Other org');
  INSERT INTO facility (organization_id, name) SELECT id, 'F2' FROM organization WHERE name = 'Other org';
  INSERT INTO ward (organization_id, facility_id, name) SELECT organization_id, id, 'W2' FROM facility WHERE name = 'F2';
  INSERT INTO location (organization_id, ward_id, external_key, name, kind) SELECT organization_id, id, 'room-101', 'Other room', 'room' FROM ward WHERE name = 'W2';
  INSERT INTO equipment_type (organization_id, model_kind, name) SELECT id, 'supply-cart', 'Cart' FROM organization WHERE name = 'Other org';
  INSERT INTO equipment (organization_id, external_id, name, equipment_type_id, location_id, status, provenance)
   SELECT o.id, 'EQ-007', 'Other tenant cart', (SELECT id FROM equipment_type WHERE organization_id = o.id), (SELECT id FROM location WHERE organization_id = o.id), 'available', 'test' FROM organization o WHERE o.name = 'Other org';
  CREATE ROLE sv_auth_test_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
  GRANT USAGE ON SCHEMA public TO sv_auth_test_runtime;
  GRANT SELECT, INSERT, UPDATE, DELETE ON organization, facility, ward, location, equipment_type, equipment, equipment_observation, equipment_event, request, request_item, item_assignment, request_event, equipment_hold, hold_clearance_rule TO sv_auth_test_runtime;
  GRANT SELECT ON auth_user, auth_membership TO sv_auth_test_runtime;
  GRANT SELECT, INSERT ON hold_clearance_evidence, hold_clearance_receipt TO sv_auth_test_runtime;
  GRANT EXECUTE ON FUNCTION clear_equipment_hold_with_evidence(uuid, text, text, text, timestamptz, text) TO sv_auth_test_runtime;
  GRANT EXECUTE ON FUNCTION auth_resolve_identity(text, text), claim_request_item(uuid, integer, uuid, integer, text), place_equipment_hold(uuid, text, text, text), clear_equipment_hold(uuid, text) TO sv_auth_test_runtime;`);
 orgB=(await db.query("SELECT id FROM organization WHERE name = 'Other org'")).rows[0].id;
 const people=[['viewer','viewer',orgA],['operator','operator',orgA],['supply_manager','supply_manager',orgA],['equipment_manager','equipment_manager',orgA],['admin','admin',orgA],['outsider','admin',orgB]];
 for(const [i,[name,role,org]] of people.entries()){
  const id=`00000000-0000-4000-8000-${String(600+i).padStart(12,'0')}`;users[name]=id;
  await db.query('INSERT INTO auth_user(id, issuer, subject) VALUES ($1, $2, $3)',[id,'urn:supply-vanguard:local',name]);
  await db.query('INSERT INTO auth_membership(organization_id, user_id, role) VALUES ($1, $2, $3)',[org,id,role]);
  tokens[name]=identityProvider.issue(name);
 }
 const authorization=createAuthorization({identityProvider,pool:{connect:()=>connect()}}),holds=createHoldsHandler({authorization}),requests=createRequestsHandler({authorization});
 server=createServer((req,res)=>/\/(holds\/|equipment\/[^/]+\/holds)/.test(req.url)?holds(req,res):requests(req,res));
 server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(db){await available;await db.close();}});

test('with no clearance rule configured, nobody can clear a hold, not even an admin (fails closed)',{skip},async()=>{
 const rules=await (await call('viewer','/holds/clearance-rules')).json();
 assert.deepEqual(rules.rules,[{kind:'dirty',role:null},{kind:'fault',role:null},{kind:'maintenance',role:null},{kind:'unknown',role:null}]);
 const hold=(await (await place('operator','EQ-001','dirty')).json()).hold;
 for(const who of ['viewer','operator','supply_manager','equipment_manager','admin'])await expectError(await clear(who,hold.id),422,'no_clearance_rule');
 assert.equal((await active('EQ-001')).summary.blocked,true);
});
test('clearance rules are configuration only the admin can change, and only with existing roles',{skip},async()=>{
 for(const who of ['viewer','operator','supply_manager','equipment_manager'])assert.equal((await setRule(who,'dirty','admin')).status,403,who);
 assert.equal((await setRule('outsider','dirty','admin')).status,403);
 for(const [kind,role] of [['dirty','supply_manager'],['fault','equipment_manager'],['maintenance','equipment_manager'],['unknown','admin']])assert.equal((await setRule('admin',kind,role)).status,200);
 const rules=(await (await call('viewer','/holds/clearance-rules')).json()).rules;
 assert.deepEqual(rules,[{kind:'dirty',role:'supply_manager'},{kind:'fault',role:'equipment_manager'},{kind:'maintenance',role:'equipment_manager'},{kind:'unknown',role:'admin'}]);
 assert.equal((await setRule('admin','dirty','janitor')).status,400);assert.equal((await setRule('admin','sparkly','admin')).status,400);
 assert.equal((await call('admin','/holds/clearance-rules/dirty',{method:'PUT',body:{role:'admin',extra:1}})).status,400);
 assert.equal((await setRule('admin','dirty','supply_manager')).status,200);
});
test('dirty, fault, maintenance and unknown holds stack independently',{skip},async()=>{
 const before=(await owner("SELECT status, version FROM equipment WHERE external_id = 'EQ-003' AND organization_id = $1",[orgA])).rows[0];
 const placed=[];
 for(const kind of ['dirty','fault','maintenance','unknown']){
  const res=await place('operator','EQ-003',kind,`${kind} reason`),body=await res.json();
  assert.equal(res.status,201,kind);assert.equal(body.placed,true);assert.equal(body.hold.kind,kind);assert.equal(body.hold.placedBy,`user:${users.operator}`);assert.equal(body.hold.active,true);placed.push(body.hold);
 }
 const list=await active('EQ-003');
 assert.deepEqual(list.summary,{blocked:true,activeKinds:['dirty','fault','maintenance','unknown'],active:4,total:4});
 const again=await place('equipment_manager','EQ-003','fault'),body=await again.json();
 assert.equal(again.status,200);assert.equal(again.headers.get('idempotent-replay'),'true');assert.equal(body.placed,false);assert.equal(body.hold.id,placed[1].id);
 assert.equal((await active('EQ-003')).summary.active,4,'the same kind does not stack twice');
 assert.deepEqual((await owner("SELECT status, version FROM equipment WHERE external_id = 'EQ-003' AND organization_id = $1",[orgA])).rows[0],before,'a hold never changes the asset status or version');
 for(const [who,body2,status] of [['viewer',{kind:'dirty'},403],['operator',{kind:'sparkly'},400],['operator',{kind:'dirty',reason:'x'.repeat(501)},400],['operator',{kind:'dirty',extra:1},400],['operator',{},400]])assert.equal((await call(who,'/equipment/EQ-004/holds',{method:'POST',body:body2})).status,status,JSON.stringify(body2).slice(0,40));
 assert.equal((await place('operator','NOPE','dirty')).status,404);
 assert.equal((await place('operator','EQ-004','dirty',undefined,orgB)).status,403);
});
test('any active hold blocks assignment, and the asset is assignable only after every hold is cleared',{skip},async()=>{
 const req=await (await call('operator','/requests',{method:'POST',body:{items:[{equipmentType:'infusion'}]}})).json();
 const holds=(await (await call('viewer','/equipment/EQ-003/holds?state=active')).json()).holds;
 await expectError(await claim('operator',req.id,'EQ-003'),422,'equipment_on_hold');
 const by={dirty:'supply_manager',fault:'equipment_manager',maintenance:'equipment_manager',unknown:'admin'};
 for(const h of holds){
  await expectError(await claim('operator',req.id,'EQ-003'),422,'equipment_on_hold');
  const res=await clear(by[h.kind],h.id),body=await res.json();
  assert.equal(res.status,200,JSON.stringify(body));assert.equal(body.hold.active,false);assert.equal(body.hold.clearedBy,`user:${users[by[h.kind]]}`);
 }
 assert.deepEqual((await active('EQ-003')).summary,{blocked:false,activeKinds:[],active:0,total:4});
 const ok=await claim('operator',req.id,'EQ-003');assert.equal(ok.status,201,JSON.stringify(await ok.clone().json()));
 assert.equal((await (await call('viewer','/equipment/EQ-003/holds?state=cleared')).json()).holds.length,4,'cleared holds stay as history');
 assert.equal((await (await call('viewer','/equipment/EQ-003/holds?state=active')).json()).holds.length,0);
 assert.equal((await call('viewer','/equipment/EQ-003/holds?state=bogus')).status,400);
});
test('only the matching role can clear its own hold: wrong roles, including admin, are refused',{skip},async()=>{
 const ids={};
 for(const kind of ['dirty','fault','maintenance','unknown'])ids[kind]=(await (await place('operator','EQ-005',kind)).json()).hold.id;
 const roles=['viewer','operator','supply_manager','equipment_manager','admin'],needs={dirty:'supply_manager',fault:'equipment_manager',maintenance:'equipment_manager',unknown:'admin'};
 for(const [kind,id] of Object.entries(ids))for(const who of roles)if(who!==needs[kind])await expectError(await clear(who,id),403,'wrong_role');
 assert.equal((await active('EQ-005')).summary.active,4,'refused attempts change nothing');
 for(const [kind,id] of Object.entries(ids)){assert.equal((await clear(needs[kind],id)).status,200,kind);}
 await expectError(await clear('supply_manager',ids.dirty),409,'hold_already_cleared');
 await expectError(await clear('admin','00000000-0000-4000-8000-0000000000ff'),404,'hold_not_found');
 await expectError(await clear('admin','not-a-uuid'),404,'hold_not_found');
 assert.equal((await fetch(`${base}/organizations/${orgA}/holds/${ids.dirty}/clear`,{method:'POST'})).status,401);
});
test('the database enforces the same rules without the API: role, assignment blocking and history',{skip},async()=>{
 await place('operator','EQ-006','dirty');
 const holdId=(await owner("SELECT id FROM equipment_hold WHERE active AND kind = 'dirty' AND equipment_id = (SELECT id FROM equipment WHERE external_id = 'EQ-006' AND organization_id = $1)",[orgA])).rows[0].id;
 const asRole=async(who,org,work)=>{const c=await connect();try{await c.query('BEGIN');await c.query("SELECT set_config('sv.user_id', $1, true), set_config('sv.organization_id', $2, true)",[users[who],org]);return await work(c);}finally{await c.query('ROLLBACK');c.release();}};
 const direct=who=>asRole(who,orgA,async c=>(await c.query("UPDATE equipment_hold SET active = false, cleared_by = 'x', cleared_at = now() WHERE id = $1 RETURNING id",[holdId])).rows.length);
 assert.equal(await direct('operator'),0,'a wrong role cannot clear by direct SQL (row-level security)');
 assert.equal(await direct('admin'),0,'neither can an admin');
 assert.equal(await direct('supply_manager'),1,'the configured role can');
 await assert.rejects(owner("UPDATE equipment_hold SET reason = 'edited' WHERE id = $1",[holdId]),/can only be cleared/);
 await assert.rejects(owner("UPDATE equipment_hold SET kind = 'fault' WHERE id = $1",[holdId]),/can only be cleared/);
 await assert.rejects(owner('DELETE FROM equipment_hold WHERE id = $1',[holdId]),/never deleted/);
 await assert.rejects(owner("INSERT INTO equipment_hold (organization_id, equipment_id, kind, placed_by) SELECT organization_id, equipment_id, kind, 'x' FROM equipment_hold WHERE id = $1",[holdId]),/unique|duplicate/);
 const req=await (await call('operator','/requests',{method:'POST',body:{items:[{equipmentType:'warmer'}]}})).json();
 await assert.rejects(owner(`INSERT INTO item_assignment (organization_id, request_item_id, equipment_id, assigned_by)
  SELECT $1, (SELECT id FROM request_item WHERE request_id = $2), (SELECT id FROM equipment WHERE external_id = 'EQ-006' AND organization_id = $1), 'x'`,[orgA,req.id]),/sv:equipment_on_hold/);
 await assert.rejects(asRole('viewer',orgA,c=>c.query("INSERT INTO equipment_hold (organization_id, equipment_id, kind, placed_by) SELECT organization_id, id, 'unknown', 'x' FROM equipment WHERE external_id = 'EQ-006'")),/row-level security/);
});
test('holds are tenant-scoped',{skip},async()=>{
 const other=await (await place('outsider','EQ-007','fault',undefined,orgB)).json();
 assert.equal(other.hold.equipmentId,'EQ-007');
 assert.equal((await call('outsider','/equipment/EQ-007/holds',{org:orgA})).status,403);
 assert.equal((await call('admin',`/holds/${other.hold.id}/clear`,{method:'POST',org:orgB})).status,403);
 await expectError(await clear('admin',other.hold.id),404,'hold_not_found');
 assert.equal((await (await call('outsider','/equipment/EQ-007/holds',{org:orgB})).json()).summary.active,1);
 assert.equal((await (await call('viewer','/equipment/EQ-007/holds')).json()).holds.length,0,'the same asset ID in another tenant has no holds here');
});
test('the migration rolls back cleanly and can be reapplied',{skip},async()=>{
 await owner('SELECT 1');
 await db.exec(sql('../migrations/0002_hold_clearance_evidence.down.sql'));
 assert.equal((await owner("SELECT to_regclass('public.hold_clearance_evidence') AS t")).rows[0].t,null);
 assert.ok((await owner("SELECT to_regclass('public.equipment_hold') AS t")).rows[0].t,'rolling back 0002 leaves the holds table alone');
 await db.exec(sql('../migrations/0001_holds.down.sql'));
 assert.equal((await owner("SELECT to_regclass('public.equipment_hold') AS t")).rows[0].t,null);
 await db.exec(sql('../migrations/0001_holds.up.sql'));
 await db.exec(sql('../migrations/0002_hold_clearance_evidence.up.sql'));
 assert.ok((await owner("SELECT to_regclass('public.equipment_hold') AS t")).rows[0].t);
 assert.ok((await owner("SELECT to_regclass('public.hold_clearance_evidence') AS t")).rows[0].t);
});
