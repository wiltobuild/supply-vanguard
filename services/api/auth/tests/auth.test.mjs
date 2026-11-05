import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import {createAuthorization, AuthError, ROLE_PERMISSIONS, permits, writeAuthError} from '../index.mjs';
import {createLocalIdentityProvider} from '../local-identity.mjs';

const db = new PGlite();
const sql = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const EA = '00000000-0000-4000-8000-000000000011';
const EB = '00000000-0000-4000-8000-000000000012';
const TA = '00000000-0000-4000-8000-000000000021';
const TB = '00000000-0000-4000-8000-000000000022';
const LA = '00000000-0000-4000-8000-000000000031';
const LB = '00000000-0000-4000-8000-000000000032';
const users = {};
let clock = 1_000;
const identityProvider = createLocalIdentityProvider({mode: 'test', now: () => clock});
const tokens = {};
// PGlite is a single connection. This test pool serializes leases just as a real pool leases clients.
let available = Promise.resolve();
async function connect(role = 'sv_auth_test_runtime') {
  const previous = available;
  let release;
  available = new Promise(resolve => { release = resolve; });
  await previous;
  await db.query(role ? `SET ROLE ${role}` : 'RESET ROLE');
  return {query: (...args) => db.query(...args), release};
}
const pool = {connect: () => connect()};
const auth = createAuthorization({identityProvider, pool});
const request = token => ({headers: {authorization: `Bearer ${token}`}, socket: {remoteAddress: '127.0.0.1'}});
const run = (who, organizationId, permission, work) => auth.run(request(tokens[who]), {organizationId, permission}, work);
async function owner(sqlText, params = []) {
  const client = await connect(null);
  try { return await client.query(sqlText, params); } finally { client.release(); }
}
let server, base;

before(async () => {
  // PGlite ships built-in gen_random_uuid(). Core's unused pgcrypto extension is not bundled.
  await db.exec(sql('../../db/migrations/0001_core.up.sql').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  await db.exec(sql('../migrations/0001_auth.up.sql'));
  await db.exec(`
    INSERT INTO organization(id, name) VALUES ('${A}', 'Synthetic A'), ('${B}', 'Synthetic B');
    INSERT INTO facility(id, organization_id, name) VALUES ('${A}', '${A}', 'Synthetic facility A'), ('${B}', '${B}', 'Synthetic facility B');
    INSERT INTO ward(id, organization_id, facility_id, name) VALUES ('${A}', '${A}', '${A}', 'Synthetic ward A'), ('${B}', '${B}', '${B}', 'Synthetic ward B');
    INSERT INTO location(id, organization_id, ward_id, external_key, name, kind) VALUES ('${LA}', '${A}', '${A}', 'room', 'Synthetic A room', 'room'), ('${LB}', '${B}', '${B}', 'room', 'Synthetic B room', 'room');
    INSERT INTO equipment_type(id, organization_id, model_kind, name) VALUES ('${TA}', '${A}', 'monitor', 'Synthetic monitor A'), ('${TB}', '${B}', 'monitor', 'Synthetic monitor B');
    INSERT INTO equipment(id, organization_id, external_id, name, equipment_type_id, location_id, status, provenance)
      VALUES ('${EA}', '${A}', 'EQ-A', 'Synthetic A monitor', '${TA}', '${LA}', 'available', 'synthetic-test'), ('${EB}', '${B}', 'EQ-B', 'Synthetic B monitor', '${TB}', '${LB}', 'available', 'synthetic-test');
    INSERT INTO equipment_event(organization_id, equipment_id, kind, actor, source, idempotency_key, after_state)
      VALUES ('${A}', '${EA}', 'admin', 'synthetic', 'test', 'event-a', '{}'), ('${B}', '${EB}', 'admin', 'synthetic', 'test', 'event-b', '{}');
    INSERT INTO equipment_observation(organization_id, equipment_id, location_id, observed_at, received_at, source, actor, idempotency_key)
      VALUES ('${A}', '${EA}', '${LA}', now(), now(), 'simulator', 'synthetic', 'obs-a'), ('${B}', '${EB}', '${LB}', now(), now(), 'simulator', 'synthetic', 'obs-b');
    -- Throwaway test-only role, no login or persistent credentials. Broad CRUD grants deliberately
    -- exercise RLS even if a future handler forgets a tenant predicate. Never use owner/superuser.
    CREATE ROLE sv_auth_test_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
    GRANT USAGE ON SCHEMA public TO sv_auth_test_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization, facility, ward, location, equipment_type, equipment, equipment_observation, equipment_event TO sv_auth_test_runtime;
    GRANT SELECT ON auth_user, auth_membership TO sv_auth_test_runtime;
    GRANT EXECUTE ON FUNCTION auth_resolve_identity(text, text) TO sv_auth_test_runtime;
  `);
  for (const [i, role] of Object.keys(ROLE_PERMISSIONS).entries()) {
    users[role] = `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`;
    await db.query('INSERT INTO auth_user(id, issuer, subject) VALUES ($1, $2, $3)', [users[role], 'urn:supply-vanguard:local', role]);
    await db.query('INSERT INTO auth_membership(organization_id, user_id, role) VALUES ($1, $2, $3)', [A, users[role], role]);
    tokens[role] = identityProvider.issue(role);
  }
  // Minimal test-only route proves the HTTP -> verified identity -> membership -> transaction ->
  // PostgreSQL path. Production equipment routing and atomic audits remain SV-006.
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const organizationId = url.searchParams.get('organizationId');
      const id = url.searchParams.get('id');
      const permission = req.method === 'PATCH' ? 'equipment:write' : 'inventory:read';
      const result = await auth.run(req, {organizationId, permission}, async context => {
        const result = req.method === 'PATCH'
          ? await context.query("UPDATE equipment SET note = 'synthetic-http-edit', version = version + 1 WHERE id = $1 RETURNING id", [id])
          : await context.query('SELECT id, organization_id FROM equipment WHERE ($1::uuid IS NULL OR id = $1)', [id]);
        return result.rows;
      });
      res.writeHead(id && !result.length ? 404 : 200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      res.end(JSON.stringify(result));
    } catch (error) { writeAuthError(res, error); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await available;
  await db.close();
});

test('local identity is explicit, loopback-only, opaque, expiring and revocable', async () => {
  assert.throws(() => createLocalIdentityProvider(), /restricted/);
  assert.throws(() => createLocalIdentityProvider({mode: 'production'}), /restricted/);
  const local = createLocalIdentityProvider({mode: 'test', ttlMs: 20, now: () => clock});
  const token = local.issue('synthetic');
  assert.equal((await local.verify(request(token))).subject, 'synthetic');
  await assert.rejects(local.verify({...request(token), socket: {remoteAddress: '203.0.113.1'}}), {status: 401});
  await assert.rejects(local.verify({...request(token), socket: {remoteAddress: undefined}}), {status: 401});
  await assert.rejects(local.verify(request('viewer')) , {status: 401});
  local.revoke(token);
  await assert.rejects(local.verify(request(token)), {status: 401});
  const expiring = local.issue('synthetic');
  clock += 21;
  await assert.rejects(local.verify(request(expiring)), {status: 401});
});

test('unauthenticated HTTP and unprovisioned identities fail closed without detail leaks', async () => {
  for (const headers of [{}, {authorization: 'Bearer made-up'}, {authorization: `Bearer ${identityProvider.issue('unprovisioned')}`}]) {
    const response = await fetch(`${base}/?organizationId=${A}`, {headers});
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.deepEqual(await response.json(), {error: 'unauthenticated'});
  }
});

test('verified issuer/subject mapping ignores client user and role claims', async () => {
  const forged = createAuthorization({pool, identityProvider: {verify: async () => ({issuer: 'different-issuer', subject: 'admin', userId: users.admin, role: 'admin'})}});
  await assert.rejects(forged.run(request(tokens.admin), {organizationId: A, permission: 'inventory:read'}, () => {}), {status: 401});
  await assert.rejects(auth.run({...request(tokens.viewer), headers: {...request(tokens.viewer).headers, 'x-user-id': users.admin, 'x-role': 'admin'}}, {organizationId: A, permission: 'equipment:write'}, () => {}), {status: 403});
});

test('complete role matrix agrees between JavaScript and PostgreSQL; unknown permissions deny', async () => {
  const permissions = [...new Set(Object.values(ROLE_PERMISSIONS).flat()), 'unknown:permission'];
  for (const role of Object.keys(ROLE_PERMISSIONS)) {
    await run(role, A, 'inventory:read', async context => {
      for (const permission of permissions) {
        const result = await context.query('SELECT auth_has_permission($1) AS allowed', [permission]);
        assert.equal(result.rows[0].allowed, permits(role, permission), `${role}: ${permission}`);
      }
    });
    for (const permission of permissions) {
      if (permits(role, permission)) await run(role, A, permission, async () => {});
      else await assert.rejects(run(role, A, permission, () => assert.fail('unauthorized callback ran')), {status: 403});
    }
  }
  assert.equal(permits('toString', 'inventory:read'), false);
});

test('HTTP membership and row scoping deny cross-tenant reads and writes, including admins', async () => {
  const headers = who => ({authorization: `Bearer ${tokens[who]}`, 'x-role': 'admin', 'x-organization-id': B});
  for (const who of ['viewer', 'operator', 'admin']) {
    const own = await fetch(`${base}/?organizationId=${A}`, {headers: headers(who)});
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), [{id: EA, organization_id: A}]);
    for (const method of ['GET', 'PATCH']) {
      const otherTenant = await fetch(`${base}/?organizationId=${B}&id=${EB}`, {method, headers: headers(who)});
      assert.equal(otherTenant.status, 403);
      const hiddenRow = await fetch(`${base}/?organizationId=${A}&id=${EB}`, {method, headers: headers(who)});
      assert.equal(hiddenRow.status, who === 'viewer' && method === 'PATCH' ? 403 : 404);
    }
  }
  const ownWrite = await fetch(`${base}/?organizationId=${A}&id=${EA}`, {method: 'PATCH', headers: headers('operator')});
  assert.equal(ownWrite.status, 200);
  const other = await owner('SELECT note, version FROM equipment WHERE id = $1', [EB]);
  assert.deepEqual(other.rows, [{note: null, version: 0}]);
});

test('database RLS protects every core table, cross-tenant INSERT/UPDATE/DELETE, and user records', async () => {
  await run('admin', A, 'inventory:read', async context => {
    for (const table of ['organization', 'facility', 'ward', 'location', 'equipment_type', 'equipment', 'equipment_observation', 'equipment_event']) {
      const result = await context.query(`SELECT count(*)::int AS count FROM ${table}`);
      assert.equal(result.rows[0].count, 1, table);
    }
    assert.equal((await context.query('SELECT count(*)::int AS count FROM auth_user')).rows[0].count, 1);
    assert.equal((await context.query('SELECT count(*)::int AS count FROM auth_membership')).rows[0].count, 1);
    assert.equal((await context.query('DELETE FROM equipment WHERE id = $1 RETURNING id', [EB])).rows.length, 0);
    assert.equal((await context.query("UPDATE equipment SET note = 'leak', version = version + 1 WHERE id = $1 RETURNING id", [EB])).rows.length, 0);
  });
  await assert.rejects(run('admin', A, 'equipment:manage', context => context.query(
    "INSERT INTO equipment(organization_id, external_id, name, equipment_type_id, location_id, status, provenance) VALUES ($1, 'LEAK', 'Synthetic denied', $2, $3, 'available', 'synthetic-test')", [B, TB, LB]
  )), /row-level security/);
  await assert.rejects(run('viewer', A, 'inventory:read', context => context.query(
    "INSERT INTO equipment(organization_id, external_id, name, equipment_type_id, location_id, status, provenance) VALUES ($1, 'DENIED', 'Synthetic denied', $2, $3, 'available', 'synthetic-test')", [A, TA, LA]
  )), /row-level security/);
  await assert.rejects(run('admin', A, 'membership:manage', context => context.query("UPDATE auth_membership SET role = 'admin'")), /permission denied/);
  await run('admin', A, 'audit:read', async context => {
    assert.equal((await context.query("UPDATE equipment_event SET actor = 'rewrite' RETURNING id")).rows.length, 0);
    assert.equal((await context.query('DELETE FROM equipment_event RETURNING id')).rows.length, 0);
  });
});

test('missing context returns no rows and transaction-local context never leaks on reuse or failure', async () => {
  let escaped;
  await run('admin', A, 'inventory:read', async context => { escaped = context; });
  assert.throws(() => escaped.query('SELECT 1'), /ended/);
  await assert.rejects(run('operator', A, 'equipment:write', async context => {
    await context.query("UPDATE equipment SET note = 'must-rollback', version = version + 1 WHERE id = $1", [EA]);
    throw new Error('synthetic-work-failure');
  }), /synthetic-work-failure/);
  const client = await pool.connect();
  try {
    assert.equal((await client.query('SELECT count(*)::int AS count FROM equipment')).rows[0].count, 0);
    await assert.rejects(client.query("INSERT INTO organization(name) VALUES ('denied')"), /row-level security/);
  } finally { client.release(); }
  const row = await owner('SELECT note FROM equipment WHERE id = $1', [EA]);
  assert.equal(row.rows[0].note, 'synthetic-http-edit');
  await assert.rejects(run('admin', "' OR true --", 'inventory:read', () => {}), {status: 403});
});

test('membership revocation, role changes and disabled users take effect on existing sessions', async () => {
  await owner('UPDATE auth_membership SET active = false WHERE user_id = $1', [users.operator]);
  await assert.rejects(run('operator', A, 'inventory:read', () => {}), {status: 403});
  await owner("UPDATE auth_membership SET active = true, role = 'viewer' WHERE user_id = $1", [users.operator]);
  await assert.rejects(run('operator', A, 'equipment:write', () => {}), {status: 403});
  await run('operator', A, 'inventory:read', async () => {});
  await owner('UPDATE auth_user SET active = false WHERE id = $1', [users.operator]);
  await assert.rejects(run('operator', A, 'inventory:read', () => {}), {status: 401});
});

test('cleanup failures discard a connection, and unexpected HTTP failures hide internals', async () => {
  let released;
  const failAuth = createAuthorization({identityProvider, pool: {connect: async () => ({
    query: async statement => {
      if (statement === 'BEGIN') return {};
      if (statement === 'ROLLBACK') throw new Error('broken connection');
      throw new Error('private SQL failure');
    }, release: error => { released = error; }
  })}});
  await assert.rejects(failAuth.run(request(tokens.admin), {organizationId: A, permission: 'inventory:read'}, () => {}), /private SQL failure/);
  assert.match(released.message, /broken connection/);
  let status, payload;
  writeAuthError({writeHead: code => { status = code; }, end: body => { payload = body; }}, new Error('secret SQL'));
  assert.equal(status, 500);
  assert.deepEqual(JSON.parse(payload), {error: 'internal_error'});
});

test('runtime refuses privileged database connections instead of silently bypassing RLS', async () => {
  const privileged = createAuthorization({identityProvider, pool: {connect: () => connect(null)}});
  await assert.rejects(privileged.run(request(tokens.admin), {organizationId: A, permission: 'inventory:read'}, () => assert.fail('privileged callback ran')), /Unsafe runtime database role/);
});

test('auth migration rolls back cleanly and can be reapplied', async () => {
  const client = await connect(null);
  try {
    await db.exec(sql('../migrations/0001_auth.down.sql'));
    assert.equal((await client.query("SELECT to_regclass('public.auth_user') AS present")).rows[0].present, null);
    assert.equal((await client.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.equipment'::regclass")).rows[0].relrowsecurity, false);
    await db.exec(sql('../migrations/0001_auth.up.sql'));
  } finally { client.release(); }
});
