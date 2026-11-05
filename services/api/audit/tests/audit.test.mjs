import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createAuthorization} from '../../auth/index.mjs';
import {createLocalIdentityProvider} from '../../auth/local-identity.mjs';
import {createAuditHandler} from '../routes.mjs';
import {pseudonym,MAX_EXPORT_ROWS} from '../rules.mjs';

// PGlite is the repo's test-only embedded PostgreSQL (installed under services/api/auth). Without it these tests skip.
let PGlite=null;
try{const req=createRequire(new URL('../../auth/package.json',import.meta.url));PGlite=(await import(pathToFileURL(req.resolve('@electric-sql/pglite')))).PGlite;}catch{}
const skip=PGlite?false:'PGlite not installed: run npm ci --prefix services/api/auth --ignore-scripts';
const sql=relative=>readFileSync(new URL(relative,import.meta.url),'utf8');
const db=skip?null:new PGlite();
const tokens={};
let orgA,orgB,orgC,server,base,available=Promise.resolve();
async function connect(role='sv_auth_test_runtime'){
 const previous=available;let release;available=new Promise(r=>{release=r;});await previous;
 await db.query(role?`SET ROLE ${role}`:'RESET ROLE');
 return {query:(...a)=>db.query(...a),release};
}
const identityProvider=createLocalIdentityProvider({mode:'test'});
const get=(who,path,org=orgA,method='GET')=>fetch(`${base}/organizations/${org}${path}`,{method,headers:{authorization:`Bearer ${tokens[who]}`}});
const json=async res=>({status:res.status,body:await res.json()});
const owner=async(text,params=[])=>{const c=await connect(null);try{return await c.query(text,params);}finally{c.release();}};
const ACTOR='user:00000000-0000-4000-8000-0000000000aa',OTHER='user:00000000-0000-4000-8000-0000000000bb';
let n=0;
const addEvent=(org,ext,{at,kind='admin',actor=ACTOR,source='admin',before={status:'available',version:0},after={status:'in-use',version:1},corr=null})=>
 owner(`INSERT INTO equipment_event (organization_id, equipment_id, kind, actor, source, recorded_at, correlation_id, idempotency_key, before_state, after_state)
  VALUES ($1, (SELECT id FROM equipment WHERE organization_id = $1 AND external_id = $2), $3, $4, $5, $6::timestamptz, $7, $8, $9::jsonb, $10::jsonb)`,[org,ext,kind,actor,source,at,corr,`k-${++n}`,JSON.stringify(before),JSON.stringify(after)]);

before(async()=>{
 if(skip)return;
 await db.exec(sql('../../db/migrations/0001_core.up.sql').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
 await db.exec(sql('../../auth/migrations/0001_auth.up.sql'));
 await db.exec(sql('../../requests/migrations/0001_requests.up.sql'));
 await db.exec(sql('../../db/seed/seed.sql'));
 orgA=(await db.query("SELECT id FROM organization WHERE name LIKE 'Demo%'")).rows[0].id;
 for(const [name,asset] of [['Other org','EQ-001'],['Bulk org','EQ-001']]){
  await db.query('INSERT INTO organization (name) VALUES ($1)',[name]);
  await db.query("INSERT INTO facility (organization_id, name) SELECT id, 'F' FROM organization WHERE name = $1",[name]);
  await db.query("INSERT INTO ward (organization_id, facility_id, name) SELECT organization_id, id, 'W' FROM facility WHERE organization_id = (SELECT id FROM organization WHERE name = $1)",[name]);
  await db.query("INSERT INTO location (organization_id, ward_id, external_key, name, kind) SELECT organization_id, id, 'room-101', 'Room', 'room' FROM ward WHERE organization_id = (SELECT id FROM organization WHERE name = $1)",[name]);
  await db.query("INSERT INTO equipment_type (organization_id, model_kind, name) SELECT id, 'monitor', 'Monitor' FROM organization WHERE name = $1",[name]);
  await db.query(`INSERT INTO equipment (organization_id, external_id, name, equipment_type_id, location_id, status, provenance)
   SELECT o.id, $2, 'Asset', (SELECT id FROM equipment_type WHERE organization_id = o.id), (SELECT id FROM location WHERE organization_id = o.id), 'available', 'test' FROM organization o WHERE o.name = $1`,[name,asset]);
 }
 // An asset whose ID starts with a formula character, to prove CSV cells are neutralised.
 await db.query(`INSERT INTO equipment (organization_id, external_id, name, equipment_type_id, location_id, status, provenance)
  SELECT organization_id, '=SUM(1+1)', 'Formula asset', equipment_type_id, location_id, 'available', 'test' FROM equipment WHERE external_id = 'EQ-001' AND organization_id = $1`,[orgA]);
 await db.exec(`
  CREATE ROLE sv_auth_test_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
  GRANT USAGE ON SCHEMA public TO sv_auth_test_runtime;
  GRANT SELECT, INSERT, UPDATE, DELETE ON organization, facility, ward, location, equipment_type, equipment, equipment_observation, equipment_event, request, request_item, item_assignment, request_event TO sv_auth_test_runtime;
  GRANT SELECT ON auth_user, auth_membership TO sv_auth_test_runtime;
  GRANT EXECUTE ON FUNCTION auth_resolve_identity(text, text) TO sv_auth_test_runtime;`);
 orgB=(await db.query("SELECT id FROM organization WHERE name = 'Other org'")).rows[0].id;
 orgC=(await db.query("SELECT id FROM organization WHERE name = 'Bulk org'")).rows[0].id;
 const people=[['viewer','viewer',orgA],['operator','operator',orgA],['supply_manager','supply_manager',orgA],['equipment_manager','equipment_manager',orgA],['admin','admin',orgA],['outsider','admin',orgB],['bulk','admin',orgC]];
 for(const [i,[name,role,org]] of people.entries()){
  const id=`00000000-0000-4000-8000-${String(700+i).padStart(12,'0')}`;
  await db.query('INSERT INTO auth_user(id, issuer, subject) VALUES ($1, $2, $3)',[id,'urn:supply-vanguard:local',name]);
  await db.query('INSERT INTO auth_membership(organization_id, user_id, role) VALUES ($1, $2, $3)',[org,id,role]);
  tokens[name]=identityProvider.issue(name);
 }
 server=createServer(createAuditHandler({authorization:createAuthorization({identityProvider,pool:{connect:()=>connect()}})}));
 server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
 // Fixture events for org A (oldest first), with microsecond-level neighbours.
 await addEvent(orgA,'EQ-001',{at:'2026-11-05T09:00:00.000000Z'});
 await addEvent(orgA,'EQ-001',{at:'2026-11-05T10:00:00.123456Z',actor:OTHER,kind:'observation',source:'barcode',before:{locationId:'room-101'},after:{locationId:'room-102'}});
 await addEvent(orgA,'EQ-002',{at:'2026-11-05T10:00:00.123789Z',corr:'case-12345',before:{status:'available',version:0,note:'patient in bed 4'},after:{status:'in-use',version:1,note:'moved for Jane Doe',nested:{note:'x'}}});
 await addEvent(orgA,'EQ-002',{at:'2026-11-05T10:00:00.124456Z',source:'rfid',kind:'observation'});
 await addEvent(orgA,'=SUM(1+1)',{at:'2026-11-05T11:00:00.000000Z'});
 await addEvent(orgB,'EQ-001',{at:'2026-11-05T10:30:00.000000Z',actor:'user:other-tenant'});
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(db){await available;await db.close();}});

test('only roles with audit permissions can search or export; everyone else is refused',{skip},async()=>{
 for(const who of ['viewer','operator']){
  assert.equal((await get(who,'/audit/events')).status,403,who);assert.equal((await get(who,'/audit/export')).status,403,who);
 }
 for(const who of ['supply_manager','equipment_manager','admin']){
  assert.equal((await get(who,'/audit/events')).status,200,who);assert.equal((await get(who,'/audit/export')).status,200,who);
 }
 assert.equal((await fetch(`${base}/organizations/${orgA}/audit/events`)).status,401);
 assert.equal((await get('admin','/audit/events',orgB)).status,403,'an org A admin cannot read org B');
 assert.equal((await get('outsider','/audit/events',orgA)).status,403);
 for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await get('admin','/audit/events',orgA,method)).status,405,method);
 assert.equal((await get('admin','/audit/nothing')).status,404);
});
test('search is newest first, tenant-scoped, and filterable by actor, source, kind, asset and time',{skip},async()=>{
 const all=(await json(await get('equipment_manager','/audit/events?limit=100'))).body.items;
 assert.equal(all.length,5);assert.deepEqual(all.map(e=>e.at),[...all.map(e=>e.at)].sort().reverse());
 assert.ok(all.every(e=>e.actor!=='user:other-tenant'),'org B events never appear in org A');
 const q=async s=>(await json(await get('supply_manager',`/audit/events?${s}`))).body.items;
 assert.equal((await q(`actor=${encodeURIComponent(OTHER)}`)).length,1);
 assert.equal((await q('source=barcode')).length,1);assert.equal((await q('source=rfid')).length,1);
 assert.equal((await q('kind=observation')).length,2);assert.equal((await q('kind=admin')).length,3);
 assert.equal((await q('equipment=EQ-002')).length,2);assert.equal((await q('equipment=EQ-404')).length,0);
 assert.equal((await q('from=2026-11-05T10:00:00.123789Z')).length,3,'from is inclusive');
 assert.equal((await q('to=2026-11-05T10:00:00.123789Z')).length,2,'to is exclusive');
 assert.equal((await q('from=2026-11-05T10:00:00Z&to=2026-11-05T10:30:00Z&source=rfid')).length,1);
 assert.equal((await q('equipment=EQ-002&kind=observation&source=rfid')).length,1);
 assert.deepEqual((await json(await get('outsider','/audit/events',orgB))).body.items.map(e=>e.actor),['user:other-tenant']);
 const first=all[all.length-1];
 assert.equal(first.before.status,'available');assert.equal(first.idempotencyKey?.startsWith('k-'),true,'search shows full detail to audit readers');
});
test('pagination is exact to the microsecond: every event once, in order, and it terminates',{skip},async()=>{
 const seen=[];let cursor=null,pages=0;
 do{
  const body=(await json(await get('admin',`/audit/events?limit=1${cursor?`&cursor=${cursor}`:''}`))).body;
  seen.push(...body.items);cursor=body.nextCursor;
  assert.ok(++pages<50,'did not terminate');
 }while(cursor);
 assert.equal(seen.length,5);assert.equal(new Set(seen.map(e=>e.id)).size,5);
 assert.deepEqual(seen.map(e=>e.at),[...seen.map(e=>e.at)].sort().reverse());
 assert.ok(seen.some(e=>e.at==='2026-11-05T10:00:00.123456Z')&&seen.some(e=>e.at==='2026-11-05T10:00:00.123789Z'));
});
test('bad filters and cursors are 400, never ignored',{skip},async()=>{
 const cases=['stream=other','kind=nope','kind=item-claimed','limit=0','limit=101','limit=x','cursor=!!!','from=yesterday','to=2026-11-05','from=2026-11-05T12:00:00Z&to=2026-11-05T11:00:00Z','actor=','bogus=1','request=not-a-uuid','request=00000000-0000-4000-8000-000000000001'];
 for(const c of cases)assert.equal((await get('admin',`/audit/events?${c}`)).status,400,c);
 const forged=Buffer.from(JSON.stringify({t:'2026-11-05T10:00:00.123Z',id:'00000000-0000-4000-8000-000000000001'})).toString('base64url');
 assert.equal((await get('admin',`/audit/events?cursor=${forged}`)).status,400,'millisecond cursors are refused');
 assert.equal((await get('admin','/audit/export?limit=5')).status,400,'export takes no paging parameters');
 assert.equal((await get('admin','/audit/export?format=xml')).status,400);
});
test('the request stream reports request events and is filterable by request',{skip},async()=>{
 const r=await owner("INSERT INTO request (organization_id, requested_by) VALUES ($1, 'user:x') RETURNING id",[orgA]);
 const id=r.rows[0].id;
 await owner(`INSERT INTO request_event (organization_id, request_id, equipment_id, kind, actor, detail, recorded_at) VALUES ($1, $2, (SELECT id FROM equipment WHERE organization_id = $1 AND external_id = 'EQ-003'), 'item-claimed', $3, '{"lineNo":1}'::jsonb, '2026-11-05T12:00:00Z')`,[orgA,id,ACTOR]);
 await owner("INSERT INTO request_event (organization_id, request_id, kind, actor, detail, recorded_at) VALUES ($1, $2, 'request-created', $3, '{\"items\":1}'::jsonb, '2026-11-05T11:59:00Z')",[orgA,id,ACTOR]);
 const body=(await json(await get('admin',`/audit/events?stream=request&request=${id}`))).body.items;
 assert.deepEqual(body.map(e=>[e.kind,e.equipmentId,e.requestId,e.source]),[['item-claimed','EQ-003',id,'request'],['request-created',null,id,'request']]);
 assert.equal((await json(await get('admin','/audit/events?stream=request&kind=item-claimed'))).body.items.length,1);
 assert.equal((await json(await get('admin','/audit/events?stream=request&source=request'))).body.items.length,2);
 assert.equal((await json(await get('admin','/audit/events?stream=request&source=barcode'))).body.items.length,0);
});
test('export redacts free text and identifiers, and neutralises spreadsheet formulas',{skip},async()=>{
 const res=await get('equipment_manager','/audit/export?equipment=EQ-002'),text=await res.text(),body=JSON.parse(text);
 assert.equal(res.headers.get('content-disposition'),'attachment; filename="audit-export.json"');assert.equal(res.headers.get('x-content-type-options'),'nosniff');
 assert.equal(body.events.length,2);
 const noted=body.events.find(e=>e.before?.note!==undefined);
 assert.equal(noted.before.note,'[redacted]');assert.equal(noted.after.note,'[redacted]');assert.equal(noted.after.nested.note,'[redacted]','notes are redacted at any depth');
 for(const needle of ['patient in bed','Jane Doe','case-12345','k-','00000000-0000-4000-8000-0000000000aa'])assert.equal(text.includes(needle),false,`${needle} must not appear in an export`);
 assert.ok(body.events.every(e=>!('correlationId' in e)&&!('idempotencyKey' in e)));
 assert.equal(noted.actor,pseudonym(ACTOR,orgA));assert.match(noted.actor,/^user:[0-9a-f]{12}$/);
 assert.notEqual(pseudonym(ACTOR,orgA),pseudonym(ACTOR,orgB),'the same actor gets a different label in another tenant');
 const csv=await (await get('admin','/audit/export?format=csv')).text();
 assert.match(csv.split('\r\n')[0],/^"at","stream","kind","actor"/);
 assert.ok(csv.includes(`"'=SUM(1+1)"`),'a cell starting with = is prefixed so spreadsheets will not run it');
 assert.equal(/(^|,)"=/m.test(csv),false);
 assert.equal(csv.includes('Jane Doe'),false);
 const csvRes=await get('admin','/audit/export?format=csv');assert.equal(csvRes.headers.get('content-type'),'text/csv; charset=utf-8');
});
test('an export that would be larger than the cap is refused instead of silently cut',{skip},async()=>{
 await owner(`INSERT INTO equipment_event (organization_id, equipment_id, kind, actor, source, recorded_at, idempotency_key, before_state, after_state)
  SELECT $1, (SELECT id FROM equipment WHERE organization_id = $1 AND external_id = 'EQ-001'), 'admin', 'user:bulk', 'admin', '2026-11-05T00:00:00Z'::timestamptz + (g || ' seconds')::interval, 'bulk-' || g, '{}'::jsonb, '{}'::jsonb FROM generate_series(1, ${MAX_EXPORT_ROWS+1}) g`,[orgC]);
 const res=await get('bulk','/audit/export',orgC),body=await res.json();
 assert.equal(res.status,422);assert.equal(body.error,'export_too_large');
 const narrowed=await get('bulk','/audit/export?to=2026-11-05T00:01:00Z',orgC);
 assert.equal(narrowed.status,200);assert.equal((await narrowed.json()).events.length,59);
 const page=(await json(await get('bulk','/audit/events?limit=100',orgC))).body;
 assert.equal(page.items.length,100);assert.ok(page.nextCursor);
});
test('audit data stays immutable underneath the API',{skip},async()=>{
 await assert.rejects(owner("UPDATE equipment_event SET actor = 'x'"),/append-only/);
 await assert.rejects(owner('DELETE FROM equipment_event'),/append-only/);
 await assert.rejects(owner("UPDATE request_event SET actor = 'x'"),/append-only/);
 await assert.rejects(owner('DELETE FROM request_event'),/append-only/);
});
