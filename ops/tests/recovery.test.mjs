import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadRecoveryInventory, recoveryMigrations, recoveryTables, validateMigrationPaths} from '../recovery-inventory.mjs';
import {fixtureSetupSql, legacyEventSql} from '../recovery-fixture.mjs';
import {verifySnapshot} from '../recovery-integrity.mjs';
import {constraintDefinitionSql, constraintMetadataSql, columnMetadataSql} from '../recovery-schema.mjs';
import {checkRenderings} from './fixtures/check-renderings.mjs';

test('recovery inventory covers current repository migrations once and includes all additive tables', () => {
  const inventory = loadRecoveryInventory();
  assert.equal(inventory.migrations.length, 8);
  assert.equal(recoveryTables.length, 26);
  assert.ok(inventory.migrations.findIndex(m => m.id === 'holds') > inventory.migrations.findIndex(m => m.id === 'requests'));
  for (const migration of inventory.migrations) assert.match(migration.sha256, /^[a-f0-9]{64}$/);
  const paths = recoveryMigrations.map(migration => migration.path);
  for (const path of paths) assert.throws(() => validateMigrationPaths(paths.filter(candidate => candidate !== path)), /inventory differs/);
  assert.throws(() => validateMigrationPaths([...paths, paths[0]]), /inventory differs/);
  assert.throws(() => validateMigrationPaths([...paths, 'services/new/migrations/0002_new.up.sql']), /inventory differs/);
});
test('unchanged migration SQL uses dependency order and real legacy backfill without provisioning', () => {
  const inventory = loadRecoveryInventory(), sql = fixtureSetupSql(inventory);
  const positions = inventory.migrations.map(migration => sql.indexOf(migration.sql));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  for (const migration of inventory.migrations) assert.equal(sql.split(migration.sql).length - 1, 1);
  assert.ok(sql.indexOf(inventory.seedSql) > positions[0] && sql.indexOf(inventory.seedSql) < positions[1]);
  assert.ok(sql.indexOf(legacyEventSql) > positions[1] && sql.indexOf(legacyEventSql) < positions[2]);
  assert.doesNotMatch(sql, /^\s*(?:GRANT\b|CREATE\s+ROLE\b|ALTER\s+ROLE\b)/im);
});

function snapshot() {
  const row = fields => ({organization_id: 'tenant', ...fields});
  const tables = {
    organization: [{id: 'tenant'}], facility: [row({id: 'facility'})], ward: [row({id: 'ward'})],
    location: Array.from({length: 10}, (_, i) => row({id: `location-${i}`})),
    equipment_type: Array.from({length: 5}, (_, i) => row({id: `type-${i}`})),
    equipment: Array.from({length: 8}, (_, i) => row({id: `equipment-${i}`, external_id: `EQ-${i}`, equipment_type_id: 'type-0', version: 0, status: 'available'})),
    auth_user: [{id: 'user'}, {id: 'supply-clearer'}, {id: 'equipment-clearer'}],
    auth_membership: [row({user_id: 'user', role: 'operator', active: true}), row({user_id: 'supply-clearer', role: 'supply_manager', active: true}), row({user_id: 'equipment-clearer', role: 'equipment_manager', active: true})],
    equipment_observation: [row({id: 'observation', equipment_id: 'equipment-0', location_id: 'location-0', idempotency_key: 'reading', observed_at: '2026-11-05T10:00:00Z', received_at: '2026-11-05T10:01:00Z'})],
    equipment_event: [row({equipment_id: 'equipment-0', idempotency_key: 'admin:legacy'})],
    ingestion_nonce: [row({source_id: 'source', nonce: 'nonce'})],
    ingestion_receipt: [row({observation_id: 'observation', idempotency_key: 'reading', source_id: 'source', user_id: 'user', received_at: '2026-11-05T10:01:00Z'})],
    ingestion_dead_letter: [row({reason: 'replay'})],
    equipment_command_receipt: [row({equipment_id: 'equipment-0', idempotency_key: 'admin:legacy', legacy: true, actor_id: null, request: null, result: null}),
      row({equipment_id: 'equipment-0', legacy: false, actor_id: 'user', request: {expectedVersion: 0}, result: {record: {id: 'EQ-0', version: 0}, changed: false, replayed: false}})],
    supply_sku: [row({id: 'sku', unit: 'each'})], supply_bin: [row({id: 'bin', sku_id: 'sku', location_id: 'location-0'})],
    supply_bin_stock: [row({bin_id: 'bin', quantity: '12.250', version: 2})],
    supply_stock_transaction: [row({bin_id: 'bin', actor_id: 'user', quantity_before: '0.000', delta: '12.375', quantity_after: '12.375', expected_version: 0, version_after: 1}),
      row({bin_id: 'bin', actor_id: 'user', quantity_before: '12.375', delta: '-0.125', quantity_after: '12.250', expected_version: 1, version_after: 2})],
    request: [row({id: 'request'})], request_item: [row({id: 'item', request_id: 'request', state: 'assigned', equipment_type_id: 'type-0'})],
    item_assignment: [row({request_item_id: 'item', equipment_id: 'equipment-0', active: true, released_at: null})],
    request_event: [row({request_id: 'request', kind: 'request-created'}), row({request_id: 'request', request_item_id: 'item', equipment_id: 'equipment-0', kind: 'item-claimed'})],
    location_override: [row({id: 'override', equipment_id: 'equipment-0', location_id: 'location-1', observed_at: '2026-11-05T10:02:00Z', starts_at: '2026-11-05T10:03:00Z', expires_at: '2026-11-05T10:13:00Z'})],
    location_override_audit: [row({override_id: 'override', user_id: 'user', recorded_at: '2026-11-05T10:03:00Z',
      policy: {version: 'synthetic-v1', freshMs: 60000, staleMs: 600000, conflictWindowMs: 0, maxOverrideMs: 3600000},
      after_state: {locationId: 'location-1', observedAt: '2026-11-05T10:02:00Z', override: {id: 'override', organizationId: 'tenant', equipmentId: 'equipment-0', locationId: 'location-1'}}})],
    hold_clearance_rule: [row({kind: 'dirty', role: 'supply_manager'}), row({kind: 'fault', role: 'equipment_manager'})],
    equipment_hold: [row({id: 'cleared-hold', equipment_id: 'equipment-2', kind: 'dirty', placed_by: 'user:user', placed_at: '2026-11-05T10:00:00Z',
      active: false, cleared_by: 'user:supply-clearer', cleared_at: '2026-11-05T10:01:00Z'}),
      ...['dirty','fault','maintenance','unknown'].map(kind => row({id: `active-${kind}`, equipment_id: 'equipment-2', kind,
        placed_by: 'user:user', placed_at: '2026-11-05T10:02:00Z', active: true, cleared_by: null, cleared_at: null}))],
  };
  // Minimal catalog facts for logic tests; these are not a native schema capture.
  const columns = recoveryTables.map(table => ({schema:'public',table,name:Object.keys(tables[table][0])[0],position:1,type:'text',notNull:true}));
  columns.push({schema:'public',table:'equipment_command_receipt',name:'idempotency_key',position:2,type:'text',notNull:true},
    {schema:'public',table:'equipment_command_receipt',name:'equipment_id',position:3,type:'uuid',notNull:true},
    {schema:'public',table:'equipment',name:'id',position:2,type:'uuid',notNull:true});
  const check = {schema:'public',table:'equipment_command_receipt',name:'equipment_command_receipt_idempotency_key_check',type:'c',
    definition:checkRenderings.pretty,enforcementAvailable:true,enforced:true,validated:true,deferrable:false,deferred:false,
    isLocal:true,inheritanceCount:0,noInherit:false,parent:null,columns:['idempotency_key'],referencedSchema:null,referencedTable:null,referencedColumns:[]};
  const constraints = [check,
    {...check,table:'equipment',name:'equipment_pkey',type:'p',definition:'PRIMARY KEY (id)',columns:['id']},
    {...check,name:'receipt_equipment_fk',type:'f',definition:'FOREIGN KEY (equipment_id) REFERENCES equipment(id)',columns:['equipment_id'],referencedSchema:'public',referencedTable:'equipment',referencedColumns:['id']}];
  return {tables, metadata: {constraints,columns,rls: recoveryTables.map(table => ({table, enabled: true, forced: table !== 'auth_user', owner: 'existing_owner', acl: null})),
    indexes: ['item_assignment_one_active_per_equipment', 'item_assignment_one_active_per_item', 'equipment_hold_one_active_per_kind'].map(name => ({name, unique: true, valid: true})),
    triggers: [{table: 'item_assignment', name: 'item_assignment_block_on_hold', enabled: 'O', definition: 'EXECUTE FUNCTION block_assignment_on_hold()'},
      {table: 'equipment_hold', name: 'equipment_hold_guard_trigger', enabled: 'O', definition: 'EXECUTE FUNCTION equipment_hold_guard()'}],
    functions: [{owner: 'existing_owner', acl: ['existing_owner=X/existing_owner'], securityDefiner: true, config: ['search_path=pg_catalog']}], policies: []}};
}
const verifyInternal = input => verifySnapshot(input, structuredClone(input));
test('complete synthetic graph yields deterministic data and metadata hashes', () => {
  const input = snapshot(), evidence = verifyInternal(input);
  assert.equal(evidence.tableCount, 26);
  assert.match(evidence.dataSha256, /^[a-f0-9]{64}$/);
  assert.equal(evidence.metadataSha256, verifyInternal(structuredClone(input)).metadataSha256);
});
test('matching incomplete source and restore snapshots cannot pass omitted additive tables or empty evidence', () => {
  for (const migration of recoveryMigrations.slice(2)) for (const name of migration.tables) {
    const missing = snapshot(); delete missing.tables[name];
    assert.throws(() => verifyInternal(missing), /inventory/);
    const empty = snapshot(); empty.tables[name] = [];
    assert.throws(() => verifyInternal(empty), /Missing synthetic evidence/);
  }
});
test('restored equal-count row corruption and function/index security changes fail comparison', () => {
  const before = snapshot();
  for (const corrupt of [
    after => { after.tables.equipment_command_receipt[1].result.record.id = 'other'; },
    after => { after.tables.location_override_audit[0].policy.version = 'changed'; },
    after => { after.metadata.functions[0].acl = ['=X/owner']; },
    after => { after.metadata.indexes[0].unique = false; },
  ]) {
    const after = structuredClone(before); corrupt(after);
    assert.throws(() => verifySnapshot(before, after), /differs/);
  }
});
test('broken command replay/legacy links fail even if both snapshots contain the same corruption', () => {
  for (const corrupt of [
    input => { input.tables.equipment_command_receipt[0].idempotency_key = 'lost'; },
    input => { input.tables.equipment_command_receipt[0].result = {}; },
    input => { input.tables.equipment_command_receipt[1].actor_id = 'other'; },
    input => { input.tables.equipment_command_receipt[1].result.record.version = 3; },
  ]) { const input = snapshot(); corrupt(input); assert.throws(() => verifyInternal(input), /Legacy command|Command receipt/); }
});
test('stock projection must reconcile exact fractional quantities, versions and immutable actor links', () => {
  for (const corrupt of [
    input => { input.tables.supply_bin_stock[0].quantity = '12.251'; },
    input => { input.tables.supply_stock_transaction[1].quantity_before = '12.374'; },
    input => { input.tables.supply_stock_transaction[1].version_after = 3; },
    input => { input.tables.supply_stock_transaction[1].actor_id = 'other'; },
  ]) { const input = snapshot(); corrupt(input); assert.throws(() => verifyInternal(input), /Stock/); }
});
test('assignment, override partner, expiry, policy and tenant integrity fail closed', () => {
  for (const corrupt of [
    input => { input.tables.item_assignment[0].request_item_id = 'missing'; },
    input => { input.tables.request_event[1].equipment_id = 'other'; },
    input => { input.tables.location_override_audit[0].override_id = 'missing'; },
    input => { input.tables.location_override[0].expires_at = input.tables.location_override[0].starts_at; },
    input => { input.tables.location_override_audit[0].policy.maxOverrideMs = 100; },
    input => { input.tables.location_override_audit[0].after_state.observedAt = '2026-11-05T10:03:00Z'; },
    input => { input.tables.location_override[0].organization_id = 'other'; },
  ]) { const input = snapshot(); corrupt(input); assert.throws(() => verifyInternal(input)); }
});
test('physical observation time remains distinct and source security/index metadata cannot be absent', () => {
  const time = snapshot(); time.tables.equipment_observation[0].observed_at = time.tables.equipment_observation[0].received_at;
  assert.throws(() => verifyInternal(time), /distinct/);
  const rls = snapshot(); rls.metadata.rls.find(row => row.table === 'location_override').forced = false;
  assert.throws(() => verifyInternal(rls), /RLS/);
  const index = snapshot(); index.metadata.indexes.pop();
  assert.throws(() => verifyInternal(index), /unique index/);
});
test('hold stacks retain clearance history, configured-role evidence and separate blocking state', () => {
  for (const corrupt of [
    input => { input.tables.equipment_hold[0].cleared_by = 'user:user'; },
    input => { input.tables.hold_clearance_rule[0].role = 'admin'; },
    input => { input.tables.auth_membership[1].active = false; },
    input => { input.tables.equipment_hold[0].cleared_at = '2026-11-05T09:59:00Z'; },
    input => { input.tables.equipment_hold[1].cleared_by = 'user:supply-clearer'; },
    input => { input.tables.equipment_hold[2].kind = 'dirty'; },
    input => { input.tables.equipment_hold[1].equipment_id = 'missing'; },
    input => { input.tables.equipment_hold[0].kind = 'unknown'; },
    input => { input.tables.equipment_hold[1].placed_at = '2026-11-05T10:00:30Z'; },
  ]) { const input = snapshot(); corrupt(input); assert.throws(() => verifyInternal(input)); }
});
test('hold RLS, history trigger, assignment trigger and active-kind index cannot be missing on both sides', () => {
  for (const corrupt of [
    input => { input.metadata.rls.find(row => row.table === 'equipment_hold').forced = false; },
    input => { input.metadata.rls.find(row => row.table === 'hold_clearance_rule').enabled = false; },
    input => { input.metadata.indexes = input.metadata.indexes.filter(row => row.name !== 'equipment_hold_one_active_per_kind'); },
    input => { input.metadata.triggers.find(row => row.table === 'item_assignment').enabled = 'D'; },
    input => { input.metadata.triggers.find(row => row.table === 'equipment_hold').definition = 'unprotected'; },
  ]) { const input = snapshot(); corrupt(input); assert.throws(() => verifyInternal(input)); }
});

test('public CHECK fixtures reproduce all isolated PostgreSQL 18.6 renderer fingerprints', () => {
  const expected = {
    original:'40db3d04079639d4f7a253603326d0e3c65a83d4b79447926a6e59c603be6917',
    reparsed:'83fb2793046e743b5e910fd084bb4a9079b3f94d82aa6d1bd5d8b4f4bfae31ab',
    pretty:'a0c79a9d6a5107f31144e525cbac56be98a8a9d0643287aad8e97ca4c88cc186',
    precedenceAnd:'64038ea7f92db38fde6829f6c8a9fe507d9472d90c5cb507bacdf0af8854e29e',
    precedenceOr:'e1e1597baa0761413558df0b772c2819060e8506b1b0dfe75051592a2482eeb1',
  };
  for (const [name,value] of Object.entries(checkRenderings)) {
    assert.equal(createHash('sha256').update(JSON.stringify(value)).digest('hex'), expected[name], name);
  }
});

test('SQL uses the PostgreSQL pretty renderer only for CHECK and safely captures older catalogs', () => {
  assert.equal(constraintDefinitionSql, `CASE WHEN k.contype = 'c'
  THEN pg_get_constraintdef(k.oid, true) ELSE pg_get_constraintdef(k.oid) END`);
  assert.ok(constraintMetadataSql.includes(constraintDefinitionSql));
  assert.ok(constraintMetadataSql.includes("'enforcementAvailable',to_jsonb(k) ? 'conenforced','enforced',to_jsonb(k)->'conenforced'"));
  assert.doesNotMatch(constraintMetadataSql, /\bk\.conenforced\b/);
  assert.ok(columnMetadataSql.includes("'notNull',a.attnotnull"));
  assert.ok(columnMetadataSql.includes('NOT a.attisdropped'));
});

test('captured server-rendered same-AND pair has stable strict snapshots without JavaScript normalization', () => {
  const before = snapshot(), after = structuredClone(before);
  assert.notEqual(checkRenderings.original,checkRenderings.reparsed);
  // Both observed server pretty outputs have the same verified fingerprint above.
  before.metadata.constraints[0].definition = checkRenderings.pretty;
  after.metadata.constraints[0].definition = checkRenderings.pretty;
  assert.equal(verifySnapshot(before,after).metadataSha256,verifyInternal(before).metadataSha256);
  before.metadata.constraints[0].definition = checkRenderings.original;
  after.metadata.constraints[0].definition = checkRenderings.reparsed;
  assert.throws(()=>verifySnapshot(before,after), /differs/);
});

test('bounds, prefix, equality/operator and AND/OR precedence changes remain strict failures', () => {
  const before = snapshot();
  for (const definition of [checkRenderings.pretty.replace('>= 7','>= 6'),
    checkRenderings.pretty.replace('<= 106','<= 107'),checkRenderings.pretty.replace("'admin:'","'other:'"),
    checkRenderings.pretty.replace(" = 'admin:'"," <> 'admin:'"),
    checkRenderings.pretty.replace(' AND ',' OR '),checkRenderings.precedenceAnd,checkRenderings.precedenceOr]) {
    const after = structuredClone(before); after.metadata.constraints[0].definition = definition;
    assert.throws(()=>verifySnapshot(before,after),/differs/);
  }
  const orBefore = snapshot(); orBefore.metadata.constraints[0].definition=checkRenderings.precedenceOr;
  const andAfter = structuredClone(orBefore); andAfter.metadata.constraints[0].definition=checkRenderings.precedenceAnd;
  assert.throws(()=>verifySnapshot(orBefore,andAfter),/differs/);
});

test('non-CHECK definitions preserve strict default spelling as well as relational semantics', () => {
  const before = snapshot();
  for (const [index,definition] of [[1,'PRIMARY KEY  (id)'],[1,'UNIQUE (id)'],
    [2,'FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE']]) {
    const after = structuredClone(before); after.metadata.constraints[index].definition=definition;
    assert.throws(()=>verifySnapshot(before,after),/differs/);
  }
});

test('constraint identity, enforcement, validation, inheritance, deferral and column drift fail comparison', () => {
  const before=snapshot();
  const changes=[
    after=>{after.metadata.constraints[0].schema='other';},after=>{after.metadata.constraints[0].table='equipment';},
    after=>{after.metadata.constraints[0].name='renamed';},after=>{after.metadata.constraints[0].type='u';},
    after=>{after.metadata.constraints[0].enforced=false;},after=>{after.metadata.constraints[0].enforcementAvailable=false;},
    after=>{after.metadata.constraints[0].validated=false;},after=>{after.metadata.constraints[0].deferrable=true;},
    after=>{after.metadata.constraints[0].deferred=true;},after=>{after.metadata.constraints[0].isLocal=false;},
    after=>{after.metadata.constraints[0].inheritanceCount=1;},after=>{after.metadata.constraints[0].noInherit=true;},
    after=>{after.metadata.constraints[0].parent={schema:'public',table:'equipment',name:'equipment_pkey'};},
    after=>{after.metadata.constraints[0].columns=['equipment_id'];},
    after=>{after.metadata.constraints[2].referencedSchema='other';},
    after=>{after.metadata.constraints[2].referencedTable='request';},
    after=>{after.metadata.constraints[2].referencedColumns=['external_id'];},
    after=>{after.metadata.columns.find(column=>column.name==='idempotency_key').notNull=false;},
    after=>{after.metadata.columns.find(column=>column.name==='idempotency_key').type='character varying(106)';},
    after=>{after.metadata.columns.find(column=>column.name==='idempotency_key').position=4;},
  ];
  for(const change of changes){const after=structuredClone(before);change(after);assert.throws(()=>verifySnapshot(before,after),/differs/);}
});

test('PostgreSQL 16/17 enforcement absence is explicit and cannot disguise disabled or missing flags', () => {
  const older=snapshot();
  for(const constraint of older.metadata.constraints){constraint.enforcementAvailable=false;constraint.enforced=null;}
  assert.equal(verifyInternal(older).tableCount,26);
  for(const change of [input=>{input.metadata.constraints[0].enforced=true;},
    input=>{delete input.metadata.constraints[0].enforcementAvailable;},
    input=>{delete input.metadata.constraints[0].enforced;}]) {
    const invalid=structuredClone(older);change(invalid);assert.throws(()=>verifyInternal(invalid),/constraint\/column metadata/);
  }
});

test('matching incomplete or disabled source catalog evidence fails before archiving', () => {
  for(const change of [input=>{input.metadata.constraints=[];},input=>{input.metadata.columns=[];},
    input=>{input.metadata.constraints[0].enforced=false;},input=>{input.metadata.constraints[0].validated=false;},
    input=>{input.metadata.constraints[0].columns=[];},input=>{input.metadata.constraints[1].columns=[];},
    input=>{input.metadata.constraints[2].referencedColumns=['missing'];},
    input=>{input.metadata.constraints[0].parent={schema:'public',table:'equipment',name:'missing'};},
    input=>{input.metadata.constraints.push(structuredClone(input.metadata.constraints[0]));},
    input=>{input.metadata.columns.push(structuredClone(input.metadata.columns[0]));},
    input=>{input.metadata.columns=input.metadata.columns.filter(column=>column.table!=='organization');},
    input=>{input.metadata.columns.find(column=>column.name==='idempotency_key').notNull=false;}]) {
    const invalid=snapshot();change(invalid);assert.throws(()=>verifyInternal(invalid),/constraint\/column metadata/);
  }
});

test('CHECK rendering never exempts RLS, policy, trigger, index, function or data changes', () => {
  const before=snapshot();
  for(const change of [after=>{after.metadata.rls[0].forced=false;},
    after=>{after.metadata.policies.push({qual:'true'});},after=>{after.metadata.triggers[0].enabled='D';},
    after=>{after.metadata.triggers[0].definition='different';},after=>{after.metadata.indexes[0].definition='different';},
    after=>{after.metadata.indexes[0].unique=false;},after=>{after.metadata.functions[0].securityDefiner=false;},
    after=>{after.metadata.functions[0].config=['search_path=public'];},after=>{after.metadata.functions[0].definition='different';},
    after=>{after.tables.equipment[0].status='dirty';}]) {
    const after=structuredClone(before);change(after);assert.throws(()=>verifySnapshot(before,after),/differs/);
  }
});
