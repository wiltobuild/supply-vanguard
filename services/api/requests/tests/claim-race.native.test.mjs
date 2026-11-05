import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pgBin,startCluster,stopCluster,createDatabase,psql,migrateUp} from '../../db/lib.mjs';

// Real PostgreSQL, real separate sessions (one psql process each), and a fixed interleaving built from locks, not sleeps:
//   C holds an advisory lock; A claims the asset, then waits on that lock while holding the asset's row lock;
//   B starts its claim and is observed waiting on A; then C lets A finish. Skips when PostgreSQL is not installed.
const skip=pgBin()?false:'PostgreSQL not installed (brew install postgresql@16); native claim-race test skipped';
const file=rel=>fileURLToPath(new URL(rel,import.meta.url));
const dir=skip?null:mkdtempSync(join(tmpdir(),'sv-race-'));
const GATE=777;
let admin,url,port,ids;

const rows=sql=>psql(url,sql).split('\n').filter(Boolean);
function session(app,script){
 const child=spawn(join(pgBin(),'psql'),[`postgresql://sv_rt@127.0.0.1:${port}/race`,'-X','-q','-v','ON_ERROR_STOP=1','-At'],{env:{...process.env,PGAPPNAME:app},stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
 const done=new Promise(resolve=>child.on('close',code=>resolve({code,out:out.trim(),err:err.trim()})));
 child.stdin.end(script);
 return done;
}
async function until(check,what,ms=20000){
 const end=Date.now()+ms;
 while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,25));}
 throw new Error(`timed out waiting for ${what}`);
}
const waiting=app=>rows(`SELECT wait_event_type || ':' || wait_event FROM pg_stat_activity WHERE application_name = '${app}' AND wait_event_type = 'Lock'`);
const ctx=user=>`SELECT set_config('sv.user_id', '${user}', true), set_config('sv.organization_id', '${ids.org}', true);`;
const claim=(req,actor)=>`SELECT public.claim_request_item('${req}', 1, '${ids.eq}', 0, '${actor}');`;

before(()=>{
 if(skip)return;
 port=54700+Math.floor(Math.random()*200);
 admin=startCluster(dir,port);url=createDatabase(admin,'race');
 migrateUp(url);
 psql(url,'',{file:file('../../auth/migrations/0001_auth.up.sql')});
 psql(url,'',{file:file('../migrations/0001_requests.up.sql')});
 psql(url,`
  CREATE ROLE sv_rt NOSUPERUSER NOBYPASSRLS LOGIN;
  GRANT USAGE ON SCHEMA public TO sv_rt;
  GRANT SELECT, INSERT, UPDATE, DELETE ON organization, facility, ward, location, equipment_type, equipment, equipment_observation, equipment_event, request, request_item, item_assignment, request_event TO sv_rt;
  GRANT SELECT ON auth_user, auth_membership TO sv_rt;
  GRANT EXECUTE ON FUNCTION auth_resolve_identity(text, text), claim_request_item(uuid, integer, uuid, integer, text) TO sv_rt;
  INSERT INTO organization (name) VALUES ('Race org');
  INSERT INTO facility (organization_id, name) SELECT id, 'F' FROM organization;
  INSERT INTO ward (organization_id, facility_id, name) SELECT organization_id, id, 'W' FROM facility;
  INSERT INTO location (organization_id, ward_id, external_key, name, kind) SELECT organization_id, id, 'room-1', 'Room', 'room' FROM ward;
  INSERT INTO equipment_type (organization_id, model_kind, name) SELECT id, 'supply-cart', 'Cart' FROM organization;
  INSERT INTO auth_user (id, issuer, subject) VALUES ('00000000-0000-4000-8000-0000000000a1', 'test', 'a'), ('00000000-0000-4000-8000-0000000000b1', 'test', 'b');
  INSERT INTO auth_membership (organization_id, user_id, role) SELECT o.id, u.id, 'operator' FROM organization o, auth_user u;`);
 ids={org:rows('SELECT id FROM organization')[0],A:'00000000-0000-4000-8000-0000000000a1',B:'00000000-0000-4000-8000-0000000000b1'};
});
after(()=>{if(skip)return;try{stopCluster(dir);}finally{rmSync(dir,{recursive:true,force:true});}});

function fresh(label){
 // A new asset and two requests (one item each, same equipment type) per scenario, so scenarios do not interfere.
 const sql=`
  INSERT INTO equipment (organization_id, external_id, name, equipment_type_id, location_id, status, provenance)
   SELECT id, '${label}', 'Cart ${label}', (SELECT id FROM equipment_type LIMIT 1), (SELECT id FROM location LIMIT 1), 'available', 'test' FROM organization;
  INSERT INTO request (organization_id, requested_by) SELECT id, 'user:a' FROM organization;
  INSERT INTO request (organization_id, requested_by) SELECT id, 'user:b' FROM organization;
  INSERT INTO request_item (organization_id, request_id, line_no, equipment_type_id)
   SELECT r.organization_id, r.id, 1, (SELECT id FROM equipment_type LIMIT 1) FROM request r WHERE NOT EXISTS (SELECT 1 FROM request_item i WHERE i.request_id = r.id);`;
 psql(url,sql);
 ids.eq=rows(`SELECT id FROM equipment WHERE external_id = '${label}'`)[0];
 const reqs=rows(`SELECT r.id FROM request r WHERE requested_by = 'user:a' ORDER BY created_at DESC, id LIMIT 1`).concat(rows(`SELECT r.id FROM request r WHERE requested_by = 'user:b' ORDER BY created_at DESC, id LIMIT 1`));
 return {A:reqs[0],B:reqs[1]};
}
async function race(label,aFinish){
 const req=fresh(label);
 const gate=spawn(join(pgBin(),'psql'),[`postgresql://sv_rt@127.0.0.1:${port}/race`,'-X','-q','-At'],{env:{...process.env,PGAPPNAME:'svGate'},stdio:['pipe','pipe','pipe']});
 let gateOut='';gate.stdout.on('data',d=>{gateOut+=d;});
 gate.stdin.write(`SELECT pg_advisory_lock(${GATE});\nSELECT 'gate-held';\n`);
 await until(()=>gateOut.includes('gate-held'),'the gate lock');
 const A=session('svA',`BEGIN;\n${ctx(ids.A)}\n${claim(req.A,'user:a')}\nSELECT pg_advisory_xact_lock(${GATE});\n${aFinish};\n`);
 await until(()=>waiting('svA').some(w=>w.endsWith(':advisory')),'A to hold the asset and wait at the gate');
 const B=session('svB',`BEGIN;\n${ctx(ids.B)}\n${claim(req.B,'user:b')}\nCOMMIT;\n`);
 await until(()=>waiting('svB').length>0,'B to wait on A');
 gate.stdin.end(`SELECT pg_advisory_unlock(${GATE});\n`);
 const [a,b]=await Promise.all([A,B]);
 return {a,b,req};
}
const active=()=>Number(rows(`SELECT count(*) FROM item_assignment WHERE active AND equipment_id = '${ids.eq}'`)[0]);

test('two real sessions claim the same asset: A holds it, B waits, exactly one wins',{skip},async()=>{
 const {a,b,req}=await race('EQ-N1','COMMIT');
 assert.equal(a.code,0,a.err);assert.match(a.out,/"replayed": false/);
 assert.notEqual(b.code,0);assert.match(b.err,/sv:equipment_already_assigned/);
 assert.equal(active(),1);
 assert.deepEqual(rows(`SELECT i.request_id FROM item_assignment a JOIN request_item i ON i.id = a.request_item_id WHERE a.active AND a.equipment_id = '${ids.eq}'`),[req.A]);
 assert.equal(Number(rows(`SELECT count(*) FROM request_event WHERE kind = 'item-claimed' AND equipment_id = '${ids.eq}'`)[0]),1);
 assert.deepEqual(rows(`SELECT state FROM request_item WHERE request_id = '${req.B}'`),['open'],'the loser stays open for reconciliation');
});
test('if the first claimant rolls back, the waiting session gets the asset: still exactly one winner',{skip},async()=>{
 const {a,b,req}=await race('EQ-N2','ROLLBACK');
 assert.equal(a.code,0,a.err);
 assert.equal(b.code,0,b.err);assert.match(b.out,/"replayed": false/);
 assert.equal(active(),1);
 assert.deepEqual(rows(`SELECT i.request_id FROM item_assignment a JOIN request_item i ON i.id = a.request_item_id WHERE a.active AND a.equipment_id = '${ids.eq}'`),[req.B]);
 assert.deepEqual(rows(`SELECT state FROM request_item WHERE request_id = '${req.A}'`),['open']);
});
test('a stale asset version loses even without a competing claim in flight',{skip},async()=>{
 const req=fresh('EQ-N3');
 psql(url,`UPDATE equipment SET status = 'cleaning', version = version + 1 WHERE id = '${ids.eq}'; UPDATE equipment SET status = 'available', version = version + 1 WHERE id = '${ids.eq}';`);
 const stale=await session('svS',`BEGIN;\n${ctx(ids.A)}\n${claim(req.A,'user:a')}\nCOMMIT;\n`);
 assert.notEqual(stale.code,0);assert.match(stale.err,/sv:stale_version/);
 assert.equal(active(),0);
});
