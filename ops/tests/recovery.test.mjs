import test from 'node:test';
import assert from 'node:assert/strict';
import {loadRecoveryInventory, recoveryMigrations, recoveryTables, validateMigrationPaths} from '../recovery-inventory.mjs';
import {fixtureSetupSql, legacyEventSql} from '../recovery-fixture.mjs';
import {verifySnapshot} from '../recovery-integrity.mjs';

test('recovery inventory covers current repository migrations once and includes all additive tables', () => {
  const inventory = loadRecoveryInventory();
  assert.equal(inventory.migrations.length, 7);
  assert.equal(recoveryTables.length, 24);
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
    equipment: Array.from({length: 8}, (_, i) => row({id: `equipment-${i}`, external_id: `EQ-${i}`, equipment_type_id: 'type-0', version: 0})),
    auth_user: [{id: 'user'}], auth_membership: [row({user_id: 'user', role: 'operator'})],
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
  };
  return {tables, metadata: {rls: recoveryTables.map(table => ({table, enabled: true, forced: table !== 'auth_user', owner: 'existing_owner', acl: null})),
    indexes: ['item_assignment_one_active_per_equipment', 'item_assignment_one_active_per_item'].map(name => ({name, unique: true, valid: true})),
    functions: [{owner: 'existing_owner', acl: ['existing_owner=X/existing_owner'], securityDefiner: true, config: ['search_path=pg_catalog']}], policies: []}};
}
const verifyInternal = input => verifySnapshot(input, structuredClone(input));
test('complete synthetic graph yields deterministic data and metadata hashes', () => {
  const input = snapshot(), evidence = verifyInternal(input);
  assert.equal(evidence.tableCount, 24);
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
