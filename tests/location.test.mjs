import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveLocation, locationPolicy, validateOverride} from '../packages/domain/location/index.js';
import {applyAdminCommand} from '../packages/domain/contracts.js';
import {createVendorAdapter} from '../services/ingestion/resolution/vendor-adapter.mjs';

// Synthetic fixture values, never operational policy defaults.
const policy = {version: 'synthetic-v1', freshMs: 60_000, staleMs: 300_000, conflictWindowMs: 10_000, maxOverrideMs: 120_000};
const time = seconds => new Date(Date.parse('2026-11-05T19:00:00.000Z') + seconds * 1000).toISOString();
const scope = {organizationId: 'tenant-a', equipmentId: 'EQ-001', locationIds: ['room-101', 'room-102']};
const observation = (id, seconds, locationId = 'room-101', received = seconds) => ({...scope, locationIds: undefined,
  schemaVersion: 1, id, equipmentId: scope.equipmentId, organizationId: scope.organizationId,
  locationId, observedAt: time(seconds), receivedAt: time(received), source: 'simulator', sourceId: 'synthetic-source',
  actor: 'simulator:synthetic', idempotencyKey: `reading-${id}`, correlationId: 'synthetic-correlation'});
function obs(...args) { const value = observation(...args); delete value.locationIds; return value; }
const resolve = (observations, extras = {}) => resolveLocation({...scope, observations, now: time(30), policy, ...extras});
const override = {...scope, id: 'override-1', locationId: 'room-102', observedAt: time(20), startsAt: time(25), expiresAt: time(60)};
delete override.locationIds;

test('policy has no implicit business thresholds and is immutable', () => {
  for (const value of [undefined, {}, {...policy, version: ''}, {...policy, freshMs: -1}, {...policy, staleMs: 1}, {...policy, maxOverrideMs: 0}, {...policy, conflictWindowMs: Infinity}]) {
    assert.throws(() => locationPolicy(value));
  }
  const approved = locationPolicy(policy); assert.ok(Object.isFrozen(approved)); assert.notEqual(approved, policy);
});

test('no evidence is unknown; current administrative location is not a verification baseline', () => {
  assert.equal(resolve([]).state, 'unknown'); assert.equal(resolve([]).locationId, null);
  const item = {id: 'EQ-001', status: 'available', version: 0, locationId: 'room-101', lastVerified: null};
  const changed = applyAdminCommand(item, {schemaVersion: 1, equipmentId: item.id, expectedVersion: 0, actor: 'synthetic-user', status: 'maintenance', idempotencyKey: 'status'}, {now: time(30)});
  assert.equal(changed.equipment.lastVerified, null); assert.equal(resolve([]).freshness, 'unknown');
});

test('late receipt, reordering and exact duplicate delivery cannot regress the latest location', () => {
  const older = obs('a', 0, 'room-101', 29), newer = obs('b', 20, 'room-102', 21);
  const expected = resolve([older, newer]);
  assert.equal(expected.locationId, 'room-102'); assert.equal(expected.observedAt, time(20));
  assert.deepEqual(resolve([newer, older, newer]), expected);
  assert.equal(expected.evidence[0].id, 'b'); assert.equal(expected.evidence[0].sourceId, 'synthetic-source');
  assert.equal(expected.receivedAt, time(21));
});

test('equal-time and near-time contradictory sources are uncertain, never settled by receipt/UUID', () => {
  const readings = [obs('z', 20, 'room-101', 22), {...obs('a', 20, 'room-102', 21), source: 'ble', sourceId: 'other-source'}];
  const result = resolve(readings);
  assert.equal(result.state, 'uncertain'); assert.equal(result.locationId, null);
  assert.deepEqual(result.conflictingLocationIds, ['room-101', 'room-102']);
  assert.deepEqual(result.evidence.map(o => o.id), ['a', 'z']);
  assert.deepEqual(resolve([...readings].reverse()), result);
  assert.equal(resolve([obs('a', 10), obs('b', 20, 'room-102')]).state, 'uncertain');
  assert.equal(resolve([obs('a', 9), obs('b', 20, 'room-102')]).locationId, 'room-102');
});

test('freshness boundaries use physical time; stale and uncertainty are independent', () => {
  const reading = obs('a', 0, 'room-101', 29);
  for (const [seconds, expected] of [[60, 'fresh'], [61, 'aging'], [300, 'aging'], [301, 'stale']]) {
    assert.equal(resolve([reading], {now: time(seconds)}).freshness, expected);
  }
  const uncertain = resolve([reading, obs('b', 0, 'room-102')], {now: time(301)});
  assert.equal(uncertain.state, 'uncertain'); assert.equal(uncertain.freshness, 'stale');
  assert.equal(resolve([obs('future', 31, 'room-101', 31)]).state, 'unknown');
});

test('time-bounded manual precedence expires without resurrecting older evidence', () => {
  const evidence = [obs('a', 0), obs('b', 25)];
  const active = resolve(evidence, {override});
  assert.equal(active.reason, 'manual-override'); assert.equal(active.locationId, 'room-102');
  assert.equal(active.observedAt, time(20)); assert.equal(active.evidence.at(-1).locationId, 'room-101');
  assert.equal(resolve([obs('a', 0)], {override, now: time(60)}).reason, 'expired-override');
  assert.equal(resolve([obs('a', 0)], {override, now: time(60)}).locationId, null);
  assert.equal(resolve(evidence, {override, now: time(60)}).locationId, 'room-101');
  assert.equal(resolve(evidence, {override, now: time(24)}).override, null);
  const old = {...override, observedAt: time(-100)};
  assert.equal(resolve(evidence, {override: old}).freshness, 'aging');
  assert.throws(() => validateOverride({...override, expiresAt: time(200)}, scope, policy));
  assert.throws(() => validateOverride({...override, observedAt: time(26)}, scope, policy));
});

test('cross-tenant, unknown location, changed IDs/keys and malformed clocks fail closed', () => {
  const reading = obs('a', 0);
  for (const changed of [{organizationId: 'other'}, {equipmentId: 'other'}, {locationId: 'unknown'}, {sourceId: ''}, {observedAt: time(30), receivedAt: time(29)}, {observedAt: '2026-02-30T19:00:00.000Z'}]) {
    assert.throws(() => resolve([{...reading, ...changed}]));
  }
  assert.throws(() => resolve([reading, {...reading, locationId: 'room-102'}]));
  assert.throws(() => resolve([reading, {...reading, id: 'different'}]));
  assert.throws(() => resolve([], {override: {...override, organizationId: 'other'}}));
});

test('provider boundary retains stable tenant/source IDs and time, never invents receipt or coordinates', async () => {
  const organizationId = '00000000-0000-4000-8000-000000000001';
  const equipmentId = '00000000-0000-4000-8000-000000000011';
  const locationId = '00000000-0000-4000-8000-000000000031';
  const adapter = createVendorAdapter({organizationId, sourceId: 'synthetic-rtls', source: 'rtls', decode: async payload => payload,
    equipmentIdForTag: async binding => { assert.equal(binding.organizationId, organizationId); return binding.tagId === 'known-tag' ? equipmentId : null; },
    locationIdForZone: async binding => binding.zoneId === 'known-zone' ? locationId : null});
  const payload = {readingId: 'stable-1', tagId: 'known-tag', zoneId: 'known-zone', observedAt: time(0), correlationId: 'synthetic'};
  const normalized = await adapter.normalize(payload);
  assert.equal(normalized.organizationId, organizationId); assert.equal(normalized.sourceId, 'synthetic-rtls');
  assert.equal(normalized.observation.observedAt, time(0)); assert.equal(normalized.observation.locationId, locationId);
  assert.equal(normalized.observation.receivedAt, undefined); assert.equal(normalized.observation.actor, undefined);
  assert.deepEqual(await adapter.normalize(payload), normalized);
  assert.equal((await adapter.normalize({...payload, observedAt: time(1)})).observation.idempotencyKey, normalized.observation.idempotencyKey);
  for (const bad of [{...payload, zoneId: 'unknown'}, {...payload, tagId: 'unknown'}, {...payload, x: 1}, {...payload, organizationId: 'spoofed'}, {...payload, observedAt: 'bad'}]) {
    await assert.rejects(adapter.normalize(bad));
  }
});
