import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createSyntheticLocal} from '../../local-bootstrap.mjs';
import {createLocationResolution} from '../index.mjs';
import {migrateResolution} from '../migrate.mjs';
import {createVendorAdapter} from '../vendor-adapter.mjs';

// Synthetic policy only. No live provider, clinical threshold or production credential.
const policy = {version: 'synthetic-native-v1', freshMs: 60_000, staleMs: 300_000, conflictWindowMs: 10_000, maxOverrideMs: 120_000};
let clock = Date.parse('2026-11-05T19:00:00.000Z');
const at = seconds => new Date(clock + seconds * 1000).toISOString();
let f, resolver, room2, otherOrganization, otherEquipment, otherLocation;
const scope = () => ({request: f.request, organizationId: f.organizationId, equipmentId: f.equipmentId});
const get = () => resolver.get(scope());
const role = value => f.owner.query('UPDATE auth_membership SET role = $1 WHERE user_id = $2', [value, f.userId]);
const override = (key = randomUUID(), changes = {}) => resolver.override({...scope(), idempotencyKey: key,
  body: {locationId: room2, observedAt: at(-5), expiresAt: at(60), reason: 'Synthetic fixture verification', correlationId: 'synthetic-override', ...changes}});
const count = async table => (await f.owner.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
async function ingest(key, locationId, seconds) {
  return f.ingestion.ingest({request: f.request, organizationId: f.organizationId, envelope: f.signer.envelope({
    schemaVersion: 1, equipmentId: f.equipmentId, locationId, observedAt: at(seconds), source: 'simulator', idempotencyKey: key})});
}
const runtime = (permission, work) => f.authorization.run(f.request, {organizationId: f.organizationId, permission}, work);

before(async () => {
  f = await createSyntheticLocal({mode: 'test', now: () => clock});
  await migrateResolution(f.owner, 'up'); await migrateResolution(f.owner, 'up');
  await f.owner.query('GRANT SELECT, INSERT ON location_override, location_override_audit TO sv_ingestion_local');
  // Needed only to assert existing audit RLS denial below, never changed by the migration.
  await f.owner.query('GRANT SELECT ON equipment_event TO sv_ingestion_local');
  room2 = (await f.owner.query("SELECT id FROM location WHERE external_key = 'room-102'")).rows[0].id;
  otherOrganization = randomUUID(); otherEquipment = randomUUID(); otherLocation = randomUUID();
  await f.owner.query("INSERT INTO organization(id, name) VALUES ($1, 'Synthetic other tenant')", [otherOrganization]);
  await f.owner.query("INSERT INTO facility(id, organization_id, name) VALUES ($1, $1, 'Synthetic other facility')", [otherOrganization]);
  await f.owner.query("INSERT INTO ward(id, organization_id, facility_id, name) VALUES ($1, $1, $1, 'Synthetic other ward')", [otherOrganization]);
  await f.owner.query("INSERT INTO location(id, organization_id, ward_id, external_key, name, kind) VALUES ($1, $2, $2, 'room-101', 'Synthetic other room', 'room')", [otherLocation, otherOrganization]);
  await f.owner.query("INSERT INTO equipment_type(id, organization_id, model_kind, name) VALUES ($1, $1, 'monitor', 'Synthetic monitor')", [otherOrganization]);
  await f.owner.query("INSERT INTO equipment(id, organization_id, external_id, name, equipment_type_id, location_id, status, provenance) VALUES ($1, $2, 'OTHER-EQ', 'Synthetic monitor', $2, $3, 'available', 'synthetic-test')", [otherEquipment, otherOrganization, otherLocation]);
  resolver = createLocationResolution({authorization: f.authorization, policy, now: () => clock});
});
after(async () => { if (f) await f.close(); });

test('native unknown baseline, source-authenticated ingestion, late input, conflict and stale resolution', async () => {
  assert.match((await f.owner.query('SELECT version()')).rows[0].version, /PostgreSQL 18\.6/);
  assert.equal((await get()).state, 'unknown');
  assert.equal((await ingest('native-newer', room2, -20)).status, 201);
  assert.equal((await ingest('native-older', f.locationId, -100)).status, 201);
  const projected = await get();
  assert.equal(projected.locationId, room2); assert.equal(projected.observedAt, at(-20));
  assert.equal(projected.evidence[0].sourceId, 'synthetic-nicu');
  assert.equal((await ingest('native-newer', room2, -20)).code, 'duplicate');
  assert.deepEqual(await get(), projected);
  assert.equal((await ingest('native-conflict', f.locationId, -20)).status, 201);
  assert.equal((await get()).state, 'uncertain'); assert.equal((await get()).locationId, null);
  // A later unambiguous physical reading clears the synthetic conflict window.
  assert.equal((await ingest('native-resolved', room2, -1)).status, 201);
  assert.equal((await get()).locationId, room2);
  clock += 301_000;
  assert.equal((await get()).state, 'stale');
});

test('administrative status writes do not refresh confidence or change projection', async () => {
  const before = await get();
  await f.owner.query("UPDATE equipment SET status = 'maintenance', version = version + 1, last_admin_edit_at = $1 WHERE id = $2", [at(0), f.equipmentId]);
  assert.deepEqual(await get(), before);
});

test('provider-neutral adapter feeds unchanged signed ingestion boundary', async () => {
  const adapter = createVendorAdapter({organizationId: f.organizationId, sourceId: 'synthetic-nicu', source: 'simulator',
    decode: async payload => payload, equipmentIdForTag: async () => f.equipmentId, locationIdForZone: async () => room2});
  const reading = {readingId: 'adapter-native-1', tagId: 'fixture-tag', zoneId: 'fixture-zone', observedAt: at(-20)};
  const normalized = await adapter.normalize(reading);
  const send = input => f.ingestion.ingest({request: f.request, organizationId: normalized.organizationId, envelope: f.signer.envelope(input)});
  assert.equal((await send(normalized.observation)).code, 'accepted');
  assert.equal((await send(normalized.observation)).code, 'duplicate');
  const changed = await adapter.normalize({...reading, observedAt: at(-19)});
  assert.equal((await send(changed.observation)).code, 'idempotency-conflict');
});

test('viewer/operator/tenant boundaries and unchanged general audit restrictions', async () => {
  await assert.rejects(override('operator-denied'), e => e.code === 'forbidden');
  const absent = randomUUID();
  await assert.rejects(resolver.get({...scope(), equipmentId: absent}), e => e.code === 'not-found');
  await assert.rejects(resolver.get({...scope(), organizationId: absent}), e => e.code === 'forbidden');
  await assert.rejects(resolver.get({...scope(), equipmentId: otherEquipment}), e => e.code === 'not-found');
  await assert.rejects(resolver.get({...scope(), organizationId: otherOrganization, equipmentId: otherEquipment}), e => e.code === 'forbidden');
  const rows = await runtime('inventory:read', ctx => ctx.query('SELECT * FROM equipment_event'));
  assert.equal(rows.rows.length, 0);
  await role('viewer');
  const projected = await get(); assert.equal(projected.evidence[0].sourceId, null); // receipt source ID remains permission-scoped
  await assert.rejects(override('viewer-denied'), e => e.code === 'forbidden');
  await role('equipment_manager');
  await assert.rejects(override('cross-tenant-location', {locationId: otherLocation}), e => e.code === 'not-found');
});

test('native audited manual precedence commits atomically and preserves core state', async () => {
  const beforeCore = (await f.owner.query('SELECT * FROM equipment WHERE id = $1', [f.equipmentId])).rows[0];
  const beforeEvents = await count('equipment_event');
  const result = await override('override-original', {locationId: f.locationId});
  assert.equal(result.replayed, false); assert.equal(result.projection.locationId, f.locationId);
  assert.equal(result.projection.reason, 'manual-override');
  assert.deepEqual((await f.owner.query('SELECT * FROM equipment WHERE id = $1', [f.equipmentId])).rows[0], beforeCore);
  assert.equal(await count('equipment_event'), beforeEvents);
  const audit = (await f.owner.query("SELECT * FROM location_override_audit WHERE idempotency_key = 'override-original'")).rows[0];
  assert.equal(audit.user_id, f.userId); assert.equal(audit.reason, 'Synthetic fixture verification');
  assert.deepEqual(audit.policy, policy); assert.equal(audit.before_state.locationId, room2);
  assert.deepEqual(audit.after_state, result.projection);
  await assert.rejects(override('overlap'), e => e.code === 'active-override');
  await assert.rejects(override('override-original', {reason: 'Changed reason'}), e => e.code === 'idempotency-conflict');
  // Replays bind to authenticated actor, even another manager with the same tenant.
  const other = randomUUID();
  await f.owner.query('INSERT INTO auth_user(id, issuer, subject) VALUES ($1,$2,$3)', [other, 'urn:supply-vanguard:local', 'synthetic-other-manager']);
  await f.owner.query("INSERT INTO auth_membership(organization_id,user_id,role) VALUES ($1,$2,'equipment_manager')", [f.organizationId, other]);
  const token = f.identities.issue('synthetic-other-manager');
  await assert.rejects(resolver.override({...scope(), request: {...f.request, headers: {authorization: `Bearer ${token}`}},
    idempotencyKey: 'override-original', body: {locationId: f.locationId, observedAt: at(-5), expiresAt: at(60), reason: 'Synthetic fixture verification', correlationId: 'synthetic-override'}}), e => e.code === 'idempotency-conflict');
  clock += 60_000;
  assert.equal((await get()).reason, 'expired-override'); // only older sensor input exists
  assert.equal((await get()).locationId, null);
  // A retry after expiry returns the original snapshot and does not extend the override.
  const replay = await resolver.override({...scope(), idempotencyKey: 'override-original', body: {
    locationId: f.locationId, observedAt: audit.after_state.override.observedAt, expiresAt: audit.after_state.override.expiresAt,
    reason: audit.reason, correlationId: 'synthetic-override'}});
  assert.equal(replay.replayed, true); assert.deepEqual(replay.projection, result.projection);
  assert.equal(await count('location_override'), 1);
  await role('operator');
  await assert.rejects(resolver.override({...scope(), idempotencyKey: 'override-original', body: {
    locationId: f.locationId, observedAt: at(-65), expiresAt: at(0), reason: audit.reason, correlationId: 'synthetic-override'}}), e => e.code === 'forbidden');
  assert.equal((await runtime('inventory:read', ctx => ctx.query('SELECT * FROM location_override_audit'))).rows.length, 0);
  await role('equipment_manager');
  assert.equal((await ingest('post-override', room2, -1)).status, 201);
  assert.equal((await get()).locationId, room2);
});

test('invalid bounds, unknown references and failed audit insert leave no override behind', async () => {
  const before = await count('location_override');
  for (const changes of [{expiresAt: at(121)}, {expiresAt: at(0)}, {observedAt: at(1)}, {reason: ''}]) await assert.rejects(override(randomUUID(), changes));
  await assert.rejects(override(randomUUID(), {observedAt: at(-100)}), e => e.code === 'older-than-override');
  await assert.rejects(override(randomUUID(), {locationId: randomUUID()}), e => e.code === 'not-found');
  const failing = createLocationResolution({policy, now: () => clock, authorization: {
    run: (request, options, work) => f.authorization.run(request, options, ctx => work({...ctx, query: (sql, params) => {
      if (sql.startsWith('INSERT INTO location_override_audit')) throw new Error('synthetic audit failure');
      return ctx.query(sql, params);
    }}))}});
  await assert.rejects(failing.override({...scope(), idempotencyKey: 'rollback', body: {
    locationId: room2, observedAt: at(-1), expiresAt: at(60), reason: 'Synthetic rollback'}}), /synthetic audit failure/);
  assert.equal(await count('location_override'), before);
  // Even direct SQL through a legitimate manager cannot commit unaudited minimal facts.
  await assert.rejects(runtime('equipment:manage', ctx => ctx.query(`INSERT INTO location_override
    (id, organization_id, equipment_id, location_id, observed_at, starts_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  [randomUUID(), f.organizationId, f.equipmentId, room2, at(-1), at(0), at(60)])), /location_override_requires_audit/);
  assert.equal(await count('location_override'), before);
});

test('native concurrent identical keys wait on distinct sessions and create one override/audit', async () => {
  const key = 'native-concurrent';
  const locker = await f.pool.connect();
  let pending = [];
  try {
    await locker.query('BEGIN');
    await locker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 14014))', [`${f.organizationId}:key:${key}`]);
    pending = [override(key), override(key)];
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i++) {
      waiting = (await f.owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE '%14014%'")).rows[0].n;
      if (waiting < 2) await delay(20);
    }
    assert.ok(waiting >= 2, 'two native backend sessions must wait concurrently');
  } finally { await locker.query('ROLLBACK'); locker.release(); }
  const outcomes = await Promise.all(pending);
  assert.deepEqual(outcomes.map(o => o.replayed).sort(), [false, true]);
  assert.deepEqual(outcomes[0].projection, outcomes[1].projection);
  assert.equal((await f.owner.query('SELECT count(*)::int AS n FROM location_override_audit WHERE idempotency_key = $1', [key])).rows[0].n, 1);
  clock += 60_000;
});

test('different-key concurrent overrides have one winner; immutable evidence survives retries', async () => {
  const results = await Promise.allSettled([override('competing-a'), override('competing-b')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'active-override');
  await assert.rejects(f.owner.query('UPDATE location_override SET expires_at = expires_at + interval \'1 second\''), /append-only/);
  await assert.rejects(f.owner.query('DELETE FROM location_override_audit'), /append-only/);
  await role('operator');
  assert.equal((await get()).reason, 'manual-override');
  assert.equal((await runtime('inventory:read', ctx => ctx.query('SELECT * FROM equipment_event'))).rows.length, 0);
  await role('equipment_manager');
});

test('evidence overflow fails closed and migration down/up touches only task-local tables', async () => {
  const limited = createLocationResolution({authorization: f.authorization, policy, now: () => clock, maxEvidence: 1});
  await ingest('overflow-a', room2, -1); await ingest('overflow-b', f.locationId, -1);
  await assert.rejects(limited.get(scope()), e => e.code === 'resolution-evidence-limit');
  const before = await count('equipment_observation');
  await migrateResolution(f.owner, 'down'); await migrateResolution(f.owner, 'down');
  assert.equal(await count('equipment_observation'), before);
  await assert.rejects(get(), /Unsafe resolution tables/);
  await migrateResolution(f.owner, 'up');
  assert.equal(await count('location_override'), 0);
});
