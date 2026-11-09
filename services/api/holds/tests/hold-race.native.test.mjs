import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pgBin,startCluster,stopCluster,createDatabase,psql,migrateUp} from '../../db/lib.mjs';

// Real PostgreSQL and real separate sessions (one psql process each) with a fixed, lock-based interleaving, no sleeps.
// The question: when a claim and a hold on the same asset overlap, is the outcome always consistent?
//   Order 1: the hold commits first, so a claim that was already waiting on the asset must be refused.
//   Order 2: the claim commits first, so the hold that was waiting is then placed; the earlier claim stands.
// Skips when PostgreSQL is not installed.
const skip=pgBin()?false:'PostgreSQL not installed (brew install postgresql@16); native hold-race test skipped';
const file=rel=>fileURLToPath(new URL(rel,import.meta.url));
const dir=skip?null:mkdtempSync(join(tmpdir(),'sv-holdrace-'));
const GATE=778;
let port,ids;
const url=()=>`postgresql://sv@127.0.0.1:${port}/race`;
const rows=sql=>psql(url(),sql).split('\n').filter(Boolean);
const rt=()=>`postgresql://sv_rt@127.0.0.1:${port}/race`;
function session(app,script){
 const child=spawn(join(pgBin(),'psql'),[rt(),'-X','-q','-v','ON_ERROR_STOP=1','-At'],{env:{...process.env,PGAPPNAME:app},stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
 const done=new Promise(resolve=>child.on('close',code=>resolve({code,out:out.trim(),err:err.trim()})));
 child.stdin.end(script);
 return done;
}
async function until(check,what,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,25));}throw new Error(`timed out waiting for ${what}`);}
const waiting=app=>rows(`SELECT wait_event_type || ':' || wait_event FROM pg_stat_activity WHERE application_name = '${app}' AND wait_event_type = 'Lock'`);
const ctx=user=>`SELECT set_config('sv.user_id', '${user}', true), set_config('sv.organization_id', '${ids.org}', true);`;
const claimSql=(req,eq)=>`SELECT public.claim_request_item('${req}', 1, '${eq}', 0, 'user:a');`;
const placeSql=(eq,kind)=>`SELECT public.place_equipment_hold('${eq}', '${kind}', null, 'user:b');`;

before(()=>{
 if(skip)return;
 port=54900+Math.floor(Math.random()*90);
 const admin=startCluster(dir,port);createDatabase(admin,'race');
 migrateUp(url());
 for(const f of ['../../auth/migrations/0001_auth.up.sql','../../requests/migrations/0001_requests.up.sql','../migrations/0001_holds.up.sql'])psql(url(),'',{file:file(f)});
 psql(url(),`
  CREATE ROLE sv_rt NOSUPERUSER NOBYPASSRLS LOGIN;
  GRANT USAGE ON SCHEMA public TO sv_rt;
  GRANT SELECT, INSERT, UPDATE, DELETE ON organization, facility, ward, location, equipment_type, equipment, equipment_observation, equipment_event, request, request_item, item_assignment, request_event, equipment_hold, hold_clearance_rule TO sv_rt;
  GRANT SELECT ON auth_user, auth_membership TO sv_rt;
  GRANT EXECUTE ON FUNCTION auth_resolve_identity(text, text), claim_request_item(uuid, integer, uuid, integer, text), place_equipment_hold(uuid, text, text, text), clear_equipment_hold(uuid, text) TO sv_rt;
  INSERT INTO organization (name) VALUES ('Race org');
  INSERT INTO facility (organization_id, name) SELECT id, 'F' FROM organization;
  INSERT INTO ward (organization_id, facility_id, name) SELECT organization_id, id, 'W' FROM facility;
  INSERT INTO location (organization_id, ward_id, external_key, name, kind) SELECT organization_id, id, 'room-1', 'Room', 'room' FROM ward;
  INSERT INTO equipment_type (organization_id, model_kind, name) SELECT id, 'supply-cart', 'Cart' FROM organization;
  INSERT INTO auth_user (id, issuer, subject) VALUES ('00000000-0000-4000-8000-0000000000a1', 'test', 'a'), ('00000000-0000-4000-8000-0000000000b1', 'test', 'b');
  INSERT INTO auth_membership (organization_id, user_id, role) SELECT o.id, u.id, 'operator' FROM organization o, auth_user u;`);
 ids={org:rows('SELECT id FROM organization')[0],a:'00000000-0000-4000-8000-0000000000a1',b:'00000000-0000-4000-8000-0000000000b1'};
});
after(()=>{if(skip)return;try{stopCluster(dir);}finally{rmSync(dir,{recursive:true,force:true});}});

function fresh(label){
 psql(url(),`
  INSERT INTO equipment (organization_id, external_id, name, equipment_type_id, location_id, status, provenance)
   SELECT id, '${label}', 'Cart ${label}', (SELECT id FROM equipment_type LIMIT 1), (SELECT id FROM location LIMIT 1), 'available', 'test' FROM organization;
  INSERT INTO request (organization_id, requested_by) SELECT id, 'user:${label}' FROM organization;
  INSERT INTO request_item (organization_id, request_id, line_no, equipment_type_id)
   SELECT r.organization_id, r.id, 1, (SELECT id FROM equipment_type LIMIT 1) FROM request r WHERE r.requested_by = 'user:${label}';`);
 return {eq:rows(`SELECT id FROM equipment WHERE external_id = '${label}'`)[0],req:rows(`SELECT id FROM request WHERE requested_by = 'user:${label}'`)[0]};
}
// first = the session that takes the asset lock and then waits at the gate; second = the session observed waiting on it.
async function overlap(label,{first,second}){
 const f=fresh(label),eq=f.eq;
 const gate=spawn(join(pgBin(),'psql'),[rt(),'-X','-q','-At'],{env:{...process.env,PGAPPNAME:'svGate'},stdio:['pipe','pipe','pipe']});
 let gateOut='';gate.stdout.on('data',d=>{gateOut+=d;});
 gate.stdin.write(`SELECT pg_advisory_lock(${GATE});\nSELECT 'gate-held';\n`);
 await until(()=>gateOut.includes('gate-held'),'the gate lock');
 const script=(which,user,app,final)=>`BEGIN;\n${ctx(user)}\n${which==='claim'?claimSql(f.req,eq):placeSql(eq,'dirty')}\n${final}`;
 const A=session('svA',script(first,first==='claim'?ids.a:ids.b,'svA',`SELECT pg_advisory_xact_lock(${GATE});\nCOMMIT;\n`));
 await until(()=>waiting('svA').some(w=>w.endsWith(':advisory')),'the first session to hold the asset and wait at the gate');
 const B=session('svB',script(second,second==='claim'?ids.a:ids.b,'svB','COMMIT;\n'));
 await until(()=>waiting('svB').length>0,'the second session to wait on the first');
 gate.stdin.end(`SELECT pg_advisory_unlock(${GATE});\n`);
 const [a,b]=await Promise.all([A,B]);
 return {a,b,eq,req:f.req};
}
const countActive=(eq,table)=>Number(rows(table==='hold'?`SELECT count(*) FROM equipment_hold WHERE active AND equipment_id = '${eq}'`:`SELECT count(*) FROM item_assignment WHERE active AND equipment_id = '${eq}'`)[0]);

test('hold placed first: a claim already waiting on the asset is refused once the hold commits',{skip},async()=>{
 const {a,b,eq}=await overlap('EQ-H1',{first:'place',second:'claim'});
 assert.equal(a.code,0,a.err);assert.match(a.out,/"placed": true/);
 assert.notEqual(b.code,0);assert.match(b.err,/sv:equipment_on_hold/);
 assert.equal(countActive(eq,'hold'),1);assert.equal(countActive(eq,'assignment'),0,'the asset was not assigned');
});
test('claim committed first: the hold that was waiting is placed afterwards and the claim stands',{skip},async()=>{
 const {a,b,eq}=await overlap('EQ-H2',{first:'claim',second:'place'});
 assert.equal(a.code,0,a.err);assert.match(a.out,/"replayed": false/);
 assert.equal(b.code,0,b.err);assert.match(b.out,/"placed": true/);
 assert.equal(countActive(eq,'assignment'),1,'the earlier claim is not undone');assert.equal(countActive(eq,'hold'),1);
});
test('an uncommitted hold does not block: if the holder rolls back, the waiting claim succeeds',{skip},async()=>{
 const f=fresh('EQ-H3');
 const gate=spawn(join(pgBin(),'psql'),[rt(),'-X','-q','-At'],{env:{...process.env,PGAPPNAME:'svGate'},stdio:['pipe','pipe','pipe']});
 let out='';gate.stdout.on('data',d=>{out+=d;});
 gate.stdin.write(`SELECT pg_advisory_lock(${GATE});\nSELECT 'gate-held';\n`);
 await until(()=>out.includes('gate-held'),'the gate lock');
 const A=session('svA',`BEGIN;\n${ctx(ids.b)}\n${placeSql(f.eq,'fault')}\nSELECT pg_advisory_xact_lock(${GATE});\nROLLBACK;\n`);
 await until(()=>waiting('svA').some(w=>w.endsWith(':advisory')),'the hold session at the gate');
 const B=session('svB',`BEGIN;\n${ctx(ids.a)}\n${claimSql(f.req,f.eq)}\nCOMMIT;\n`);
 await until(()=>waiting('svB').length>0,'the claim to wait on the hold session');
 gate.stdin.end(`SELECT pg_advisory_unlock(${GATE});\n`);
 const [a,b]=await Promise.all([A,B]);
 assert.equal(a.code,0,a.err);assert.equal(b.code,0,b.err);assert.match(b.out,/"replayed": false/);
 assert.equal(countActive(f.eq,'hold'),0);assert.equal(countActive(f.eq,'assignment'),1);
});
