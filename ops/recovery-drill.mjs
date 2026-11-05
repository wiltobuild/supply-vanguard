import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, isAbsolute, join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
export const marker = 'sv-ops-disposable';
const tools = ['psql', 'pg_dump', 'pg_restore'];
export function drillConfig(env, args) {
  if (args.length !== 1 || args[0] !== '--confirm-disposable-synthetic') throw Error('Required: --confirm-disposable-synthetic');
  if (env.NODE_ENV === 'production') throw Error('Production mode refused');
  // Do not silently route through an inherited URL, service file, socket or production alias.
  if (env.DATABASE_URL || env.PGSERVICE || env.PGSERVICEFILE || env.PGOPTIONS || env.PGHOSTADDR) throw Error('Remove DATABASE_URL/PGSERVICE/PGSERVICEFILE/PGOPTIONS/PGHOSTADDR before the drill');
  if (env.OPS_PGHOST !== '127.0.0.1') throw Error('Set OPS_PGHOST=127.0.0.1 for an existing disposable local cluster');
  if (!/^\d+$/.test(env.OPS_PGPORT ?? '') || Number(env.OPS_PGPORT) < 1024 || Number(env.OPS_PGPORT) > 65535) throw Error('Set OPS_PGPORT to the disposable cluster port (1024..65535)');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(env.OPS_PGUSER ?? '')) throw Error('Set OPS_PGUSER to an existing disposable-cluster owner; no roles are created');
  return {host: env.OPS_PGHOST, port: env.OPS_PGPORT, user: env.OPS_PGUSER};
}

export function findTools(env = process.env) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const directories = env.PG_BIN ? [env.PG_BIN] : (env.PATH ?? '').split(delimiter);
  const directory = directories.find(dir => dir && tools.every(tool => existsSync(join(dir, tool + suffix))));
  if (!directory) throw Error('PostgreSQL psql, pg_dump and pg_restore unavailable; install matching PostgreSQL 16+ client tools in an approved environment and set PG_BIN');
  return Object.fromEntries(tools.map(tool => [tool, join(directory, tool + suffix)]));
}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function archiveCleanupTarget(directory, temporaryRoot = tmpdir()) {
  const target = resolve(directory), child = relative(resolve(temporaryRoot), target);
  if (isAbsolute(child) || !/^sv-ops-recovery-[^\\/]+$/.test(child)) throw Error('Refusing cleanup outside the exact drill temporary directory');
  return target;
}
export function verifySnapshot(before, after) {
  if (digest(after) !== digest(before)) throw Error('Restored data or security/schema metadata differs');
  assert.equal(before.tables.equipment.length, 8, 'Expected unchanged synthetic core seed');
  assert.equal(before.tables.location.length, 10);
  for (const name of ['equipment_observation', 'equipment_event', 'ingestion_nonce', 'ingestion_receipt', 'ingestion_dead_letter']) {
    assert.equal(before.tables[name].length, 1, `Missing synthetic evidence: ${name}`);
  }
  const obs = before.tables.equipment_observation[0], receipt = before.tables.ingestion_receipt[0];
  assert.equal(receipt.observation_id, obs.id);
  assert.equal(receipt.organization_id, obs.organization_id);
  assert.equal(receipt.idempotency_key, obs.idempotency_key);
  assert.ok(Date.parse(obs.observed_at) < Date.parse(obs.received_at), 'Physical and receipt time must remain distinct');
  return {dataSha256: digest(before.tables), metadataSha256: digest(before.metadata), tableCount: Object.keys(before.tables).length};
}

const fixtureSql = `
INSERT INTO auth_user(id, issuer, subject) VALUES ('00000000-0000-4000-8000-00000000f017', 'urn:sv:ops:synthetic', 'recovery-fixture');
INSERT INTO auth_membership(organization_id, user_id, role)
  SELECT id, '00000000-0000-4000-8000-00000000f017', 'operator' FROM organization;
INSERT INTO equipment_observation(id, organization_id, equipment_id, location_id, observed_at, received_at, source, actor, idempotency_key)
  SELECT '00000000-0000-4000-8000-00000000f018', e.organization_id, e.id, l.id,
    '2026-11-05T10:00:00Z', '2026-11-05T10:01:00Z', 'simulator', 'synthetic-recovery', 'ops-synthetic-observation'
  FROM equipment e JOIN location l ON l.organization_id=e.organization_id AND l.external_key='room-101'
  WHERE e.external_id='EQ-001';
INSERT INTO equipment_event(organization_id, equipment_id, kind, actor, source, recorded_at, idempotency_key, before_state, after_state)
  SELECT organization_id, id, 'admin', 'synthetic-recovery', 'synthetic-fixture', '2026-11-05T10:02:00Z',
    'ops-synthetic-event', to_jsonb(e), to_jsonb(e) FROM equipment e WHERE external_id='EQ-001';
INSERT INTO ingestion_nonce(organization_id, source_id, nonce, received_at)
  SELECT organization_id, 'ops-synthetic', 'ops-synthetic-nonce', received_at FROM equipment_observation;
INSERT INTO ingestion_receipt(organization_id, idempotency_key, observation_id, source_id, user_id, fingerprint, received_at)
  SELECT organization_id, idempotency_key, id, 'ops-synthetic', '00000000-0000-4000-8000-00000000f017', repeat('a',64), received_at FROM equipment_observation;
INSERT INTO ingestion_dead_letter(organization_id, user_id, received_at, reason, envelope_digest)
  SELECT id, '00000000-0000-4000-8000-00000000f017', '2026-11-05T10:03:00Z', 'replay', repeat('b',64) FROM organization;
`;

export function runDrill({env = process.env, args = process.argv.slice(2)} = {}) {
  const config = drillConfig(env, args), binaries = findTools(env);
  // Explicit routing overrides inherited libpq settings. Never echo child errors or connection strings.
  const childEnv = {...env, PGHOST: config.host, PGPORT: config.port, PGUSER: config.user,
    PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'sv-ops-synthetic-recovery',
    PGSSLMODE: 'disable', PGTARGETSESSIONATTRS: 'read-write'};
  const run = (tool, argv, input) => {
    const result = spawnSync(binaries[tool], argv, {env: childEnv, input, encoding: 'utf8',
      windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024});
    if (result.error || result.status !== 0) throw Error(`${tool} failed (exit ${result.status ?? 'unavailable'}); inspect the local cluster privately; no pass recorded`);
    return result.stdout.trim();
  };
  const query = (database, sql) => run('psql', ['-X', '--no-password', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', database], sql);
  const preflight = JSON.parse(query('postgres', `SELECT json_build_object('marker', current_setting('cluster_name'),
    'version', current_setting('server_version_num')::integer, 'superuser', rolsuper) FROM pg_roles WHERE rolname=current_user;`));
  if (preflight.marker !== marker || !preflight.superuser || preflight.version < 160000) throw Error('Requires PostgreSQL 16+, existing local superuser and cluster_name=sv-ops-disposable; no database created');
  const serverMajor = Math.floor(preflight.version / 10000);
  for (const tool of tools) {
    const major = Number(run(tool, ['--version']).match(/PostgreSQL\) (\d+)/)?.[1]);
    if (major !== serverMajor) throw Error('Use the same PostgreSQL major version for server and all recovery clients');
  }
  const suffix = randomUUID().replaceAll('-', '');
  const source = `sv_ops_src_${suffix}`, target = `sv_ops_restore_${suffix}`;
  const directory = mkdtempSync(join(tmpdir(), 'sv-ops-recovery-'));
  const archive = join(directory, 'synthetic.dump');
  const created = [];
  let evidence, failure;
  const snapshot = database => {
    const names = JSON.parse(query(database, `SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public';`));
    const tables = {};
    for (const name of names) {
      if (!/^[a-z_]+$/.test(name)) throw Error('Unexpected fixture table');
      tables[name] = JSON.parse(query(database, `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),'[]') FROM public.${name} t;`));
    }
    const metadata = JSON.parse(query(database, `SELECT jsonb_build_object(
      'rls', (SELECT jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'),
      'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='public'),
      'constraints', (SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
      'triggers', (SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal),
      'functions', (SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY p.proname,p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.classid='pg_proc'::regclass AND d.deptype='e'))
    );`));
    return {tables, metadata};
  };
  try {
    const existing = query('postgres', `SELECT count(*) FROM pg_database WHERE datname IN ('${source}','${target}');`);
    if (existing !== '0') throw Error('Generated drill database already exists; no existing database will be touched');
    for (const database of [source, target]) {
      // Track before the command so timeout/uncertain CREATE outcomes still get cleanup.
      created.push(database);
      query('postgres', `CREATE DATABASE ${database} TEMPLATE template0;`);
    }
    // Unchanged migrations; seed precedes FORCE RLS only in this disposable exercise.
    // This is not a repair or test of the independent SV-019 bootstrap sequence.
    const files = ['services/api/db/migrations/0001_core.up.sql', 'services/api/db/seed/seed.sql',
      'services/api/auth/migrations/0001_auth.up.sql', 'services/ingestion/migrations/0001_ingestion.up.sql'];
    query(source, `BEGIN;\n${files.map(file => readFileSync(new URL(file, root), 'utf8')).join('\n')}\n${fixtureSql}\nCOMMIT;`);
    const before = snapshot(source);
    run('pg_dump', ['--no-password', '--format=custom', '--file', archive, '--dbname', source]);
    const archiveSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
    run('pg_restore', ['--no-password', '--exit-on-error', '--single-transaction', '--dbname', target, archive]);
    const after = snapshot(target);
    const integrity = verifySnapshot(before, after);
    // Prove restored append-only triggers and replay/idempotency uniqueness still execute.
    query(target, `DO $$ BEGIN
      BEGIN UPDATE equipment_observation SET actor='forbidden'; RAISE EXCEPTION 'append-only assertion failed'; EXCEPTION WHEN restrict_violation THEN NULL; END;
      BEGIN DELETE FROM ingestion_dead_letter; RAISE EXCEPTION 'dead-letter assertion failed'; EXCEPTION WHEN restrict_violation THEN NULL; END;
      BEGIN INSERT INTO ingestion_nonce SELECT * FROM ingestion_nonce; RAISE EXCEPTION 'nonce assertion failed'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN INSERT INTO ingestion_receipt SELECT * FROM ingestion_receipt; RAISE EXCEPTION 'receipt assertion failed'; EXCEPTION WHEN unique_violation THEN NULL; END;
    END $$;`);
    verifySnapshot(before, snapshot(target));
    evidence = {state: 'passed', engine: `native PostgreSQL ${serverMajor}`, syntheticOnly: true,
      ...integrity, archiveSha256, checks: ['all public rows', 'physical/receipt timestamps', 'receipt references',
        'RLS flags/policies/ACLs', 'constraints/triggers/functions', 'append-only and replay uniqueness'],
      limitations: ['No runtime-role authorization, hosted restore, PITR, measured RPO/RTO or service rollback demonstrated']};
  } catch (error) { failure = error; }
  const cleanupFailed = [];
  for (const database of created.reverse()) {
    try { query('postgres', `DROP DATABASE IF EXISTS ${database} WITH (FORCE);`); }
    catch { cleanupFailed.push(database); }
  }
  try { rmSync(archiveCleanupTarget(directory), {recursive: true, force: true}); } catch { cleanupFailed.push(directory); }
  if (cleanupFailed.length) throw Error(`Cleanup incomplete: ${cleanupFailed.join(', ')}; stop and ask the disposable-cluster owner to remove these exact drill resources; no pass recorded`);
  if (failure) throw failure;
  return {...evidence, cleanup: 'both generated databases and temporary archive removed'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(runDrill(), null, 2)); }
  catch (error) { console.error(`Recovery drill BLOCKED/FAILED: ${error.message}`); process.exitCode = 1; }
}
