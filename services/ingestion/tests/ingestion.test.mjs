import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createSyntheticLocal} from '../local-bootstrap.mjs';
import {createLocalSourceVerifier} from '../local-verifier.mjs';
import {createIngestion} from '../index.mjs';
import {createIngestionHandler} from '../http.mjs';
import {createAuthorization} from '../../api/auth/index.mjs';

let f, server, base, otherOrganization, otherEquipment, otherLocation;
let clock = Date.parse('2026-11-05T16:00:00.000Z');
const now = () => clock;
const instant = offset => new Date(clock + offset).toISOString();
const observation = (key = randomUUID(), changes = {}) => ({schemaVersion: 1,
  equipmentId: f.equipmentId, locationId: f.locationId, observedAt: instant(-60_000), source: 'simulator', idempotencyKey: key, ...changes});
const send = (envelope, changes = {}) => f.ingestion.ingest({request: f.request, organizationId: f.organizationId, envelope, ...changes});
const signed = (input, options) => f.signer.envelope(input, options);
const count = async table => (await f.owner.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count;
const journal = async () => (await readFile(f.journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
const runtime = work => f.authorization.run(f.request, {organizationId: f.organizationId, permission: 'equipment:write'}, work);

before(async () => {
  f = await createSyntheticLocal({mode: 'test', now});
  otherOrganization = randomUUID(); otherEquipment = randomUUID(); otherLocation = randomUUID();
  // Trusted owner only in this disposable cluster; runtime always uses its own non-owner login.
  await f.owner.query(`INSERT INTO organization(id, name) VALUES ($1, 'Synthetic other tenant')`, [otherOrganization]);
  await f.owner.query('INSERT INTO facility(id, organization_id, name) VALUES ($1, $1, $2)', [otherOrganization, 'Synthetic facility']);
  await f.owner.query('INSERT INTO ward(id, organization_id, facility_id, name) VALUES ($1, $1, $1, $2)', [otherOrganization, 'Synthetic ward']);
  await f.owner.query("INSERT INTO location(id, organization_id, ward_id, external_key, name, kind) VALUES ($1, $2, $2, 'room-101', 'Synthetic other room', 'room')", [otherLocation, otherOrganization]);
  await f.owner.query("INSERT INTO equipment_type(id, organization_id, model_kind, name) VALUES ($1, $1, 'monitor', 'Synthetic monitor')", [otherOrganization]);
  await f.owner.query("INSERT INTO equipment(id, organization_id, external_id, name, equipment_type_id, location_id, status, provenance) VALUES ($1, $2, 'OTHER-EQ', 'Synthetic other monitor', $2, $3, 'available', 'synthetic-test')", [otherEquipment, otherOrganization, otherLocation]);
  server = createServer(createIngestionHandler(f.ingestion));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/observations?organizationId=${f.organizationId}`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (f) await f.close();
});

test('native PostgreSQL runtime uses separate non-owner connections and forced RLS', async () => {
  assert.match((await f.owner.query('SELECT version()')).rows[0].version, /PostgreSQL 18\.6/);
  const clients = await Promise.all([f.pool.connect(), f.pool.connect()]);
  try {
    const pids = await Promise.all(clients.map(c => c.query('SELECT pg_backend_pid() AS pid, current_user AS role')));
    assert.notEqual(pids[0].rows[0].pid, pids[1].rows[0].pid);
    assert.equal(pids[0].rows[0].role, 'sv_ingestion_local');
    assert.equal((await clients[0].query('SELECT count(*)::int AS count FROM equipment')).rows[0].count, 0);
    await assert.rejects(clients[0].query('INSERT INTO ingestion_nonce VALUES ($1, $2, $3, now())', [f.organizationId, 'forged', 'nonce']), /row-level security/);
  } finally { for (const c of clients) c.release(); }
});

test('HTTP verifies membership and source, stamps receipt time, and preserves observed provenance', async () => {
  const input = observation('http-accepted', {correlationId: 'synthetic-correlation'});
  const result = await fetch(base, {method: 'POST', headers: {...f.request.headers, 'content-type': 'application/json'}, body: JSON.stringify(signed(input))});
  assert.equal(result.status, 201);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const body = await result.json();
  assert.equal(body.code, 'accepted'); assert.equal(body.observedAt, input.observedAt); assert.equal(body.receivedAt, instant(0));
  const row = (await f.owner.query('SELECT * FROM equipment_observation WHERE id = $1', [body.observationId])).rows[0];
  assert.equal(row.source, 'simulator'); assert.equal(row.actor, 'simulator:synthetic-nicu');
  assert.equal(row.organization_id, f.organizationId); assert.equal(row.correlation_id, input.correlationId);
  assert.equal(row.observed_at.toISOString(), input.observedAt); assert.equal(row.received_at.toISOString(), instant(0));
});

test('exact transport replay rejects with durable evidence; freshly signed identical retry is idempotent', async () => {
  const input = observation('idempotent'); const envelope = signed(input);
  const accepted = await send(envelope);
  assert.equal(accepted.code, 'accepted');
  assert.deepEqual(await send(envelope), {status: 409, code: 'replay'});
  clock += 2_000;
  const duplicate = await send(signed(input));
  assert.equal(duplicate.code, 'duplicate'); assert.equal(duplicate.observationId, accepted.observationId);
  assert.equal(duplicate.receivedAt, accepted.receivedAt);
  assert.equal((await f.owner.query("SELECT count(*)::int AS count FROM equipment_observation WHERE idempotency_key = 'idempotent'")).rows[0].count, 1);
  assert.ok((await f.owner.query("SELECT envelope_digest FROM ingestion_dead_letter WHERE reason = 'replay'")).rows.length);
});

test('idempotency key reuse with changed payload or verified source rejects', async () => {
  const input = observation('collision'); await send(signed(input));
  assert.deepEqual(await send(signed({...input, observedAt: instant(-90_000)})), {status: 409, code: 'idempotency-conflict'});
  const otherSigner = f.verification.provision({sourceId: 'other-synthetic-source', organizationId: f.organizationId, userId: f.userId});
  assert.deepEqual(await send(otherSigner.envelope(input)), {status: 409, code: 'idempotency-conflict'});
});

test('unverified proof, tampering, non-loopback and source/user/tenant substitution all reject', async () => {
  const good = signed(observation());
  for (const envelope of [{...good, proof: '0'.repeat(64)}, {...good, nonce: randomUUID()}, {...good, observation: observation('tampered')}]) {
    assert.deepEqual(await send(envelope), {status: 403, code: 'unauthorized-source'});
  }
  const nonLoopback = {...f.request, socket: {remoteAddress: '203.0.113.1'}};
  assert.deepEqual(await send(good, {request: nonLoopback}), {status: 401, code: 'unauthenticated'});
  const foreign = f.verification.provision({sourceId: 'foreign-synthetic', organizationId: otherOrganization, userId: f.userId});
  assert.deepEqual(await send(foreign.envelope(observation())), {status: 403, code: 'unauthorized-source'});
  const wrongUser = f.verification.provision({sourceId: 'wrong-user', organizationId: f.organizationId, userId: randomUUID()});
  assert.deepEqual(await send(wrongUser.envelope(observation())), {status: 403, code: 'unauthorized-source'});
});

test('absent, forged and unprovisioned memberships reject to an unscoped redacted journal', async () => {
  const before = await count('ingestion_dead_letter');
  for (const token of [null, 'made-up', f.identities.issue('unprovisioned')]) {
    const request = {...f.request, headers: token ? {authorization: `Bearer ${token}`, 'x-role': 'admin'} : {}};
    assert.deepEqual(await send(signed(observation()), {request}), {status: 401, code: 'unauthenticated'});
  }
  assert.deepEqual(await send(signed(observation()), {organizationId: otherOrganization}), {status: 403, code: 'forbidden'});
  assert.equal(await count('ingestion_dead_letter'), before);
  for (const record of await journal()) {
    assert.deepEqual(Object.keys(record).sort(), ['envelopeDigest', 'reason', 'receivedAt']);
    assert.match(record.envelopeDigest, /^[a-f0-9]{64}$/);
  }
  assert.ok(!(await readFile(f.journalPath, 'utf8')).includes(f.token));
});

test('membership downgrade, revocation and source revocation affect existing sessions and retries', async () => {
  const input = observation('revoked'); assert.equal((await send(signed(input))).code, 'accepted');
  await f.owner.query("UPDATE auth_membership SET role = 'viewer' WHERE user_id = $1", [f.userId]);
  assert.equal((await send(signed(input))).status, 403);
  await f.owner.query("UPDATE auth_membership SET role = 'operator', active = false WHERE user_id = $1", [f.userId]);
  assert.equal((await send(signed(input))).status, 403);
  await f.owner.query('UPDATE auth_membership SET active = true WHERE user_id = $1', [f.userId]);
  await f.owner.query('UPDATE auth_user SET active = false WHERE id = $1', [f.userId]);
  assert.equal((await send(signed(input))).status, 401);
  await f.owner.query('UPDATE auth_user SET active = true WHERE id = $1', [f.userId]);
  const signer = f.verification.provision({sourceId: 'revocable', organizationId: f.organizationId, userId: f.userId});
  const envelope = signer.envelope(observation());
  f.verification.revoke('revocable');
  assert.equal((await send(envelope)).code, 'unauthorized-source');
});

test('replay window binds transmission time while offline observation time remains historical', async () => {
  for (const sentAt of [instant(-300_001), instant(1)]) {
    assert.deepEqual(await send(signed(observation(), {sentAt})), {status: 409, code: 'replay-window'});
  }
  assert.equal((await send(signed(observation(), {sentAt: instant(-300_000)}))).code, 'accepted');
  const historical = observation('offline-history', {observedAt: instant(-86_400_000)});
  assert.equal((await send(signed(historical))).code, 'accepted');
  const row = (await f.owner.query("SELECT observed_at, received_at FROM equipment_observation WHERE idempotency_key = 'offline-history'")).rows[0];
  assert.equal(row.observed_at.toISOString(), historical.observedAt);
  assert.equal(row.received_at.toISOString(), instant(0));
  // Ingestion is immutable intake only; no physical projection, status/version or freshness changes.
  const equipment = (await f.owner.query('SELECT location_id, version, status, last_verified_at, last_admin_edit_at, provenance FROM equipment WHERE id = $1', [f.equipmentId])).rows[0];
  assert.notEqual(equipment.location_id, f.locationId); assert.equal(equipment.version, 0);
  assert.equal(equipment.last_verified_at, null); assert.equal(equipment.last_admin_edit_at, null);
  assert.equal(equipment.status, 'available'); assert.equal(equipment.provenance, 'synthetic-seed');
});

test('malformed, future, invented source, spoofed receipt/actor and unknown fields leave dead-letter evidence', async () => {
  const invalid = [
    {schemaVersion: 2}, {source: 'ble'}, {actor: 'admin'}, {receivedAt: instant(0)},
    {observedAt: instant(1)}, {observedAt: '2026-02-30T16:00:00.000Z'},
    {equipmentId: 'not-a-uuid'}, {locationId: 'not-a-uuid'}, {idempotencyKey: ''},
    {unsupported: 'field'}, {correlationId: 'x'.repeat(101)}
  ];
  const before = await count('ingestion_dead_letter');
  for (const change of invalid) assert.equal((await send(signed(observation(undefined, change)))).code, 'malformed');
  for (const envelope of [null, [], {}, {...signed(observation()), extra: true}]) assert.equal((await send(envelope)).code, 'malformed');
  assert.equal(await count('ingestion_dead_letter'), before + invalid.length + 4);
  const letters = (await f.owner.query('SELECT * FROM ingestion_dead_letter')).rows;
  assert.ok(letters.every(row => row.organization_id === f.organizationId && row.user_id === f.userId));
  assert.ok(letters.every(row => !Object.hasOwn(row, 'payload')));
});

test('tenant foreign equipment/location are indistinguishable from missing references', async () => {
  for (const changes of [{equipmentId: otherEquipment}, {locationId: otherLocation}, {equipmentId: randomUUID()}, {locationId: randomUUID()}]) {
    assert.deepEqual(await send(signed(observation(undefined, changes))), {status: 404, code: 'unknown-reference'});
  }
  await runtime(async context => {
    assert.equal((await context.query('SELECT * FROM ingestion_receipt WHERE organization_id = $1', [otherOrganization])).rows.length, 0);
  });
  await assert.rejects(runtime(context => context.query('INSERT INTO ingestion_nonce VALUES ($1,$2,$3,now())', [otherOrganization, 'foreign', randomUUID()])), /row-level security/);
});

test('concurrent identical retries contend on real PostgreSQL advisory transaction locks', async () => {
  const input = observation('concurrent-identical'); const lock = `${f.organizationId}:${input.idempotencyKey}`;
  await f.owner.query('BEGIN'); await f.owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 13013))', [lock]);
  const calls = Array.from({length: 6}, () => send(signed(input)));
  let waiting = 0;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = (await f.owner.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename = 'sv_ingestion_local' AND wait_event_type = 'Lock' AND wait_event = 'advisory'")).rows[0].count;
      if (waiting >= 2) break;
      await delay(20);
    }
    assert.ok(waiting >= 2, `Expected overlapping database lock waits, saw ${waiting}`);
  } finally { await f.owner.query('ROLLBACK'); }
  const results = await Promise.all(calls);
  assert.equal(results.filter(r => r.code === 'accepted').length, 1);
  assert.equal(results.filter(r => r.code === 'duplicate').length, 5);
  assert.equal(new Set(results.map(r => r.observationId)).size, 1);
  assert.equal((await f.owner.query('SELECT count(*)::int AS count FROM equipment_observation WHERE idempotency_key = $1', [input.idempotencyKey])).rows[0].count, 1);
});

test('simultaneous conflicting idempotency keys and repeated nonce cannot double-ingest', async () => {
  const input = observation('concurrent-conflict');
  const conflict = await Promise.all([send(signed(input)), send(signed({...input, observedAt: instant(-100_000)}))]);
  assert.deepEqual(conflict.map(r => r.code).sort(), ['accepted', 'idempotency-conflict']);
  const envelope = signed(observation('concurrent-nonce'));
  const replay = await Promise.all([send(envelope), send(envelope)]);
  assert.deepEqual(replay.map(r => r.code).sort(), ['accepted', 'replay']);
});

test('receipt failure rolls back nonce and observation atomically; same envelope succeeds after recovery', async () => {
  const input = observation('rollback-test'); const envelope = signed(input);
  await f.owner.query(`CREATE FUNCTION ingestion_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.idempotency_key = 'rollback-test' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER ingestion_test_failure BEFORE INSERT ON ingestion_receipt FOR EACH ROW EXECUTE FUNCTION ingestion_test_failure();`);
  try {
    await assert.rejects(send(envelope), /synthetic receipt failure/);
    assert.equal((await f.owner.query('SELECT count(*)::int AS count FROM equipment_observation WHERE idempotency_key = $1', [input.idempotencyKey])).rows[0].count, 0);
    assert.equal((await f.owner.query('SELECT count(*)::int AS count FROM ingestion_nonce WHERE nonce = $1', [envelope.nonce])).rows[0].count, 0);
    assert.equal((await journal()).at(-1).reason, 'ingestion-failure');
  } finally { await f.owner.query('DROP TRIGGER ingestion_test_failure ON ingestion_receipt; DROP FUNCTION ingestion_test_failure();'); }
  assert.equal((await send(envelope)).code, 'accepted');
});

test('keys owned by another observation producer are never treated as verified duplicates', async () => {
  const input = observation('preexisting-core-key');
  await f.owner.query("INSERT INTO equipment_observation(organization_id, equipment_id, location_id, observed_at, received_at, source, actor, idempotency_key) VALUES ($1,$2,$3,$4,$5,'manual-check-in','synthetic-admin',$6)", [f.organizationId, f.equipmentId, f.locationId, input.observedAt, instant(0), input.idempotencyKey]);
  assert.deepEqual(await send(signed(input)), {status: 409, code: 'idempotency-conflict'});
});

test('observation, receipt, nonce and dead-letter evidence are append-only', async () => {
  // Force broad grants in the disposable fixture: RLS must still deny changes.
  await f.owner.query('GRANT UPDATE, DELETE ON equipment_observation, ingestion_receipt, ingestion_nonce, ingestion_dead_letter TO sv_ingestion_local');
  await runtime(async context => {
    for (const table of ['equipment_observation', 'ingestion_receipt', 'ingestion_nonce', 'ingestion_dead_letter']) {
      assert.equal((await context.query(`DELETE FROM ${table} RETURNING *`)).rows.length, 0);
    }
  });
  await assert.rejects(f.owner.query("UPDATE ingestion_receipt SET source_id = 'rewrite'"), /append-only/);
  await assert.rejects(f.owner.query('DELETE FROM ingestion_dead_letter'), /append-only/);
});

test('dead-letter reads require audit permission and evidence cannot impersonate another user', async () => {
  await runtime(async context => assert.equal((await context.query('SELECT * FROM ingestion_dead_letter')).rows.length, 0));
  await assert.rejects(runtime(context => context.query("INSERT INTO ingestion_dead_letter(organization_id,user_id,received_at,reason,envelope_digest) VALUES ($1,$2,now(),'malformed',$3)", [f.organizationId, randomUUID(), '0'.repeat(64)])), /row-level security/);
  await f.owner.query("UPDATE auth_membership SET role = 'equipment_manager' WHERE user_id = $1", [f.userId]);
  try {
    await runtime(async context => {
      assert.ok((await context.query('SELECT * FROM ingestion_dead_letter')).rows.length > 0);
      assert.equal((await context.query('SELECT * FROM ingestion_dead_letter WHERE organization_id = $1', [otherOrganization])).rows.length, 0);
    });
  } finally { await f.owner.query("UPDATE auth_membership SET role = 'operator' WHERE user_id = $1", [f.userId]); }
});

test('HTTP invalid JSON/media/size and journal/database failures fail closed', async () => {
  for (const [body, headers, expected] of [
    ['{', {'content-type': 'application/json'}, 400],
    ['{}', {'content-type': 'text/plain'}, 415],
    ['x'.repeat(17_000), {'content-type': 'application/json'}, 413],
    [JSON.stringify(signed(observation())), {'content-type': 'application/json'}, 401]
  ]) {
    const response = await fetch(base, {method: 'POST', headers, body});
    assert.equal(response.status, expected); assert.ok((await response.json()).code);
  }
  const failure = createIngestion({authorization: f.authorization, verification: f.verification, rejectionJournal: async () => {throw new Error('synthetic journal offline');}, now});
  await assert.rejects(failure.ingest({request: {...f.request, headers: {}}, organizationId: f.organizationId, envelope: signed(observation())}), /journal offline/);
  await assert.rejects(failure.rejectExternal('malformed', '{'), /journal offline/);
  const ownerAuth = createAuthorization({identityProvider: f.identities, pool: {connect: async () => ({query: (...args) => f.owner.query(...args), release() {}})}});
  const unsafe = createIngestion({authorization: ownerAuth, verification: f.verification, rejectionJournal: async () => {}, now});
  await assert.rejects(unsafe.ingest({request: f.request, organizationId: f.organizationId, envelope: signed(observation())}), /Unsafe runtime/);
});

test('local verifier bootstrapping is explicit, short-lived and never production-enabled', async () => {
  assert.throws(() => createLocalSourceVerifier(), /restricted/);
  assert.throws(() => createLocalSourceVerifier({mode: 'production'}), /restricted/);
  await assert.rejects(createSyntheticLocal({mode: 'production'}), /restricted/);
  const local = createLocalSourceVerifier({mode: 'test', now, ttlMs: 1});
  const signer = local.provision({sourceId: 'expiring', organizationId: f.organizationId, userId: f.userId});
  const envelope = signer.envelope(observation());
  assert.ok(await local.verify({request: f.request, envelope}));
  assert.equal(await local.verify({request: {...f.request, socket: {}}, envelope}), null);
  assert.equal(await local.verify({request: {...f.request, socket: {remoteAddress: '192.0.2.1'}}, envelope}), null);
  clock += 1;
  assert.equal(await local.verify({request: f.request, envelope}), null);
});

test('task-local migration down/up leaves core/auth tables and equipment intact', async () => {
  const equipmentCount = await count('equipment');
  await f.owner.query('BEGIN');
  await f.owner.query(readFileSync(new URL('../migrations/0001_ingestion.down.sql', import.meta.url), 'utf8'));
  assert.equal((await f.owner.query("SELECT to_regclass('public.ingestion_receipt') AS present")).rows[0].present, null);
  assert.equal(await count('equipment'), equipmentCount);
  assert.ok((await f.owner.query("SELECT to_regclass('public.auth_user') AS present")).rows[0].present);
  await f.owner.query(readFileSync(new URL('../migrations/0001_ingestion.up.sql', import.meta.url), 'utf8'));
  // Migration intentionally makes no assumptions about the caller's runtime role name.
  await f.owner.query('GRANT SELECT, INSERT ON ingestion_nonce, ingestion_receipt, ingestion_dead_letter TO sv_ingestion_local');
  await f.owner.query('COMMIT');
  assert.equal((await send(signed(observation('after-migration')))).code, 'accepted');
});
