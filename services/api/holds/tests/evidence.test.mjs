// SV-031: hold-clearance evidence. Domain rules run anywhere. The HTTP and SQL tests run on PGlite, the repo's test-only embedded
// PostgreSQL (skipped if it is not installed). PGlite is one session, so it does NOT prove concurrent behavior: see the README's unrun gates.
// The role-to-kind rules below are TEST FIXTURES; the product ships with none.
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
import {clearanceRequestHash} from '../service.mjs';
import {validateClearanceInput,validateIdempotencyKey,CLEARANCE_BASIS,HOLD_ERRORS,EVIDENCE_LIMITS} from '../../../../packages/domain/holds/index.js';

const NOW=Date.parse('2026-11-10T12:00:00Z');
test('evidence input is validated, normalized, and never echoes what was sent',()=>{
 const good={schemaVersion:1,evidence:{reference:'Cleaning log #12',observedAt:'2026-11-10T09:30:00Z',note:'wiped down'}};
 assert.deepEqual(validateClearanceInput(good,{now:NOW}),{schemaVersion:1,evidence:{reference:'Cleaning log #12',observedAt:'2026-11-10T09:30:00.000Z',note:'wiped down'}});
 assert.equal(validateClearanceInput({schemaVersion:1,evidence:{reference:'A',observedAt:'2026-11-10T09:30:00.123Z'}},{now:NOW}).evidence.observedAt,'2026-11-10T09:30:00.123Z');
 assert.equal(validateClearanceInput({schemaVersion:1,evidence:{reference:'A',observedAt:'2026-11-10T09:30:00.1Z'}},{now:NOW}).evidence.observedAt,'2026-11-10T09:30:00.100Z');
 assert.equal(validateClearanceInput({schemaVersion:1,evidence:{reference:'A',observedAt:'2026-11-10T12:00:00Z'}},{now:NOW}).evidence.observedAt,'2026-11-10T12:00:00.000Z','now is allowed, only the future is not');
 const E=(over)=>({schemaVersion:1,evidence:{reference:'LOG-1',observedAt:'2026-11-10T09:30:00Z',...over}});
 const bad=[null,[],'x',{},{schemaVersion:1},{schemaVersion:2,evidence:E().evidence},{schemaVersion:'1',evidence:E().evidence},{evidence:E().evidence},
  {schemaVersion:1,evidence:null},{schemaVersion:1,evidence:[]},{schemaVersion:1,evidence:{}},
  E({reference:undefined}),E({reference:''}),E({reference:' LOG'}),E({reference:'<b>x</b>'}),E({reference:'x'.repeat(EVIDENCE_LIMITS.reference+1)}),E({reference:5}),
  E({observedAt:undefined}),E({observedAt:'yesterday'}),E({observedAt:'2026-11-10'}),E({observedAt:'2026-11-10T09:30:00+02:00'}),E({observedAt:'2026-11-10T09:30:00'}),E({observedAt:'2026-02-31T09:30:00Z'}),E({observedAt:'2026-11-10T25:00:00Z'}),E({observedAt:'2026-11-10T12:00:01Z'}),E({observedAt:123}),
  E({note:5}),E({note:'x'.repeat(EVIDENCE_LIMITS.note+1)}),E({note:'two\nlines'}),E({note:'bell\u0007'}),
  {...good,actor:'user:1'},{...good,organizationId:'o'},{...good,role:'admin'},{...good,clearedAt:'2026-11-10T09:30:00Z'},E({recordedBy:'user:1'}),E({observedBy:'x'})];
 for(const input of bad)assert.throws(()=>validateClearanceInput(input,{now:NOW}),Error,JSON.stringify(input)?.slice(0,60));
 // Fixed text: a marker placed in every position where a caller could put text never comes back.
 const marker='SECRET-MARKER-QX7';
 for(const input of [{...good,[marker]:1},E({[marker]:1}),E({reference:`<${marker}>`}),E({observedAt:marker}),E({note:`${marker}\n`}),{schemaVersion:marker,evidence:E().evidence}])
  assert.throws(()=>validateClearanceInput(input,{now:NOW}),e=>!e.message.includes(marker));
 assert.throws(()=>validateIdempotencyKey(marker+' '),e=>!e.message.includes(marker));
 assert.equal(validateIdempotencyKey('k-1.a:b_c'),'k-1.a:b_c');
 for(const k of [undefined,null,'',' ','a b','x'.repeat(EVIDENCE_LIMITS.idempotencyKey+1),'k/1',5])assert.throws(()=>validateIdempotencyKey(k));
});
test('observedAt precision is milliseconds: finer input is refused instead of silently truncated (SV-033)',()=>{
 const at=observedAt=>validateClearanceInput({schemaVersion:1,evidence:{reference:'A',observedAt}},{now:NOW}).evidence.observedAt;
 // Two instants that differ only below a millisecond used to be accepted and collapsed into one request (one hash).
 for(const fine of ['2026-11-10T09:30:00.123001Z','2026-11-10T09:30:00.123999Z','2026-11-10T09:30:00.1234Z','2026-11-10T09:30:00.123456Z'])assert.throws(()=>at(fine),/millisecond/i,fine);
 // 12:00:00.000999 is after the supplied present-time boundary 12:00:00.000. It used to pass by truncation.
 assert.throws(()=>at('2026-11-10T12:00:00.000999Z'),Error);assert.equal(at('2026-11-10T12:00:00.000Z'),'2026-11-10T12:00:00.000Z');
 assert.throws(()=>at('2026-11-10T12:00:00.001Z'),/future/);
 assert.equal(at('2026-11-10T09:30:00.123Z'),'2026-11-10T09:30:00.123Z');
 const id='00000000-0000-4000-8000-000000000001';
 const hashOf=o=>clearanceRequestHash(id,validateClearanceInput({schemaVersion:1,evidence:{reference:'A',observedAt:o}},{now:NOW}));
 assert.notEqual(hashOf('2026-11-10T09:30:00.123Z'),hashOf('2026-11-10T09:30:00.124Z'),'distinct accepted instants never share a request hash');
 assert.equal(hashOf('2026-11-10T09:30:00.12Z'),hashOf('2026-11-10T09:30:00.120Z'),'only spellings of the same instant do');
});
test('the request hash is stable for the same meaning and changes with the hold or any evidence field',()=>{
 const a=validateClearanceInput({schemaVersion:1,evidence:{reference:'R',observedAt:'2026-11-10T09:30:00Z'}},{now:NOW});
 const b=validateClearanceInput({schemaVersion:1,evidence:{reference:'R',observedAt:'2026-11-10T09:30:00.000Z'}},{now:NOW});
 const id='00000000-0000-4000-8000-000000000001';
 assert.match(clearanceRequestHash(id,a),/^[0-9a-f]{64}$/);
 assert.equal(clearanceRequestHash(id,a),clearanceRequestHash(id,b),'two spellings of one instant are one request');
 assert.equal(clearanceRequestHash(id,a),clearanceRequestHash(id.toUpperCase(),a));
 assert.notEqual(clearanceRequestHash(id,a),clearanceRequestHash('00000000-0000-4000-8000-000000000002',a));
 const withNote=validateClearanceInput({schemaVersion:1,evidence:{reference:'R',observedAt:'2026-11-10T09:30:00Z',note:'n'}},{now:NOW});
 assert.notEqual(clearanceRequestHash(id,a),clearanceRequestHash(id,withNote));
 assert.notEqual(clearanceRequestHash(id,a),clearanceRequestHash(id,{...a,evidence:{...a.evidence,reference:'S'}}));
 assert.notEqual(clearanceRequestHash(id,a),clearanceRequestHash(id,{...a,evidence:{...a.evidence,observedAt:'2026-11-10T09:30:01.000Z'}}));
});
test('new error codes map to HTTP statuses and the two clearance bases are distinct',()=>{
 assert.equal(HOLD_ERRORS.idempotency_conflict,409);assert.equal(HOLD_ERRORS.evidence_invalid,422);
 for(const status of Object.values(HOLD_ERRORS))assert.ok([403,404,409,422].includes(status),'the root holds test allows only these statuses');
 assert.notEqual(CLEARANCE_BASIS.evidence,CLEARANCE_BASIS.legacy);assert.match(CLEARANCE_BASIS.legacy,/no-additional-evidence/);
});

let PGlite=null;
try{const req=createRequire(new URL('../../auth/package.json',import.meta.url));PGlite=(await import(pathToFileURL(req.resolve('@electric-sql/pglite')))).PGlite;}catch{}
const skip=PGlite?false:'PGlite not installed: run npm run setup:test';
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
const call=(who,path,{method='GET',body,org,headers={}}={})=>fetch(`${base}/organizations/${org??orgA}${path}`,{method,headers:{authorization:`Bearer ${tokens[who]}`,...(body!==undefined&&{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
const owner=async(text,params=[])=>{const c=await connect(null);try{return await c.query(text,params);}finally{c.release();}};
const asRole=async(who,org,work)=>{const c=await connect();try{await c.query('BEGIN');await c.query("SELECT set_config('sv.user_id', $1, true), set_config('sv.organization_id', $2, true)",[users[who],org]);return await work(c);}finally{await c.query('ROLLBACK');c.release();}};
const observed=(minutesAgo=1)=>new Date(Date.now()-minutesAgo*60000).toISOString();
const evidence=(over={})=>({schemaVersion:1,evidence:{reference:'Cleaning log #12',observedAt:observed(),...over}});
const place=async(eq,kind,reason,who='operator',org)=>(await (await call(who,`/equipment/${eq}/holds`,{method:'POST',body:{kind,...(reason&&{reason})},org})).json()).hold;
const clearEv=(who,holdId,{body=evidence(),key='key-1',org,headers={}}={})=>call(who,`/holds/${holdId}/clearances`,{method:'POST',body,org,headers:{...(key!==null&&{'idempotency-key':key}),...headers}});
const legacyClear=(who,holdId)=>call(who,`/holds/${holdId}/clear`,{method:'POST'});
const setRule=(kind,role)=>call('admin',`/holds/clearance-rules/${kind}`,{method:'PUT',body:{role}});
const expectError=async(res,status,code)=>{const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));assert.equal(body.error,code);return body;};
const counts=async()=>(await owner('SELECT (SELECT count(*) FROM hold_clearance_evidence)::int AS e, (SELECT count(*) FROM hold_clearance_receipt)::int AS r')).rows[0];
const holdsOf=async(eq,state='all')=>(await (await call('viewer',`/equipment/${eq}/holds?state=${state}`)).json());
const claim=async(who,requestId,equipmentId)=>call(who,`/requests/${requestId}/items/1/claim`,{method:'POST',body:{equipmentId,expectedVersion:0}});

before(async()=>{
 if(skip)return;
 await db.exec(sql('../../db/migrations/0001_core.up.sql').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
 await db.exec(sql('../../auth/migrations/0001_auth.up.sql'));
 await db.exec(sql('../../requests/migrations/0001_requests.up.sql'));
 await db.exec(sql('../migrations/0001_holds.up.sql'));
 await db.exec(sql('../migrations/0002_hold_clearance_evidence.up.sql'));
 await db.exec(sql('../migrations/0003_hold_evidence_replay_role.up.sql'));
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
  GRANT EXECUTE ON FUNCTION auth_resolve_identity(text, text), claim_request_item(uuid, integer, uuid, integer, text), place_equipment_hold(uuid, text, text, text), clear_equipment_hold(uuid, text), clear_equipment_hold_with_evidence(uuid, text, text, text, timestamptz, text) TO sv_auth_test_runtime;`);
 orgB=(await db.query("SELECT id FROM organization WHERE name = 'Other org'")).rows[0].id;
 const people=[['viewer','viewer',orgA],['operator','operator',orgA],['supply_manager','supply_manager',orgA],['equipment_manager','equipment_manager',orgA],['equipment_manager2','equipment_manager',orgA],['admin','admin',orgA],['outsider','admin',orgB]];
 for(const [i,[name,role,org]] of people.entries()){
  const id=`00000000-0000-4000-8000-${String(700+i).padStart(12,'0')}`;users[name]=id;
  await db.query('INSERT INTO auth_user(id, issuer, subject) VALUES ($1, $2, $3)',[id,'urn:supply-vanguard:local',name]);
  await db.query('INSERT INTO auth_membership(organization_id, user_id, role) VALUES ($1, $2, $3)',[org,id,role]);
  tokens[name]=identityProvider.issue(name);
 }
 const authorization=createAuthorization({identityProvider,pool:{connect:()=>connect()}}),holds=createHoldsHandler({authorization}),requests=createRequestsHandler({authorization});
 server=createServer((req,res)=>/\/(holds\/|equipment\/[^/]+\/holds)/.test(req.url)?holds(req,res):requests(req,res));
 server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(db){await available;await db.close();}});

test('with no clearance rule, evidence does not let anyone clear a hold, and nothing is stored',{skip},async()=>{
 const hold=await place('EQ-008','dirty');
 for(const who of ['viewer','operator','supply_manager','equipment_manager','admin'])await expectError(await clearEv(who,hold.id,{key:`k-${who}`}),422,'no_clearance_rule');
 assert.deepEqual(await counts(),{e:0,r:0});assert.equal((await holdsOf('EQ-008','active')).summary.active,1);
 // fixtures: who clears what is configuration. These are test values, not product defaults.
 for(const [kind,role] of [['dirty','supply_manager'],['fault','equipment_manager'],['maintenance','equipment_manager'],['unknown','admin']])assert.equal((await setRule(kind,role)).status,200);
});

test('clearing with evidence records it with the cleared hold, the authenticated actor and the server time',{skip},async()=>{
 const hold=await place('EQ-001','fault','pump alarm');
 const sent=evidence({reference:'Biomed WO 4471',note:'<img src=x onerror=alert(1)> checked'}),at=Date.now();
 const res=await clearEv('equipment_manager',hold.id,{body:sent,key:'clear-eq001'}),body=await res.json();
 assert.equal(res.status,201,JSON.stringify(body));assert.equal(body.replayed,false);
 assert.equal(body.hold.active,false);assert.equal(body.hold.clearedBy,`user:${users.equipment_manager}`);
 assert.equal(body.hold.clearance.basis,CLEARANCE_BASIS.evidence);
 const ev=body.hold.clearance.evidence;
 assert.deepEqual([ev.schemaVersion,ev.reference,ev.observedAt,ev.recordedBy],[1,'Biomed WO 4471',new Date(sent.evidence.observedAt).toISOString(),`user:${users.equipment_manager}`]);
 assert.equal(ev.note,sent.evidence.note,'text is stored and returned verbatim as inert JSON text');
 assert.ok(Math.abs(Date.parse(body.hold.clearedAt)-at)<60000&&Date.parse(body.hold.clearedAt)>Date.parse(ev.observedAt),'cleared time is the server clock, not the supplied observation time');
 assert.equal(ev.recordedAt,body.hold.clearedAt,'evidence and clearance share one transaction time');
 assert.equal(body.hold.reason,'pump alarm','the placement reason is kept apart from the evidence');
 assert.deepEqual(await counts(),{e:1,r:1});
 const listed=(await holdsOf('EQ-001')).holds[0];assert.deepEqual(listed.clearance,body.hold.clearance);
 assert.equal((await holdsOf('EQ-001','active')).summary.blocked,false);
 const stored=(await owner("SELECT reference, note FROM hold_clearance_evidence WHERE hold_id = $1",[hold.id])).rows[0];assert.equal(stored.note,sent.evidence.note);
});

test('the client cannot supply or override the actor, tenant, role or time',{skip},async()=>{
 const hold=await place('EQ-002','fault');
 const marker='SPOOF-MARKER-1';
 const spoofs=[{actor:marker},{recordedBy:marker},{clearedBy:marker},{clearedAt:'2020-01-01T00:00:00Z'},{organizationId:orgB},{role:'admin'},{tenant:marker}];
 for(const extra of spoofs){
  for(const body of [{...evidence(),...extra},evidence(extra)]){
   const res=await clearEv('equipment_manager',hold.id,{body,key:'spoof-1'}),text=await res.text();
   assert.equal(res.status,400,text);assert.ok(!text.includes(marker),'the refusal does not echo what was sent');
  }
 }
 assert.deepEqual([(await counts()).e,(await holdsOf('EQ-002','active')).summary.active],[1,1],'nothing changed');
 // Headers that look like identity are ignored: the actor is the authenticated user.
 const res=await clearEv('equipment_manager',hold.id,{key:'spoof-2',headers:{'x-actor':marker,'x-user-id':users.admin,'x-organization-id':orgB}}),body=await res.json();
 assert.equal(res.status,201);assert.equal(body.hold.clearedBy,`user:${users.equipment_manager}`);assert.equal(body.hold.clearance.evidence.recordedBy,`user:${users.equipment_manager}`);
 // Another tenant's admin (a member of org B only) cannot clear an org A hold, by either path.
 const other=await place('EQ-003','fault');
 assert.equal((await clearEv('outsider',other.id,{key:'x1'})).status,403);
 await expectError(await clearEv('outsider',other.id,{key:'x2',org:orgB}),404,'hold_not_found');
 assert.equal((await holdsOf('EQ-003','active')).summary.active,1);
});

test('missing or malformed evidence and a missing key are refused, and a refusal changes nothing',{skip},async()=>{
 const hold=await place('EQ-004','fault'),before=await counts();
 const E=over=>evidence(over);
 const cases=[[evidence(),null],[evidence(),'bad key!'],[evidence(),'k'.repeat(89)],[{},'k1'],[{schemaVersion:1},'k1'],[{schemaVersion:1,evidence:{}},'k1'],[{evidence:E().evidence},'k1'],
  [E({reference:''}),'k1'],[E({reference:'<script>'}),'k1'],[E({observedAt:'not a date'}),'k1'],[E({observedAt:new Date(Date.now()+3600e3).toISOString()}),'k1'],
  [E({note:'a\nb'}),'k1'],[E({note:'x'.repeat(501)}),'k1'],[[],'k1'],['text','k1'],[{...evidence(),schemaVersion:3},'k1']];
 for(const [body,key] of cases){const res=await clearEv('equipment_manager',hold.id,{body,key});assert.equal(res.status,400,JSON.stringify(body)?.slice(0,80));assert.equal((await res.json()).error,'invalid_request');}
 const noType=await fetch(`${base}/organizations/${orgA}/holds/${hold.id}/clearances`,{method:'POST',headers:{authorization:`Bearer ${tokens.equipment_manager}`,'idempotency-key':'k1'},body:'{}'});assert.equal(noType.status,415);
 const badJson=await fetch(`${base}/organizations/${orgA}/holds/${hold.id}/clearances`,{method:'POST',headers:{authorization:`Bearer ${tokens.equipment_manager}`,'content-type':'application/json','idempotency-key':'k1'},body:'{nope'});assert.equal(badJson.status,400);
 const noAuth=await fetch(`${base}/organizations/${orgA}/holds/${hold.id}/clearances`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'k1'},body:JSON.stringify(evidence())});assert.equal(noAuth.status,401);
 await expectError(await clearEv('equipment_manager','not-a-uuid'),404,'hold_not_found');
 await expectError(await clearEv('equipment_manager','00000000-0000-4000-8000-0000000000ff'),404,'hold_not_found');
 assert.deepEqual(await counts(),before);assert.equal((await holdsOf('EQ-004','active')).summary.active,1);
});

test('only the configured role can clear, with or without evidence, and a refusal stores nothing',{skip},async()=>{
 const hold=await place('EQ-005','dirty'),before=await counts();
 for(const who of ['viewer','operator','equipment_manager','equipment_manager2','admin'])await expectError(await clearEv(who,hold.id,{key:`w-${who}`}),403,'wrong_role');
 assert.deepEqual(await counts(),before);assert.equal((await holdsOf('EQ-005','active')).summary.active,1);
 assert.equal((await clearEv('supply_manager',hold.id,{key:'w-ok'})).status,201);
 await expectError(await clearEv('supply_manager',hold.id,{key:'w-again'}),409,'hold_already_cleared');
 assert.equal((await counts()).e,before.e+1,'the second attempt on a cleared hold stored no second evidence');
});

test('an exact retry returns the original result; a changed payload or someone else\'s key is a safe conflict',{skip},async()=>{
 const hold=await place('EQ-006','fault'),other=await place('EQ-006','maintenance'),before=await counts();
 const half=new Date(Date.now()-60000);half.setMilliseconds(500);                  // .500 so a shorter spelling (.5) is exactly the same instant
 const body=evidence({note:'first',observedAt:half.toISOString()});
 const first=await clearEv('equipment_manager',hold.id,{body,key:'retry-1'}),a=await first.json();assert.equal(first.status,201);
 const again=await clearEv('equipment_manager',hold.id,{body,key:'retry-1'}),b=await again.json();
 assert.equal(again.status,200);assert.equal(again.headers.get('idempotent-replay'),'true');assert.equal(b.replayed,true);
 assert.deepEqual(b.hold,a.hold,'the original clearance and evidence, unchanged');
 const spelled=await clearEv('equipment_manager',hold.id,{body:evidence({note:'first',observedAt:body.evidence.observedAt.replace('500Z','5Z')}),key:'retry-1'});assert.equal(spelled.status,200,'the same instant spelled differently is the same request');
 assert.deepEqual(await counts(),{e:before.e+1,r:before.r+1},'retries stored nothing more');
 // Changed payload, same key and actor.
 await expectError(await clearEv('equipment_manager',hold.id,{body:evidence({note:'changed'}),key:'retry-1'}),409,'idempotency_conflict');
 await expectError(await clearEv('equipment_manager',other.id,{body,key:'retry-1'}),409,'idempotency_conflict');   // same key and payload, different hold
 // A different actor reusing the key on a hold they may clear: same answer, and the hold stays active.
 await expectError(await clearEv('equipment_manager2',other.id,{body,key:'retry-1'}),409,'idempotency_conflict');
 assert.equal((await holdsOf('EQ-006','active')).holds.length,1,'the conflict cleared nothing');
 assert.deepEqual(await counts(),{e:before.e+1,r:before.r+1});
 // The key's owner can see the receipt; nobody else can.
 const visible=who=>asRole(who,orgA,async c=>(await c.query("SELECT count(*)::int AS n FROM hold_clearance_receipt WHERE idempotency_key = 'retry-1'")).rows[0].n);
 assert.equal(await visible('equipment_manager'),1);assert.equal(await visible('equipment_manager2'),0);assert.equal(await visible('admin'),0);assert.equal(await visible('outsider'),0);
 // A new key on the same cleared hold is refused, not duplicated.
 await expectError(await clearEv('equipment_manager',hold.id,{body,key:'retry-2'}),409,'hold_already_cleared');
 assert.deepEqual(await counts(),{e:before.e+1,r:before.r+1});
 // The same key string in another tenant is independent.
 await setRuleFor('outsider','fault','admin');
 const mine=await place('EQ-007','fault',undefined,'outsider',orgB);
 assert.equal((await clearEv('outsider',mine.id,{body,key:'retry-1',org:orgB})).status,201);
});
async function setRuleFor(who,kind,role){const res=await call(who,`/holds/clearance-rules/${kind}`,{method:'PUT',body:{role},org:orgB});assert.equal(res.status,200);}

test('clearance, evidence and receipt commit together or not at all',{skip},async()=>{
 const hold=await place('EQ-001','dirty'),before=await counts();
 const fn=(who,args)=>asRole(who,orgA,c=>c.query('SELECT public.clear_equipment_hold_with_evidence($1,$2,$3,$4,$5::timestamptz,$6)',args));
 const future=new Date(Date.now()+3600e3).toISOString(),hash='a'.repeat(64);
 await assert.rejects(fn('supply_manager',[hold.id,'atomic-1',hash,'LOG-1',future,null]),/sv:evidence_invalid/);
 await assert.rejects(fn('supply_manager',[hold.id,'atomic-2',hash,'<bad>',observed(),null]),/sv:evidence_invalid/);
 await assert.rejects(fn('supply_manager',[hold.id,'atomic-3',hash,'LOG-1',observed(),'a\nb']),/sv:evidence_invalid/);
 await assert.rejects(fn('supply_manager',[hold.id,'atomic-4','not-a-hash','LOG-1',observed(),null]),/hash|check|violat/i);
 await assert.rejects(fn('equipment_manager',[hold.id,'atomic-5',hash,'LOG-1',observed(),null]),/sv:wrong_role/);
 assert.deepEqual(await counts(),before);
 assert.equal((await holdsOf('EQ-001','active')).summary.activeKinds.includes('dirty'),true,'a failed attempt leaves the hold active');
 assert.equal((await owner('SELECT active, cleared_by FROM equipment_hold WHERE id = $1',[hold.id])).rows[0].active,true);
 // The function ignores any claim of identity: with no session identity it refuses.
 await assert.rejects(owner('SELECT public.clear_equipment_hold_with_evidence($1,$2,$3,$4,$5::timestamptz,$6)',[hold.id,'atomic-6',hash,'LOG-1',observed(),null]),/sv:no_tenant_context/);
 await clearEv('supply_manager',hold.id,{key:'atomic-ok'});
});

test('stacked holds stay independent: clearing one with evidence leaves the other blocking',{skip},async()=>{
 const dirty=await place('EQ-003','dirty'),fault=await place('EQ-003','fault');
 const req=await (await call('operator','/requests',{method:'POST',body:{items:[{equipmentType:'infusion'}]}})).json();
 const cleared=await (await clearEv('supply_manager',dirty.id,{key:'stack-1'})).json();
 assert.equal(cleared.hold.active,false);assert.deepEqual(cleared.summary,{blocked:true,activeKinds:['fault'],active:1,total:2});
 const listing=(await holdsOf('EQ-003')).holds,byKind=Object.fromEntries(listing.map(h=>[h.kind,h]));
 assert.equal(byKind.dirty.clearance.basis,CLEARANCE_BASIS.evidence);assert.equal(byKind.fault.clearance,null,'the other hold has no clearance and no borrowed evidence');
 assert.equal((await claim('operator',req.id,'EQ-003')).status,422,'the asset is still unassignable');
 await expectError(await clearEv('supply_manager',fault.id,{key:'stack-2'}),403,'wrong_role');
 assert.equal((await owner('SELECT count(*)::int AS n FROM hold_clearance_evidence WHERE hold_id = $1',[fault.id])).rows[0].n,0);
 assert.equal((await clearEv('equipment_manager',fault.id,{key:'stack-3'})).status,201);
 assert.equal((await claim('operator',req.id,'EQ-003')).status,201,'assignable only when every hold is cleared');
});

test('legacy clearing still works and is marked as having no additional evidence',{skip},async()=>{
 const hold=await place('EQ-004','dirty','cleaned by hand');
 const res=await legacyClear('supply_manager',hold.id),body=await res.json();
 assert.equal(res.status,200);assert.equal(body.hold.clearedBy,`user:${users.supply_manager}`);
 assert.deepEqual(body.hold.clearance,{basis:CLEARANCE_BASIS.legacy,evidence:null},'actor and time are not read as evidence');
 assert.equal(body.hold.reason,'cleaned by hand');assert.equal(body.hold.clearance.evidence,null,'a placement reason is not clearance evidence');
 const before=await counts();
 await expectError(await clearEv('supply_manager',hold.id,{key:'legacy-1'}),409,'hold_already_cleared');
 assert.deepEqual(await counts(),before,'a legacy-cleared hold is not retroactively given evidence');
 const active=await place('EQ-004','unknown');assert.equal(active.clearance,null);
});

test('evidence and receipts are append-only and tenant-scoped at the database',{skip},async()=>{
 await assert.rejects(owner("UPDATE hold_clearance_evidence SET reference = 'EDITED'"),/append-only/);
 await assert.rejects(owner('DELETE FROM hold_clearance_evidence'),/append-only/);
 await assert.rejects(owner("UPDATE hold_clearance_receipt SET actor = 'x'"),/append-only/);
 await assert.rejects(owner('DELETE FROM hold_clearance_receipt'),/append-only/);
 await assert.rejects(asRole('equipment_manager',orgA,c=>c.query("UPDATE hold_clearance_evidence SET reference = 'EDITED'")),/permission denied|row-level|append-only/);
 const rows=who=>asRole(who,orgA,async c=>(await c.query('SELECT count(*)::int AS n FROM hold_clearance_evidence')).rows[0].n);
 assert.ok(await rows('viewer')>0,'any member with inventory:read can read evidence');
 assert.equal(await asRole('outsider',orgB,async c=>(await c.query('SELECT count(*)::int AS n FROM hold_clearance_evidence')).rows[0].n),1,'another tenant sees only its own evidence');
 assert.equal(await asRole('outsider',orgA,async c=>(await c.query('SELECT count(*)::int AS n FROM hold_clearance_evidence')).rows[0].n),0,'and nothing of this tenant even if it names it');
 // A wrong role cannot insert evidence directly (row-level security), even for an active hold of a kind it does not clear.
 const hold=await place('EQ-002','maintenance');
 await assert.rejects(asRole('supply_manager',orgA,c=>c.query("INSERT INTO hold_clearance_evidence (organization_id, hold_id, schema_version, reference, observed_at, recorded_by) VALUES ($1, $2, 1, 'LOG-1', now() - interval '1 minute', 'x')",[orgA,hold.id])),/row-level security/);
 await assert.rejects(asRole('viewer',orgA,c=>c.query("INSERT INTO hold_clearance_receipt (organization_id, idempotency_key, actor, request_hash, hold_id, evidence_id) VALUES ($1, 'k', 'user:someone-else', $2, $3, $3)",[orgA,'a'.repeat(64),hold.id])),/row-level security|violates/);
});

// ---- SV-033: replay must pass the CURRENT role check; replay returns the original hold/evidence with CURRENT stack state ----
const setMembership=async(who,{role,active})=>{
 const before=(await owner('SELECT role, active FROM auth_membership WHERE user_id = $1 AND organization_id = $2',[users[who],orgA])).rows[0];
 await owner('UPDATE auth_membership SET role = COALESCE($3, role), active = COALESCE($4, active) WHERE user_id = $1 AND organization_id = $2',[users[who],orgA,role??null,active??null]);
 return ()=>owner('UPDATE auth_membership SET role = $3, active = $4 WHERE user_id = $1 AND organization_id = $2',[users[who],orgA,before.role,before.active]);
};
test('a replay is checked against the CURRENT configured role, with no extra writes (SV-033)',{skip},async()=>{
 const hold=await place('EQ-008','fault'),body=evidence({note:'replay-auth'}),key='replay-auth-1';
 const first=await clearEv('equipment_manager',hold.id,{body,key});assert.equal(first.status,201);
 const written=await counts();
 // Positive control: still the right role, an exact replay succeeds.
 const ok=await clearEv('equipment_manager',hold.id,{body,key});assert.equal(ok.status,200);assert.equal((await ok.json()).replayed,true);
 // 1. Role downgrade: the caller no longer holds the configured role.
 let restore=await setMembership('equipment_manager',{role:'viewer'});
 await expectError(await clearEv('equipment_manager',hold.id,{body,key}),403,'wrong_role');
 await expectError(await clearEv('equipment_manager',hold.id,{body:evidence({note:'different'}),key}),403,'wrong_role');   // a changed payload is also refused on role first
 await restore();
 // 2. The organization changed the rule for this kind to another role.
 assert.equal((await setRule('fault','admin')).status,200);
 await expectError(await clearEv('equipment_manager',hold.id,{body,key}),403,'wrong_role');
 assert.equal((await setRule('fault','equipment_manager')).status,200);
 // 3. The rule was removed.
 const rule=(await owner("SELECT role FROM hold_clearance_rule WHERE organization_id = $1 AND kind = 'fault'",[orgA])).rows[0].role;
 await owner("DELETE FROM hold_clearance_rule WHERE organization_id = $1 AND kind = 'fault'",[orgA]);
 await expectError(await clearEv('equipment_manager',hold.id,{body,key}),422,'no_clearance_rule');
 await owner("INSERT INTO hold_clearance_rule (organization_id, kind, role) VALUES ($1, 'fault', $2)",[orgA,rule]);
 // 4. Membership revoked: this still fails at authorization.
 restore=await setMembership('equipment_manager',{active:false});
 const revoked=await clearEv('equipment_manager',hold.id,{body,key});assert.equal(revoked.status,403);assert.notEqual((await revoked.json()).replayed,true);
 await restore();
 // Nothing was written by any of the refused replays, and the original outcome is untouched.
 assert.deepEqual(await counts(),written);
 assert.equal((await owner('SELECT count(*)::int AS n FROM hold_clearance_evidence WHERE hold_id = $1',[hold.id])).rows[0].n,1);
 // With everything restored the same replay works again, and another actor's reuse of the key is still the private 409.
 const back=await clearEv('equipment_manager',hold.id,{body,key});assert.equal(back.status,200);
 const other=await place('EQ-008','maintenance');
 await expectError(await clearEv('equipment_manager2',other.id,{body,key}),409,'idempotency_conflict');
});

test('a replay returns the same cleared hold and evidence, with the CURRENT stack state labelled as current (SV-033)',{skip},async()=>{
 const fault=await place('EQ-005','fault'),body=evidence({note:'stack-basis'}),key='stack-basis-1';
 const first=await (await clearEv('equipment_manager',fault.id,{body,key})).json();
 assert.equal(first.summaryBasis,'current');assert.equal(first.summary.blocked,false);
 await place('EQ-005','unknown');                                               // another hold appears after the clearance
 const replayRes=await clearEv('equipment_manager',fault.id,{body,key}),replay=await replayRes.json();
 assert.equal(replayRes.status,200);assert.equal(replay.replayed,true);
 assert.deepEqual(replay.hold,first.hold,'the receipt part (the cleared hold and its evidence) is exactly the original');
 assert.equal(replay.summaryBasis,'current','summary and holds are current state, not receipt history');
 assert.equal(replay.summary.blocked,true);assert.deepEqual(replay.summary.activeKinds,['unknown']);
 assert.notDeepEqual(replay.summary,first.summary,'the stack part may differ from the original response');
 assert.deepEqual(replay.holds.map(h=>h.kind),['unknown']);
});

test('migrations 0003 and 0002 roll back and forward without losing holds or grants',{skip},async()=>{
 const holds=()=>owner('SELECT count(*)::int AS n FROM equipment_hold').then(r=>r.rows[0].n);
 const body=()=>owner("SELECT prosrc FROM pg_proc WHERE proname = 'clear_equipment_hold_with_evidence'").then(r=>r.rows[0].prosrc);
 const canRun=()=>owner("SELECT has_function_privilege('sv_auth_test_runtime', 'clear_equipment_hold_with_evidence(uuid,text,text,text,timestamptz,text)', 'EXECUTE') AS ok").then(r=>r.rows[0].ok);
 const before=await holds();
 assert.match(await body(),/SV-033/,'0003 is in force');
 // 0003 is a function replacement: undoing it restores the 0002 body and keeps the grant; redoing it is idempotent.
 await db.exec(sql('../migrations/0003_hold_evidence_replay_role.down.sql'));
 assert.doesNotMatch(await body(),/SV-033/);assert.equal(await canRun(),true,'CREATE OR REPLACE keeps existing EXECUTE grants');
 await db.exec(sql('../migrations/0003_hold_evidence_replay_role.up.sql'));
 assert.match(await body(),/SV-033/);assert.equal(await canRun(),true);
 // 0002 itself can still be undone and redone; 0003 then re-applies on top.
 await db.exec(sql('../migrations/0002_hold_clearance_evidence.down.sql'));
 assert.equal((await owner("SELECT to_regclass('public.hold_clearance_evidence') AS t")).rows[0].t,null);
 assert.equal(await holds(),before);
 await db.exec(sql('../migrations/0002_hold_clearance_evidence.up.sql'));
 await db.exec(sql('../migrations/0003_hold_evidence_replay_role.up.sql'));
 assert.ok((await owner("SELECT to_regclass('public.hold_clearance_receipt') AS t")).rows[0].t);assert.match(await body(),/SV-033/);
});
