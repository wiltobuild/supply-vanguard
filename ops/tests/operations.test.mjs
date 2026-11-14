import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectEnvironment} from '../environment.mjs';
import {evaluateTelemetry} from '../monitor.mjs';
import {archiveCleanupTarget, drillConfig, findTools} from '../recovery-drill.mjs';

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
test('recursive archive cleanup is confined to a generated direct child of the temporary root', () => {
  const target = join(tmpdir(), 'sv-ops-recovery-fixture');
  assert.equal(archiveCleanupTarget(target), target);
  for (const unsafe of [tmpdir(), join(tmpdir(), '..', 'retained'), join(target, 'nested'), join(tmpdir(), 'other-task')]) {
    assert.throws(() => archiveCleanupTarget(unsafe), /Refusing cleanup/);
  }
});
