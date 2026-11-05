import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectEnvironment} from '../environment.mjs';
import {evaluateTelemetry} from '../monitor.mjs';
import {archiveCleanupTarget, drillConfig, findTools, verifySnapshot} from '../recovery-drill.mjs';

const sample = () => JSON.parse(readFileSync(new URL('../examples/telemetry.synthetic.json', import.meta.url)));
const now = Date.parse('2026-11-05T00:00:30.000Z');
test('demo prerequisites do not certify integration; missing packages fail explicitly', () => {
  assert.equal(inspectEnvironment({nodeVersion: '20.0.0'}).ready, false);
  assert.equal(inspectEnvironment({nodeVersion: '22.0.0'}).ready, true);
  const result = inspectEnvironment({profile: 'integration', resolvePackage() { throw Error('not installed'); }});
  assert.equal(result.ready, false);
  assert.equal(result.checks.filter(check => !check.ready).length, 3);
  assert.throws(() => inspectEnvironment({profile: 'production'}));
});
test('fresh synthetic aggregate passes only explicit test thresholds', () => {
  assert.equal(evaluateTelemetry(sample(), {now}).state, 'ok');
  const input = sample();
  input.metrics.ingestionDelaySeconds = 31;
  assert.equal(evaluateTelemetry(input, {now}).state, 'alert');
  input.metrics.ingestionDelaySeconds = 30;
  assert.equal(evaluateTelemetry(input, {now}).state, 'ok');
});
test('old, future, absent and malformed observations never create healthy monitoring', () => {
  assert.equal(evaluateTelemetry(sample(), {now: now + 60_000}).state, 'unknown');
  assert.equal(evaluateTelemetry(sample(), {now: now - 60_000}).state, 'unknown');
  for (const value of [null, '0', -1, Infinity, undefined]) {
    const input = sample(); input.metrics.staleEquipmentRatio = value;
    assert.equal(evaluateTelemetry(input, {now}).state, 'unknown');
  }
  const input = sample(); delete input.thresholds.apiErrorRatio;
  assert.throws(() => evaluateTelemetry(input, {now}), /threshold/);
});
test('journal and background errors alert, but fractional counts are unknown', () => {
  for (const name of ['backgroundFailures', 'journalFailures']) {
    const input = sample(); input.metrics[name] = 1;
    assert.equal(evaluateTelemetry(input, {now}).state, 'alert');
    input.metrics[name] = 0.5;
    assert.equal(evaluateTelemetry(input, {now}).state, 'unknown');
  }
});
test('drill refuses implicit remote connections, production and missing acknowledgement', () => {
  const env = {OPS_PGHOST: '127.0.0.1', OPS_PGPORT: '55439', OPS_PGUSER: 'existing_owner'};
  const args = ['--confirm-disposable-synthetic'];
  assert.equal(drillConfig(env, args).host, '127.0.0.1');
  assert.throws(() => drillConfig(env, []), /Required/);
  for (const patch of [{NODE_ENV: 'production'}, {OPS_PGHOST: 'example.com'}, {OPS_PGPORT: '0'},
    {OPS_PGPORT: '55439x'}, {OPS_PGUSER: 'owner; DROP DATABASE x'}, {DATABASE_URL: 'private'},
    {PGSERVICE: 'private'}, {PGSERVICEFILE: 'private'}, {PGOPTIONS: 'private'}, {PGHOSTADDR: 'remote'}]) {
    assert.throws(() => drillConfig({...env, ...patch}, args));
  }
  assert.throws(() => findTools({PG_BIN: new URL('../missing-client-tools', import.meta.url).pathname}), /unavailable/);
});
function recoverySnapshot() {
  const observation = {id: 'observation', organization_id: 'tenant', idempotency_key: 'synthetic-key',
    observed_at: '2026-11-05T10:00:00Z', received_at: '2026-11-05T10:01:00Z'};
  return {tables: {equipment: Array.from({length: 8}, (_, id) => ({id})), location: Array.from({length: 10}, (_, id) => ({id})),
    equipment_observation: [observation], equipment_event: [{id: 'event'}], ingestion_nonce: [{nonce: 'nonce'}],
    ingestion_receipt: [{observation_id: observation.id, organization_id: 'tenant', idempotency_key: 'synthetic-key'}],
    ingestion_dead_letter: [{reason: 'replay'}]}, metadata: {rls: [['equipment', true, true, null]]}};
}
test('integrity verifier detects equal-count corruption, lost evidence and altered security metadata', () => {
  const before = recoverySnapshot();
  assert.match(verifySnapshot(before, structuredClone(before)).dataSha256, /^[a-f0-9]{64}$/);
  for (const corrupt of [
    after => { after.tables.equipment[0].id = 'corrupt'; },
    after => { after.tables.ingestion_nonce = []; },
    after => { after.metadata.rls[0][2] = false; },
    after => { after.tables.equipment_observation[0].received_at = '2026-11-05T11:00:00Z'; },
  ]) {
    const after = structuredClone(before); corrupt(after);
    assert.throws(() => verifySnapshot(before, after), /differs/);
  }
});
test('integrity verifier rejects internally broken receipt references and conflated physical time', () => {
  const input = recoverySnapshot(); input.tables.ingestion_receipt[0].observation_id = 'missing';
  assert.throws(() => verifySnapshot(input, structuredClone(input)));
  const times = recoverySnapshot(); times.tables.equipment_observation[0].observed_at = times.tables.equipment_observation[0].received_at;
  assert.throws(() => verifySnapshot(times, structuredClone(times)), /distinct/);
});
test('recursive archive cleanup is confined to a generated direct child of the temporary root', () => {
  const target = join(tmpdir(), 'sv-ops-recovery-fixture');
  assert.equal(archiveCleanupTarget(target), target);
  for (const unsafe of [tmpdir(), join(tmpdir(), '..', 'retained'), join(target, 'nested'), join(tmpdir(), 'other-task')]) {
    assert.throws(() => archiveCleanupTarget(unsafe), /Refusing cleanup/);
  }
});
