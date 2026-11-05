import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, isAbsolute} from 'node:path';
import {randomUUID, randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {once} from 'node:events';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import {createAuthorization} from '../../auth/index.mjs';
import {createSupplies} from '../index.mjs';
import {createSuppliesHandler} from '../http.mjs';
import {quantity, stockCommand} from '../../../../packages/domain/supplies/index.mjs';

const sql = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const A = randomUUID(), B = randomUUID(), user = randomUUID(), viewer = randomUUID(), operator = randomUUID();
let cluster, admin, pool, dir, supplies, sku, otherSku, insertGate, afterQuery;
const authRequest = who => ({who});
const runtimePool = {async connect() {
  const client = await pool.connect();
  await client.query('SET ROLE sv_supplies_test_runtime');
  return {query: async (statement, parameters) => {
    if (insertGate && statement.startsWith('INSERT INTO public.supply_stock_transaction')) await insertGate();
    const result = await client.query(statement, parameters);
    if (afterQuery) await afterQuery(statement, parameters, result, client.processID);
    return result;
  }, release: error => client.release(error)};
}};
const authorization = createAuthorization({pool: runtimePool, identityProvider: {verify: async request => {
  const subject = request?.who || request?.headers?.['x-synthetic-test-user'];
  return subject ? {issuer: 'synthetic-test', subject} : null;
}}});
const manager = authRequest('manager');
const post = (bin, options = {}) => supplies.postStock(manager, A, {
  binId: bin.id, kind: 'restock', delta: '10', expectedVersion: 0, idempotencyKey: randomUUID(),
  source: 'synthetic-test', reason: 'Synthetic restock', ...options
});
const newBin = () => supplies.createBin(manager, A, {skuId: sku.id, locationId: A, code: randomUUID()});
const balance = async bin => (await admin.query('SELECT quantity,version FROM supply_bin_stock WHERE bin_id=$1', [bin.id])).rows[0];
function rendezvous(count) {
  let arrived = 0, open, timer;
  const ready = new Promise((resolve, reject) => { open = resolve;
    timer = setTimeout(() => reject(new Error('Concurrent requests did not reach SQL insertion barrier')), 15000); });
  return async () => { if (++arrived === count) { clearTimeout(timer); open(); } await ready; };
}

before(async () => {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  dir = mkdtempSync(join(tmpdir(), 'sv009-postgres-'));
  const password = randomBytes(24).toString('hex');
  cluster = new EmbeddedPostgres({databaseDir: dir, port, user: 'sv_test_owner', password, persistent: true,
    createPostgresUser: false, postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => {}, onError: () => {}});
  await cluster.initialise(); await cluster.start();
  const config = {host: '127.0.0.1', port, user: 'sv_test_owner', password, database: 'postgres'};
  admin = new pg.Client(config); await admin.connect();
  pool = new pg.Pool({...config, max: 24, connectionTimeoutMillis: 10000, query_timeout: 20000});
  // Fixture bootstraps synthetic core rows before FORCE RLS is installed. No core/auth file edits.
  await admin.query(sql('../../db/migrations/0001_core.up.sql'));
  for (const id of [A, B]) {
    await admin.query('INSERT INTO organization(id,name) VALUES ($1,$2)', [id, 'Synthetic organization']);
    await admin.query('INSERT INTO facility(id,organization_id,name) VALUES ($1,$1,$2)', [id, 'Synthetic facility']);
    await admin.query('INSERT INTO ward(id,organization_id,facility_id,name) VALUES ($1,$1,$1,$2)', [id, 'Synthetic ward']);
    await admin.query("INSERT INTO location(id,organization_id,ward_id,external_key,name,kind) VALUES ($1,$1,$1,'synthetic-store','Synthetic store','store')", [id]);
  }
  await admin.query(sql('../../auth/migrations/0001_auth.up.sql'));
  for (const [id, subject, role] of [[user, 'manager', 'supply_manager'], [viewer, 'viewer', 'viewer'], [operator, 'operator', 'operator']]) {
    await admin.query("INSERT INTO auth_user(id,issuer,subject) VALUES ($1,'synthetic-test',$2)", [id, subject]);
    await admin.query('INSERT INTO auth_membership(organization_id,user_id,role) VALUES ($1,$2,$3)', [A, id, role]);
  }
  // Table/trigger owner is deliberately NOT a superuser and cannot bypass FORCE RLS.
  await admin.query(`CREATE ROLE sv_supplies_schema_owner NOSUPERUSER NOBYPASSRLS NOLOGIN;
    GRANT USAGE, CREATE ON SCHEMA public TO sv_supplies_schema_owner;
    GRANT REFERENCES ON organization,location,auth_user TO sv_supplies_schema_owner;
    GRANT SELECT ON auth_user,auth_membership TO sv_supplies_schema_owner;
    SET ROLE sv_supplies_schema_owner;`);
  await admin.query(sql('../migrations/0001_supplies.up.sql'));
  await admin.query('RESET ROLE');
  await admin.query(`CREATE ROLE sv_supplies_test_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
    GRANT USAGE ON SCHEMA public TO sv_supplies_test_runtime;
    GRANT SELECT ON auth_user,auth_membership,organization,facility,ward,location,equipment_type,equipment,equipment_event,equipment_observation TO sv_supplies_test_runtime;
    GRANT EXECUTE ON FUNCTION auth_resolve_identity(text,text) TO sv_supplies_test_runtime;
    GRANT SELECT ON supply_sku,supply_bin,supply_bin_stock,supply_stock_transaction TO sv_supplies_test_runtime;
    GRANT INSERT ON supply_sku,supply_bin,supply_stock_transaction TO sv_supplies_test_runtime;`);
  supplies = createSupplies({authorization});
  sku = await supplies.createSku(manager, A, {code: 'SYN-GLOVES', name: 'Synthetic gloves', unit: 'each'});
  otherSku = (await admin.query("INSERT INTO supply_sku(organization_id,code,name,unit) VALUES ($1,'OTHER','Synthetic other','box') RETURNING *", [B])).rows[0];
  console.log('SV-009 native SQL engine:', (await admin.query('SELECT version() AS version')).rows[0].version);
});
after(async () => {
  await pool?.end(); await admin?.end();
  // The wrapper's Windows stop resolves before taskkill has released all files.
  const exited = cluster?.process && cluster.process.exitCode === null ? once(cluster.process, 'exit') : Promise.resolve();
  await cluster?.stop(); await exited;
  // Delete only this fixture's verified temporary directory after stopping the server.
  if (dir) { const rel = relative(realpathSync(tmpdir()), realpathSync(dir));
    if (!rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('sv009-postgres-')) rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); }
});

test('exact declared-unit decimals and invalid command boundaries', () => {
  assert.equal(quantity('1.25'), '1.250'); assert.equal(quantity('-0.125'), '-0.125');
  for (const value of [1, 'NaN', '1e3', '0.0001', '1000000000000', '01', '-0.0000']) assert.throws(() => quantity(value), {status: 400});
  assert.throws(() => stockCommand({delta: '-1', kind: 'restock'}), {status: 400});
});
test('declared units, scoped bins, fractional adjustments, immutable ledger and serialized equipment separation', async () => {
  const bin = await newBin();
  assert.deepEqual(await balance(bin), {quantity: '0.000', version: 0});
  const first = await post(bin, {delta: '10.125'});
  assert.equal(first.actor_id, user); assert.equal(first.quantity_after, '10.125');
  await post(bin, {kind: 'adjustment', delta: '-0.125', expectedVersion: 1, reason: 'Synthetic count correction'});
  assert.deepEqual(await balance(bin), {quantity: '10.000', version: 2});
  assert.equal((await supplies.listBins(authRequest('viewer'), A)).find(row => row.id === bin.id).unit, 'each');
  const history = await supplies.history(manager, A, bin.id);
  assert.equal(history.length, 2); assert.deepEqual(history.map(t => t.version_after).sort(), [1, 2]);
  assert.equal((await admin.query('SELECT count(*)::int AS count FROM equipment')).rows[0].count, 0);
  for (const statement of ["UPDATE supply_stock_transaction SET reason='rewrite'", 'DELETE FROM supply_stock_transaction', "UPDATE supply_sku SET unit='box'", "UPDATE supply_bin SET code='changed'"])
    await assert.rejects(admin.query(statement), /append-only/);
});
test('replays return original transaction, reject changed payloads, and remain safe after later edits', async () => {
  const bin = await newBin(), key = randomUUID();
  const first = await post(bin, {idempotencyKey: key});
  await post(bin, {expectedVersion: 1});
  const again = await post(bin, {idempotencyKey: key});
  assert.equal(again.id, first.id); assert.equal(again.replayed, true);
  for (const changed of [{delta: '11'}, {reason: 'Changed reason'}, {source: 'other'}, {expectedVersion: 2}, {correlationId: 'other'}])
    await assert.rejects(post(bin, {idempotencyKey: key, ...changed}), {status: 409, code: 'idempotency_conflict'});
  assert.deepEqual(await balance(bin), {quantity: '20.000', version: 2});
});
test('16 concurrent identical requests commit exactly one SQL transaction', async () => {
  const bin = await newBin(), key = randomUUID();
  insertGate = rendezvous(16);
  let rows;
  try { rows = await Promise.all(Array.from({length: 16}, () => post(bin, {idempotencyKey: key}))); }
  finally { insertGate = null; }
  assert.equal(new Set(rows.map(row => row.id)).size, 1);
  assert.equal(rows.filter(row => !row.replayed).length, 1);
  assert.deepEqual(await balance(bin), {quantity: '10.000', version: 1});
  assert.equal((await supplies.history(manager, A, bin.id)).length, 1);
});
test('overlapping retry after an empty key lookup replays the committed transaction; changed payload still conflicts', async () => {
  const server = createHttpServer(createSuppliesHandler({supplies}));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/organizations/${A}/supplies/transactions`;
  try {
    for (const changedPayload of [false, true]) {
      const bin = await newBin(), key = randomUUID();
      let reached, release, pausedPid, winnerPid, intercepted = false, timer;
      const paused = new Promise((resolve, reject) => {
        reached = resolve;
        timer = setTimeout(() => reject(new Error('Retry never reached empty SQL key lookup')), 15000);
      });
      const resume = new Promise(resolve => { release = resolve; });
      afterQuery = async (statement, parameters, result, pid) => {
        if (!statement.startsWith('SELECT * FROM public.supply_stock_transaction WHERE organization_id=') || parameters[1] !== key) return;
        if (!intercepted) {
          intercepted = true;
          assert.equal(result.rows.length, 0);
          pausedPid = pid;
          clearTimeout(timer); reached();
          await resume;
        } else if (result.rows.length === 0) winnerPid = pid;
      };
      const command = {binId: bin.id, kind: 'restock', delta: '10', expectedVersion: 0, idempotencyKey: key,
        source: 'synthetic-overlap', reason: 'Synthetic overlapping retry'};
      const send = input => fetch(url, {method: 'POST', headers: {'x-synthetic-test-user': 'manager'},
        body: JSON.stringify(input), signal: AbortSignal.timeout(20000)});
      // B has executed a real empty lookup and remains in its own SQL transaction.
      const pending = send({...command, delta: changedPayload ? '11' : '10'});
      try {
        await paused;
        // A commits on another backend before B is allowed to read the balance.
        const winner = await send(command);
        assert.equal(winner.status, 201);
        const saved = await winner.json();
        assert.notEqual(pausedPid, winnerPid, 'competing requests must use separate native PostgreSQL sessions');
        assert.deepEqual(await balance(bin), {quantity: '10.000', version: 1});
        release();
        const retry = await pending;
        assert.equal(retry.status, changedPayload ? 409 : 200);
        const replayed = await retry.json();
        if (changedPayload) assert.equal(replayed.error, 'idempotency_conflict');
        else { assert.equal(replayed.id, saved.id); assert.equal(replayed.replayed, true); }
        assert.deepEqual(await balance(bin), {quantity: '10.000', version: 1});
        assert.equal((await supplies.history(manager, A, bin.id)).length, 1);
      } finally {
        clearTimeout(timer); release(); afterQuery = null;
        await pending.catch(() => {});
      }
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('concurrent distinct requests with same version yield one commit and one 409; explicit retry preserves both deltas', async () => {
  const bin = await newBin(); insertGate = rendezvous(2);
  let results;
  try { results = await Promise.allSettled([post(bin, {delta: '3'}), post(bin, {delta: '7'})]); }
  finally { insertGate = null; }
  const winner = results.find(r => r.status === 'fulfilled').value;
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  await post(bin, {delta: winner.delta === '3.000' ? '7' : '3', expectedVersion: 1});
  assert.deepEqual(await balance(bin), {quantity: '10.000', version: 2});
  assert.equal((await supplies.history(manager, A, bin.id)).length, 2);
});
test('real lock contention blocks until rollback, then a competing transaction commits once', async () => {
  const bin = await newBin();
  await admin.query('BEGIN');
  await admin.query('SELECT * FROM supply_bin_stock WHERE bin_id=$1 FOR UPDATE', [bin.id]);
  let done = false;
  const pending = post(bin).finally(() => { done = true; });
  try {
    const deadline = Date.now() + 10000; let waiting = false;
    while (Date.now() < deadline && !waiting) {
      await admin.query('SELECT pg_stat_clear_snapshot()');
      waiting = (await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO public.supply_stock_transaction%') AS waiting")).rows[0].waiting;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, 'separate SQL session must wait on the held balance lock');
    assert.equal(done, false);
  } finally { await admin.query('ROLLBACK'); }
  await pending;
  assert.deepEqual(await balance(bin), {quantity: '10.000', version: 1});
});
test('atomic SQL rollback rejects negative balances, stale versions, forged balances, and failed ledger inserts', async () => {
  const bin = await newBin();
  await assert.rejects(post(bin, {kind: 'adjustment', delta: '-1'}), {status: 400});
  await assert.rejects(post(bin, {expectedVersion: 1}), {status: 409});
  assert.deepEqual(await balance(bin), {quantity: '0.000', version: 0});
  assert.equal((await supplies.history(manager, A, bin.id)).length, 0);
  await assert.rejects(admin.query(`INSERT INTO supply_stock_transaction(organization_id,bin_id,kind,delta,quantity_before,expected_version,actor_id,source,reason,idempotency_key)
    VALUES ($1,$2,'restock',1,100,0,$3,'test','forged',$4)`, [A, bin.id, user, randomUUID()]), {code: '40001'});
  assert.deepEqual(await balance(bin), {quantity: '0.000', version: 0});
  // Failure after the trigger changed stock still rolls back both rows in auth's transaction.
  await assert.rejects(authorization.run(manager, {organizationId: A, permission: 'supplies:write'}, async c => {
    await c.query(`INSERT INTO supply_stock_transaction(organization_id,bin_id,kind,delta,quantity_before,expected_version,actor_id,source,reason,idempotency_key)
      VALUES ($1,$2,'restock',1,0,0,$3,'test','rollback',$4)`, [A, bin.id, user, randomUUID()]);
    throw new Error('synthetic failure after ledger insert');
  }), /synthetic failure/);
  assert.deepEqual(await balance(bin), {quantity: '0.000', version: 0});
  assert.equal((await supplies.history(manager, A, bin.id)).length, 0);
});
test('existing auth roles, tenant RLS, composite FKs and least privilege deny cross-tenant and forged writes', async () => {
  const bin = await newBin();
  await assert.rejects(supplies.listBins(null, A), {status: 401});
  await assert.rejects(supplies.listBins(manager, B), {status: 403});
  for (const who of ['viewer', 'operator']) await assert.rejects(supplies.postStock(authRequest(who), A, {}), {status: 403});
  await assert.rejects(supplies.history(authRequest('viewer'), A, bin.id), {status: 403});
  await assert.rejects(supplies.createBin(manager, A, {skuId: otherSku.id, locationId: A, code: 'cross-sku'}), {status: 400});
  await assert.rejects(supplies.createBin(manager, A, {skuId: sku.id, locationId: B, code: 'cross-location'}), {status: 400});
  await authorization.run(manager, {organizationId: A, permission: 'supplies:write'}, async c => {
    assert.equal((await c.query('SELECT * FROM supply_sku WHERE organization_id=$1', [B])).rows.length, 0);
  });
  await assert.rejects(authorization.run(manager, {organizationId: A, permission: 'supplies:write'}, c => c.query('UPDATE supply_bin_stock SET quantity=100')), /permission denied/);
  await assert.rejects(authorization.run(manager, {organizationId: A, permission: 'supplies:write'}, c => c.query('INSERT INTO supply_bin_stock(organization_id,bin_id) VALUES ($1,$2)', [A, randomUUID()])), /permission denied/);
  await assert.rejects(authorization.run(manager, {organizationId: A, permission: 'supplies:write'}, c => c.query(
    "INSERT INTO supply_stock_transaction(organization_id,bin_id,kind,delta,quantity_before,expected_version,actor_id,source,reason,idempotency_key) VALUES ($1,$2,'restock',1,0,0,$3,'test','forged actor',$4)", [A, bin.id, viewer, randomUUID()])), /row-level security/);
});
test('HTTP adapter traverses real auth and SQL, returns replay/conflict status and safe errors', async () => {
  const bin = await newBin(), key = randomUUID();
  const server = createHttpServer(createSuppliesHandler({supplies}));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/organizations/${A}/supplies`;
  const command = {binId: bin.id, kind: 'restock', delta: '2.5', expectedVersion: 0, idempotencyKey: key, source: 'synthetic-http', reason: 'Synthetic restock'};
  const send = (input = command, who = 'manager') => fetch(`${base}/transactions`, {method: 'POST', headers: {'x-synthetic-test-user': who}, body: JSON.stringify(input)});
  try {
    assert.equal((await fetch(`${base}/bins`)).status, 401);
    assert.equal((await send(command, 'viewer')).status, 403);
    const first = await send(); assert.equal(first.status, 201); const saved = await first.json();
    const retry = await send(); assert.equal(retry.status, 200); assert.equal((await retry.json()).id, saved.id);
    assert.equal((await send({...command, delta: '3'})).status, 409);
    assert.equal((await send({...command, delta: '0.00001'})).status, 400);
    const read = await fetch(`${base}/bins`, {headers: {'x-synthetic-test-user': 'viewer'}});
    assert.equal(read.status, 200); assert.equal((await read.json()).find(row => row.id === bin.id).quantity, '2.500');
    assert.equal((await fetch(`${base}/transactions`, {method: 'POST', body: '{bad'})).status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('task-local migration rolls back without changing auth/core and reapplies', async () => {
  await admin.query('BEGIN'); await admin.query(sql('../migrations/0001_supplies.down.sql')); await admin.query('COMMIT');
  assert.equal((await admin.query("SELECT to_regclass('public.supply_sku') AS table_name")).rows[0].table_name, null);
  assert.equal((await admin.query("SELECT to_regclass('public.auth_user') IS NOT NULL AND to_regclass('public.equipment') IS NOT NULL AS preserved")).rows[0].preserved, true);
  await admin.query('BEGIN'); await admin.query('SET LOCAL ROLE sv_supplies_schema_owner');
  await admin.query(sql('../migrations/0001_supplies.up.sql')); await admin.query('COMMIT');
});
