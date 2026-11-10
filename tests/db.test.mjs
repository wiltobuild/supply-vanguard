import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {pgBin,startCluster,stopCluster,createDatabase,psql,migrateUp,migrateDown,applied,seed,bootstrap} from '../services/api/db/lib.mjs';
// Needs PostgreSQL 16+ on the machine. Without it these tests are skipped, not passed silently: see the skip message.
const skip=pgBin()?false:'PostgreSQL not installed (brew install postgresql@16); database tests skipped';
const dir=skip?null:mkdtempSync(join(tmpdir(),'sv-db-test-'));
let admin,url;
const q=sql=>psql(url,sql),fails=(sql,pattern)=>assert.throws(()=>q(sql),pattern,sql);
const ORG="(SELECT id FROM organization WHERE name LIKE 'Demo%')";
const LOC=k=>`(SELECT id FROM location WHERE organization_id = ${ORG} AND external_key = '${k}')`;
const EQ=ext=>`(SELECT id FROM equipment WHERE organization_id = ${ORG} AND external_id = '${ext}')`;
const TYPE=k=>`(SELECT id FROM equipment_type WHERE organization_id = ${ORG} AND model_kind = '${k}')`;
test('setup: throwaway cluster, migrations apply once and are repeatable',{skip},()=>{
 admin=startCluster(dir,54000+Math.floor(Math.random()*900));
 url=createDatabase(admin,'sv_test');
 assert.deepEqual(migrateUp(url),['0001_core']);
 assert.deepEqual(migrateUp(url),[]);
 assert.deepEqual(applied(url),['0001_core']);
 seed(url);
 assert.equal(q('SELECT count(*) FROM equipment'),'8');
 assert.equal(q('SELECT count(*) FROM location'),'10');
});
test('rows cannot reference another tenant',{skip},()=>{
 q("INSERT INTO organization (name) VALUES ('Other org')");
 q("INSERT INTO facility (organization_id, name) SELECT id, 'F2' FROM organization WHERE name = 'Other org'");
 q("INSERT INTO ward (organization_id, facility_id, name) SELECT organization_id, id, 'W2' FROM facility WHERE name = 'F2'");
 q("INSERT INTO location (organization_id, ward_id, external_key, name, kind) SELECT organization_id, id, 'other-room', 'Other room', 'room' FROM ward WHERE name = 'W2'");
 fails(`INSERT INTO equipment (organization_id, external_id, name, equipment_type_id, location_id, status, provenance)
  VALUES (${ORG}, 'EQ-X', 'Leak', ${TYPE('monitor')}, (SELECT id FROM location WHERE external_key = 'other-room'), 'available', 'test')`,/foreign key/);
 fails(`INSERT INTO location (organization_id, ward_id, external_key, name, kind) VALUES (${ORG}, (SELECT id FROM ward WHERE name = 'W2'), 'x', 'X', 'room')`,/foreign key/);
 // The same external key is allowed in a different tenant, but not twice inside one.
 q(`INSERT INTO location (organization_id, ward_id, external_key, name, kind) SELECT organization_id, id, 'room-101', 'Same key, other tenant', 'room' FROM ward WHERE name = 'W2'`);
 fails(`INSERT INTO location (organization_id, ward_id, external_key, name, kind) VALUES (${ORG}, (SELECT id FROM ward WHERE organization_id = ${ORG}), 'room-101', 'Dup', 'room')`,/unique|duplicate/);
});
test('column constraints reject bad values',{skip},()=>{
 const ins=(cols)=>`INSERT INTO equipment (organization_id, external_id, name, equipment_type_id, location_id, status, provenance${cols.c||''})
  VALUES (${ORG}, '${cols.id||'EQ-N'}', 'N', ${TYPE('monitor')}, ${LOC('room-101')}, '${cols.status||'available'}', 'test'${cols.v||''})`;
 q(ins({id:'EQ-OK'}));
 fails(ins({id:'EQ-OK'}),/unique|duplicate/);
 fails(ins({id:'EQ-B1',status:'broken'}),/check/);
 fails(ins({id:'EQ-B2',c:', version',v:', -1'}),/check/);
 fails(ins({id:'EQ-B3',c:', note',v:`, '${'x'.repeat(501)}'`}),/check/);
 fails(ins({id:'EQ-B4',c:', last_verified_at',v:', now()'}),/check/);
});
test('observations and events: validated, idempotent and append-only',{skip},()=>{
 const obs=(key,o='now()',r='now()')=>`INSERT INTO equipment_observation (organization_id, equipment_id, location_id, observed_at, received_at, source, actor, idempotency_key)
  VALUES (${ORG}, ${EQ('EQ-001')}, ${LOC('room-101')}, ${o}, ${r}, 'barcode', 'tester', '${key}')`;
 q(obs('k1'));
 fails(obs('k1'),/unique|duplicate/);
 fails(obs('k2',"now() + interval '1 hour'"),/check/);
 fails(`UPDATE equipment_observation SET actor = 'someone else'`,/append-only/);
 fails('DELETE FROM equipment_observation',/append-only/);
 q(`INSERT INTO equipment_event (organization_id, equipment_id, kind, actor, source, idempotency_key, after_state) VALUES (${ORG}, ${EQ('EQ-001')}, 'admin', 't', 'admin', 'e1', '{}')`);
 fails(`INSERT INTO equipment_event (organization_id, equipment_id, kind, actor, source, idempotency_key, after_state) VALUES (${ORG}, ${EQ('EQ-001')}, 'admin', 't', 'admin', 'e1', '{}')`,/unique|duplicate/);
 fails(`UPDATE equipment_event SET actor = 'x'`,/append-only/);
 fails('DELETE FROM equipment_event',/append-only/);
});
test('equipment guard: versioned edits, allowed transitions, retired is final, location confidence separate',{skip},()=>{
 const set=(ext,sets)=>`UPDATE equipment SET ${sets} WHERE organization_id = ${ORG} AND external_id = '${ext}'`;
 fails(set('EQ-001',"status = 'cleaning'"),/increase version by one/);
 fails(set('EQ-001',"status = 'cleaning', version = 5"),/increase version by one/);
 q(set('EQ-001',"status = 'cleaning', version = version + 1, last_admin_edit_at = now()"));
 assert.equal(q(`SELECT status, version, last_verified_at IS NULL FROM equipment WHERE id = ${EQ('EQ-001')}`),'cleaning|1|t');
 fails(set('EQ-002',"status = 'available', version = version + 1"),/not allowed/);
 fails(set('EQ-001',"version = version + 1"),/version only changes/);
 q(set('EQ-001',`last_verified_location_id = ${LOC('room-101')}, last_verified_at = now(), last_verified_source = 'barcode', location_id = ${LOC('room-101')}`));
 assert.equal(q(`SELECT version FROM equipment WHERE id = ${EQ('EQ-001')}`),'1');
 fails(set('EQ-001',"last_verified_at = now() - interval '1 day'"),/backward/);
 q(set('EQ-001',"status = 'retired', version = version + 1"));
 fails(set('EQ-001',"status = 'available', version = version + 1"),/retired/);
 fails(set('EQ-001',"note = 'x', version = version + 1"),/retired/);
 fails(set('EQ-003',"external_id = 'EQ-RENAMED'"),/identity/);
});
// SV-019. Native PostgreSQL only (skipped without it; the embedded PGlite auth tests do not cover bootstrap).
// The superuser used above bypasses row-level security, so this uses a NON-superuser table owner, the case that used to fail.
test('owner bootstrap: seeds under forced RLS, is atomic and idempotent, and leaves RLS enforced',{skip},()=>{
 q("CREATE ROLE sv_owner LOGIN NOSUPERUSER");
 q("CREATE ROLE sv_runtime LOGIN NOSUPERUSER");
 q("CREATE DATABASE sv_boot OWNER sv_owner");
 const owner=admin.replace(/\/[^/]*$/,'/sv_boot').replace('sv@','sv_owner@'),runtime=owner.replace('sv_owner@','sv_runtime@');
 const as=(u,sql)=>psql(u,sql),forced=()=>as(admin.replace(/\/[^/]*$/,'/sv_boot'),"SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity");
 assert.deepEqual(migrateUp(owner),['0001_core']);
 as(owner,readFileSync(new URL('../services/api/auth/migrations/0001_auth.up.sql',import.meta.url),'utf8'));
 const before=forced();
 assert.match(before,/organization/);
 // A plain seed fails: no policy lets anyone create the first organization.
 assert.throws(()=>as(owner,readFileSync(new URL('../services/api/db/seed/seed.sql',import.meta.url),'utf8')),/row-level security/);
 // A failure inside the bootstrap transaction loads nothing and restores FORCE exactly.
 assert.throws(()=>bootstrap(owner,"INSERT INTO organization (name) VALUES ('Half loaded'); SELECT 1/0;"),/division by zero/);
 assert.equal(forced(),before);
 assert.equal(as(admin.replace(/\/[^/]*$/,'/sv_boot'),'SELECT count(*) FROM organization'),'0');
 // A role that does not own the tables cannot bootstrap.
 as(admin.replace(/\/[^/]*$/,'/sv_boot'),'GRANT ALL ON ALL TABLES IN SCHEMA public TO sv_runtime');
 assert.throws(()=>seed(runtime),/must be owner|permission denied/);
 // The real seed succeeds, twice, and RLS is enforced afterwards.
 seed(owner);seed(owner);
 const su=admin.replace(/\/[^/]*$/,'/sv_boot');
 assert.equal(as(su,'SELECT count(*) FROM organization'),'1');
 assert.equal(as(su,'SELECT count(*) FROM equipment'),'8');
 assert.equal(forced(),before);
 assert.equal(as(owner,'SELECT count(*) FROM equipment'),'0');   // even the owner sees nothing without a tenant context
 assert.throws(()=>as(owner,"INSERT INTO organization (name) VALUES ('Sneaky')"),/row-level security/);
 assert.throws(()=>as(runtime,"INSERT INTO organization (name) VALUES ('Sneaky')"),/row-level security|permission denied/);
});
test('rollback removes the schema and reapplying restores it; cleanup',{skip},()=>{
 assert.deepEqual(migrateDown(url,1),['0001_core']);
 assert.equal(q("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'schema_migrations'"),'0');
 assert.deepEqual(migrateUp(url),['0001_core']);
 seed(url);assert.equal(q('SELECT count(*) FROM equipment'),'8');
 stopCluster(dir);rmSync(dir,{recursive:true,force:true});
});
