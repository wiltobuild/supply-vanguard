import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createAuthorization} from '../../auth/index.mjs';
import {createLocalIdentityProvider} from '../../auth/local-identity.mjs';
import {ROLE_PERMISSIONS} from '../../auth/roles.mjs';
import {createEquipmentHandler} from '../routes.mjs';
import {toRecord,encodeCursor} from '../service.mjs';
import {validateEquipmentRecord} from '../../../../packages/domain/contracts.js';

// PGlite is the repo's test-only embedded PostgreSQL (installed under services/api/auth). Without it these tests skip.
let PGlite=null;
try{const req=createRequire(new URL('../../auth/package.json',import.meta.url));PGlite=(await import(pathToFileURL(req.resolve('@electric-sql/pglite')))).PGlite;}catch{}
const skip=PGlite?false:'PGlite not installed: run npm ci --prefix services/api/auth --ignore-scripts';
const sql=relative=>readFileSync(new URL(relative,import.meta.url),'utf8');
const db=skip?null:new PGlite();
const users={},tokens={};
let orgA,orgB,server,base;
// PGlite has one connection, so this pool hands it out one lease at a time, as a real pool would lease clients.
let available=Promise.resolve();
async function connect(role='sv_auth_test_runtime'){
 const previous=available;let release;available=new Promise(r=>{release=r;});await previous;
 await db.query(role?`SET ROLE ${role}`:'RESET ROLE');
 return {query:(...a)=>db.query(...a),release};
}
const identityProvider=createLocalIdentityProvider({mode:'test'});
let keyCounter=0;const key=()=>`k-${++keyCounter}`;
const api=(who,path,{method='GET',body,headers={},org}={})=>fetch(`${base}/organizations/${org??orgA}${path}`,{method,headers:{authorization:`Bearer ${tokens[who]}`,...(body!==undefined&&{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
const patch=(who,id,body,idem=key(),org)=>api(who,`/equipment/${id}`,{method:'PATCH',body,headers:{'idempotency-key':idem},org});
const observe=(who,id,body,idem=key())=>api(who,`/equipment/${id}/observations`,{method:'POST',body,headers:{'idempotency-key':idem}});
const owner=async(text,params=[])=>{const c=await connect(null);try{return await c.query(text,params);}finally{c.release();}};
const eventsFor=async ext=>(await owner("SELECT kind, actor, idempotency_key, before_state, after_state FROM equipment_event WHERE equipment_id = (SELECT id FROM equipment WHERE external_id = $1 AND organization_id = $2) ORDER BY recorded_at, id",[ext,orgA])).rows;
const row=async ext=>(await owner('SELECT status, note, version, last_verified_at, last_admin_edit_at FROM equipment WHERE external_id = $1 AND organization_id = $2',[ext,orgA])).rows[0];
const iso=ms=>new Date(Date.now()+ms).toISOString();

before(async()=>{
 if(skip)return;
 await db.exec(sql('../../db/migrations/0001_core.up.sql').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
 await db.exec(sql('../../auth/migrations/0001_auth.up.sql'));
 await db.exec(`BEGIN; ${sql('../migrations/0001_receipts.up.sql')} COMMIT;`);
 await db.exec(sql('../../db/seed/seed.sql'));
 orgA=(await db.query("SELECT id FROM organization WHERE name LIKE 'Demo%'")).rows[0].id;
 await db.exec(`
  INSERT INTO organization (name) VALUES ('Other org');
  INSERT INTO facility (organization_id, name) SELECT id, 'F2' FROM organization WHERE name = 'Other org';
  INSERT INTO ward (organization_id, facility_id, name) SELECT organization_id, id, 'W2' FROM facility WHERE name = 'F2';
  INSERT INTO location (organization_id, ward_id, external_key, name, kind) SELECT organization_id, id, 'room-101', 'Other room', 'room' FROM ward WHERE name = 'W2';
  INSERT INTO equipment_type (organization_id, model_kind, name) SELECT id, 'monitor', 'Monitor' FROM organization WHERE name = 'Other org';
  INSERT INTO equipment (organization_id, external_id, name, equipment_type_id, location_id, status, provenance)
   SELECT o.id, 'EQ-001', 'Other tenant monitor', (SELECT id FROM equipment_type WHERE organization_id = o.id), (SELECT id FROM location WHERE organization_id = o.id), 'available', 'test' FROM organization o WHERE o.name = 'Other org';
  CREATE ROLE sv_auth_test_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
  GRANT USAGE ON SCHEMA public TO sv_auth_test_runtime;
  GRANT SELECT, INSERT, UPDATE, DELETE ON organization, facility, ward, location, equipment_type, equipment, equipment_observation, equipment_event TO sv_auth_test_runtime;
  GRANT SELECT ON auth_user, auth_membership TO sv_auth_test_runtime;
  GRANT SELECT, INSERT ON equipment_command_receipt TO sv_auth_test_runtime;
  GRANT EXECUTE ON FUNCTION auth_resolve_identity(text, text) TO sv_auth_test_runtime;`);
 orgB=(await db.query("SELECT id FROM organization WHERE name = 'Other org'")).rows[0].id;
 let i=0;
 for(const role of Object.keys(ROLE_PERMISSIONS)){
  const id=`00000000-0000-4000-8000-${String(900+i++).padStart(12,'0')}`;users[role]=id;
  await db.query('INSERT INTO auth_user(id, issuer, subject) VALUES ($1, $2, $3)',[id,'urn:supply-vanguard:local',role]);
  await db.query('INSERT INTO auth_membership(organization_id, user_id, role) VALUES ($1, $2, $3)',[orgA,id,role]);
  tokens[role]=identityProvider.issue(role);
 }
 const outsider='00000000-0000-4000-8000-000000000999';
 await db.query('INSERT INTO auth_user(id, issuer, subject) VALUES ($1, $2, $3)',[outsider,'urn:supply-vanguard:local','outsider']);
 await db.query("INSERT INTO auth_membership(organization_id, user_id, role) VALUES ($1, $2, 'admin')",[orgB,outsider]);
 tokens.outsider=identityProvider.issue('outsider');
 server=createServer(createEquipmentHandler({authorization:createAuthorization({identityProvider,pool:{connect:()=>connect()}})}));
 server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(db){await available;await db.close();}});

test('list is tenant-scoped, ordered, filterable and paginated without gaps or repeats',{skip},async()=>{
 const all=await (await api('viewer','/equipment')).json();
 assert.equal(all.items.length,8);assert.equal(all.nextCursor,null);
 assert.deepEqual(all.items.map(i=>i.id),[...all.items.map(i=>i.id)].sort());
 for(const item of all.items)validateEquipmentRecord(item,['equipment-store','room-101','room-102','room-103','room-104','room-106','clean-supply','staff-base','family-lounge','room-105']);
 const seen=[];let cursor=null,pages=0;
 do{const page=await (await api('viewer',`/equipment?limit=3${cursor?`&cursor=${cursor}`:''}`)).json();seen.push(...page.items.map(i=>i.id));cursor=page.nextCursor;pages++;}while(cursor);
 assert.deepEqual(seen,all.items.map(i=>i.id));assert.equal(pages,3);
 assert.equal((await (await api('viewer','/equipment?status=maintenance')).json()).items.length,1);
 assert.equal((await (await api('viewer','/equipment?location=equipment-store')).json()).items.length,3);
 assert.equal((await (await api('viewer','/equipment?q=pump')).json()).items.length,2);
 assert.equal((await (await api('viewer','/equipment?q=%25')).json()).items.length,0,'wildcards are literal');
 for(const bad of ['limit=0','limit=101','limit=abc','limit=2.5','status=broken','cursor=!!!',`cursor=${encodeCursor('')}`])assert.equal((await api('viewer',`/equipment?${bad}`)).status,400,bad);
 const other=await api('outsider','/equipment',{org:orgB});assert.deepEqual((await other.json()).items.map(i=>i.name),['Other tenant monitor']);
});
test('get returns the contract record; unknown and cross-tenant IDs are 404 or 403',{skip},async()=>{
 const res=await api('viewer','/equipment/EQ-002'),rec=await res.json();
 assert.equal(res.status,200);assert.equal(rec.id,'EQ-002');assert.equal(rec.locationId,'room-101');assert.equal(rec.version,0);assert.equal(rec.lastVerified,null);
 assert.equal((await api('viewer','/equipment/NOPE')).status,404);
 assert.equal((await api('viewer','/equipment/EQ-001',{org:orgB})).status,403);
 assert.equal((await api('outsider','/equipment/EQ-001',{org:orgA})).status,403);
 assert.equal((await api('outsider','/equipment/EQ-001',{org:orgB})).status,200);
 assert.equal((await api('viewer','/nothing')).status,404);
 assert.equal((await fetch(`${base}/organizations/${orgA}/equipment`)).status,401);
});
test('version-checked update writes the row and its audit event together; actor comes from the login, not the body',{skip},async()=>{
 const res=await patch('operator','EQ-007',{expectedVersion:0,status:'in-use',note:'taken to room 104'},'upd-1');
 const out=await res.json();
 assert.equal(res.status,200);assert.equal(out.changed,true);assert.equal(out.record.version,1);assert.equal(out.record.status,'in-use');assert.equal(out.record.lastVerified,null);assert.ok(out.record.lastAdminEditAt);
 const events=await eventsFor('EQ-007');
 assert.equal(events.length,1);assert.equal(events[0].kind,'admin');assert.equal(events[0].actor,`user:${users.operator}`);assert.equal(events[0].idempotency_key,'admin:upd-1');
 assert.deepEqual([events[0].before_state.status,events[0].before_state.version,events[0].after_state.status,events[0].after_state.version],['available',0,'in-use',1]);
 assert.equal((await patch('operator','EQ-008',{expectedVersion:0,status:'in-use',actor:'admin'})).status,400);
});
test('stale writes get 409 with the current version and change nothing',{skip},async()=>{
 const res=await patch('operator','EQ-007',{expectedVersion:0,status:'cleaning'}),out=await res.json();
 assert.equal(res.status,409);assert.equal(out.error,'version_conflict');assert.equal(out.current.version,1);assert.equal(out.current.status,'in-use');
 assert.equal((await row('EQ-007')).status,'in-use');assert.equal((await eventsFor('EQ-007')).length,1);
});
test('invalid input, disallowed transitions, no-ops and missing permission are rejected',{skip},async()=>{
 const cases=[[{expectedVersion:0,status:'broken'},400],[{status:'cleaning'},400],[{expectedVersion:-1,status:'cleaning'},400],[{expectedVersion:0,note:'x'.repeat(501)},400],[{expectedVersion:0,extra:1},400],[{expectedVersion:0,status:'available'},422]];
 for(const [body,status] of cases)assert.equal((await patch('operator','EQ-002',body)).status,status,JSON.stringify(body));
 assert.equal((await api('operator','/equipment/EQ-002',{method:'PATCH',body:{expectedVersion:0,status:'cleaning'}})).status,400,'missing Idempotency-Key');
 assert.equal((await api('operator','/equipment/EQ-002',{method:'PATCH',body:'x',headers:{'idempotency-key':key(),'content-type':'text/plain'}})).status,415);
 assert.equal((await fetch(`${base}/organizations/${orgA}/equipment/EQ-002`,{method:'PATCH',headers:{authorization:`Bearer ${tokens.operator}`,'content-type':'application/json','idempotency-key':key()},body:'{nope'})).status,400);
 assert.equal((await patch('viewer','EQ-002',{expectedVersion:0,status:'cleaning'})).status,403);
 assert.equal((await patch('operator','EQ-002',{expectedVersion:0,status:'cleaning'},key(),orgB)).status,403);
 const noop=await patch('operator','EQ-002',{expectedVersion:0,status:'in-use'}),noopBody=await noop.json();
 assert.equal(noop.status,200);assert.equal(noopBody.changed,false);
 assert.equal((await row('EQ-002')).version,0);assert.equal((await eventsFor('EQ-002')).length,0);
});
test('a failed audit write rolls the whole update back',{skip},async()=>{
 await patch('operator','EQ-003',{expectedVersion:0,status:'cleaning'},'shared-key');
 const before=await row('EQ-004');
 const res=await patch('operator','EQ-004',{expectedVersion:0,status:'cleaning'},'shared-key');
 assert.equal(res.status,409);assert.equal((await res.json()).error,'idempotency_key_reused');
 assert.deepEqual(await row('EQ-004'),before);assert.equal((await eventsFor('EQ-004')).length,0);
});
test('retries replay only the original actor; a different actor conflicts and nothing applies twice',{skip},async()=>{
 const first=await patch('equipment_manager','EQ-005',{expectedVersion:0,status:'cleaning'},'retry-1');assert.equal(first.status,200);
 const again=await patch('equipment_manager','EQ-005',{expectedVersion:0,status:'cleaning'},'retry-1'),out=await again.json();
 assert.equal(again.status,200);assert.equal(again.headers.get('idempotent-replay'),'true');assert.equal(out.replayed,true);assert.equal(out.record.version,1);
 assert.equal((await patch('equipment_manager','EQ-005',{expectedVersion:0,status:'available'},'retry-1')).status,409);
 const op=await patch('operator','EQ-005',{expectedVersion:0,status:'cleaning'},'retry-1');
 assert.equal(op.status,409);
 assert.equal((await row('EQ-005')).version,1);assert.equal((await eventsFor('EQ-005')).length,1);
});
test('concurrent writers with the same expected version: exactly one wins',{skip},async()=>{
 const results=await Promise.all(Array.from({length:8},(_,i)=>patch(i%2?'operator':'equipment_manager','EQ-006',{expectedVersion:0,note:`writer ${i}`})));
 const codes=results.map(r=>r.status).sort();
 assert.deepEqual(codes,[200,409,409,409,409,409,409,409]);
 const r=await row('EQ-006');assert.equal(r.version,1);assert.match(r.note,/^writer \d$/);
 assert.equal((await eventsFor('EQ-006')).length,1);
 const second=await Promise.all(Array.from({length:5},()=>patch('operator','EQ-006',{expectedVersion:1,status:'maintenance'})));
 assert.equal(second.filter(r=>r.status===200).length,1);assert.equal((await row('EQ-006')).version,2);
});
test('observations are recorded, move the verified location only when newer, and never change status or version',{skip},async()=>{
 const t1=iso(-600_000),t0=iso(-3_600_000),before=await row('EQ-008');
 const res=await observe('operator','EQ-008',{locationId:'room-102',observedAt:t1,source:'barcode'},'obs-1'),out=await res.json();
 assert.equal(res.status,201);assert.equal(out.applied,true);assert.equal(out.record.locationId,'room-102');assert.equal(out.record.lastVerified.observedAt,t1);assert.equal(out.record.version,0);assert.equal(out.record.status,'available');
 assert.equal((await row('EQ-008')).version,before.version);
 const late=await (await observe('operator','EQ-008',{locationId:'room-103',observedAt:t0,source:'rfid'},'obs-2')).json();
 assert.equal(late.applied,false);assert.equal(late.reason,'older-than-verified-location');assert.equal(late.record.locationId,'room-102');
 const dup=await (await observe('operator','EQ-008',{locationId:'room-104',observedAt:iso(-1000),source:'barcode'},'obs-1')).json();
 assert.equal(dup.applied,false);assert.equal(dup.reason,'duplicate-idempotency-key');
 assert.equal((await api('viewer','/equipment/EQ-008').then(r=>r.json())).locationId,'room-102');
 const history=(await owner("SELECT count(*)::int AS n FROM equipment_observation WHERE equipment_id = (SELECT id FROM equipment WHERE external_id = 'EQ-008' AND organization_id = $1)",[orgA])).rows[0].n;
 assert.equal(history,2,'the late observation is kept as history, the duplicate is not');
 const kinds=(await eventsFor('EQ-008')).map(e=>e.kind);assert.deepEqual(kinds,['observation']);
 for(const bad of [{locationId:'nowhere',observedAt:t1,source:'barcode'},{locationId:'room-101',observedAt:iso(3_600_000),source:'barcode'},{locationId:'room-101',observedAt:'soon',source:'barcode'},{locationId:'room-101',observedAt:t1,source:'guess'},{locationId:'room-101',observedAt:t1,source:'barcode',actor:'x'}])assert.equal((await observe('operator','EQ-008',bad)).status,400,JSON.stringify(bad));
 assert.equal((await observe('viewer','EQ-008',{locationId:'room-101',observedAt:t1,source:'barcode'})).status,403);
});
test('a status edit does not refresh location confidence',{skip},async()=>{
 const before=await api('viewer','/equipment/EQ-008').then(r=>r.json());
 const edited=await (await patch('operator','EQ-008',{expectedVersion:0,status:'cleaning'})).json();
 assert.deepEqual(edited.record.lastVerified,before.lastVerified);assert.equal(edited.record.locationId,before.locationId);
});
test('record mapping omits empty notes and normalizes timestamps',()=>{
 const rec=toRecord({external_id:'E',name:'n',model_kind:'monitor',location_key:'room-101',status:'available',version:0,note:null,last_admin_edit_at:null,verified_location_key:null,last_verified_at:null,last_verified_source:null,provenance:'p'});
 assert.equal('note' in rec,false);assert.equal(rec.lastVerified,null);
 assert.equal(toRecord({...{external_id:'E',name:'n',model_kind:'monitor',location_key:'r',status:'available',version:1,note:'x',provenance:'p'},last_admin_edit_at:new Date(0),verified_location_key:'r',last_verified_at:'1970-01-01T00:00:00Z',last_verified_source:'barcode'}).lastAdminEditAt,'1970-01-01T00:00:00.000Z');
});
