import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, isAbsolute, join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import {inventoryEvidence, loadRecoveryInventory} from './recovery-inventory.mjs';
import {fixtureSetupSql} from './recovery-fixture.mjs';
import {verifySnapshot} from './recovery-integrity.mjs';
import {mismatchDiagnosticLine, retainMismatchDiagnostics} from './recovery-diagnostics.mjs';
export {verifySnapshot} from './recovery-integrity.mjs';

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

export function archiveCleanupTarget(directory, temporaryRoot = tmpdir()) {
  const target = resolve(directory), child = relative(resolve(temporaryRoot), target);
  if (isAbsolute(child) || !/^sv-ops-recovery-[^\\/]+$/.test(child)) throw Error('Refusing cleanup outside the exact drill temporary directory');
  return target;
}
export function runDrill({env = process.env, args = process.argv.slice(2)} = {}) {
  const config = drillConfig(env, args), inventory = loadRecoveryInventory(), binaries = findTools(env);
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
      'rls', (SELECT jsonb_agg(jsonb_build_object('table',c.relname,'enabled',c.relrowsecurity,'forced',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'),
      'indexes', (SELECT jsonb_agg(jsonb_build_object('name',i.relname,'unique',x.indisunique,'valid',x.indisvalid,'definition',pg_get_indexdef(x.indexrelid)) ORDER BY i.relname) FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
      'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='public'),
      'constraints', (SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
      'triggers', (SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal),
      'functions', (SELECT jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'securityDefiner',p.prosecdef,'config',p.proconfig) ORDER BY p.proname,p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.classid='pg_proc'::regclass AND d.deptype='e'))
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
    query(source, fixtureSetupSql(inventory));
    const before = snapshot(source);
    verifySnapshot(before, before, {phase: 'source-fixture'}); // Refuse to archive an incomplete fixture even if restore would match it.
    run('pg_dump', ['--no-password', '--format=custom', '--file', archive, '--dbname', source]);
    const archiveSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
    run('pg_restore', ['--no-password', '--exit-on-error', '--single-transaction', '--dbname', target, archive]);
    const after = snapshot(target);
    const integrity = verifySnapshot(before, after, {phase: 'post-restore'});
    // Prove restored append-only triggers and replay/idempotency uniqueness still execute.
    query(target, `DO $$ BEGIN
      BEGIN UPDATE equipment_observation SET actor='forbidden'; RAISE EXCEPTION 'append-only assertion failed'; EXCEPTION WHEN restrict_violation THEN NULL; END;
      BEGIN DELETE FROM ingestion_dead_letter; RAISE EXCEPTION 'dead-letter assertion failed'; EXCEPTION WHEN restrict_violation THEN NULL; END;
      BEGIN INSERT INTO ingestion_nonce SELECT * FROM ingestion_nonce; RAISE EXCEPTION 'nonce assertion failed'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN INSERT INTO ingestion_receipt SELECT * FROM ingestion_receipt; RAISE EXCEPTION 'receipt assertion failed'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE equipment_command_receipt SET correlation_id='forbidden'; RAISE EXCEPTION 'command receipt assertion failed'; EXCEPTION WHEN restrict_violation THEN NULL; END;
      BEGIN INSERT INTO equipment_command_receipt SELECT * FROM equipment_command_receipt; RAISE EXCEPTION 'command key assertion failed'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE supply_stock_transaction SET reason='forbidden'; RAISE EXCEPTION 'stock history assertion failed'; EXCEPTION WHEN restrict_violation THEN NULL; END;
      BEGIN
        INSERT INTO supply_stock_transaction(organization_id,bin_id,kind,delta,quantity_before,expected_version,actor_id,source,reason,idempotency_key)
          SELECT organization_id,bin_id,'adjustment',1,quantity,99,'00000000-0000-4000-8000-00000000f017','synthetic-fixture','Synthetic rejected conflict','ops-rejected-stock' FROM supply_bin_stock;
        RAISE EXCEPTION 'stock conflict rollback assertion failed';
      EXCEPTION WHEN serialization_failure THEN NULL; END;
      BEGIN UPDATE request_event SET actor='forbidden'; RAISE EXCEPTION 'request event assertion failed'; EXCEPTION WHEN restrict_violation THEN NULL; END;
      BEGIN INSERT INTO item_assignment(organization_id,request_item_id,equipment_id,assigned_by) SELECT organization_id,request_item_id,equipment_id,assigned_by FROM item_assignment; RAISE EXCEPTION 'active assignment assertion failed'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN DELETE FROM location_override_audit; RAISE EXCEPTION 'override audit assertion failed'; EXCEPTION WHEN restrict_violation THEN NULL; END;
      BEGIN
        INSERT INTO location_override(id,organization_id,equipment_id,location_id,observed_at,starts_at,expires_at)
          SELECT '00000000-0000-4000-8000-00000000f051',organization_id,equipment_id,location_id,observed_at,starts_at,expires_at FROM location_override;
        SET CONSTRAINTS location_override_requires_audit IMMEDIATE;
        RAISE EXCEPTION 'missing override audit assertion failed';
      EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN DELETE FROM equipment_hold; RAISE EXCEPTION 'hold deletion assertion failed'; EXCEPTION WHEN restrict_violation THEN NULL; END;
      BEGIN UPDATE equipment_hold SET reason='forbidden'; RAISE EXCEPTION 'hold history assertion failed'; EXCEPTION WHEN restrict_violation THEN NULL; END;
      BEGIN UPDATE equipment_hold SET active=true,cleared_by=NULL,cleared_at=NULL WHERE NOT active; RAISE EXCEPTION 'hold reactivation assertion failed'; EXCEPTION WHEN restrict_violation THEN NULL; END;
      BEGIN
        INSERT INTO equipment_hold(organization_id,equipment_id,kind,placed_by)
          SELECT organization_id,equipment_id,kind,placed_by FROM equipment_hold WHERE active AND kind='dirty';
        RAISE EXCEPTION 'active hold duplicate assertion failed';
      EXCEPTION WHEN unique_violation THEN NULL; END;
      PERFORM set_config('sv.organization_id',(SELECT id::text FROM organization),true);
      PERFORM set_config('sv.user_id','00000000-0000-4000-8000-00000000f017',true);
      BEGIN
        PERFORM clear_equipment_hold((SELECT id FROM equipment_hold WHERE kind='fault' AND active),'user:00000000-0000-4000-8000-00000000f017');
        RAISE EXCEPTION 'wrong-role hold clearance assertion failed';
      EXCEPTION WHEN SQLSTATE 'SV403' THEN IF SQLERRM <> 'sv:wrong_role' THEN RAISE; END IF; END;
      BEGIN
        PERFORM clear_equipment_hold((SELECT id FROM equipment_hold WHERE kind='unknown' AND active),'user:00000000-0000-4000-8000-00000000f017');
        RAISE EXCEPTION 'unconfigured hold clearance assertion failed';
      EXCEPTION WHEN SQLSTATE 'SV422' THEN IF SQLERRM <> 'sv:no_clearance_rule' THEN RAISE; END IF; END;
      BEGIN
        INSERT INTO item_assignment(organization_id,request_item_id,equipment_id,assigned_by)
          SELECT i.organization_id,i.id,h.equipment_id,'synthetic-recovery' FROM request_item i CROSS JOIN equipment_hold h WHERE h.active AND h.kind='fault';
        RAISE EXCEPTION 'held assignment assertion failed';
      EXCEPTION WHEN SQLSTATE 'SV422' THEN IF SQLERRM <> 'sv:equipment_on_hold' THEN RAISE; END IF; END;
      BEGIN
        PERFORM set_config('sv.user_id','00000000-0000-4000-8000-00000000f060',true);
        PERFORM clear_equipment_hold((SELECT id FROM equipment_hold WHERE kind='dirty' AND active),'user:00000000-0000-4000-8000-00000000f060');
        IF (SELECT count(*) FROM equipment_hold WHERE active) <> 3 OR NOT EXISTS (SELECT 1 FROM equipment_hold WHERE kind='fault' AND active)
          THEN RAISE EXCEPTION 'clearing one hold changed independent holds'; END IF;
        BEGIN
          INSERT INTO item_assignment(organization_id,request_item_id,equipment_id,assigned_by)
            SELECT i.organization_id,i.id,h.equipment_id,'synthetic-recovery' FROM request_item i CROSS JOIN equipment_hold h WHERE h.active AND h.kind='fault';
          RAISE EXCEPTION 'remaining hold assignment assertion failed';
        EXCEPTION WHEN SQLSTATE 'SV422' THEN IF SQLERRM <> 'sv:equipment_on_hold' THEN RAISE; END IF; END;
        -- Roll back this successful test clearance so the final comparison retains the original history.
        RAISE EXCEPTION USING ERRCODE='SV999', MESSAGE='ops rollback hold-clear probe';
      EXCEPTION WHEN SQLSTATE 'SV999' THEN NULL; END;
    END $$;`);
    verifySnapshot(before, snapshot(target), {phase: 'post-protection-probes'});
    evidence = {state: 'passed', engine: `native PostgreSQL ${serverMajor}`, syntheticOnly: true,
      ...integrity, archiveSha256, inventory: inventoryEvidence(inventory), checks: ['all 26 public tables', 'physical/receipt timestamps',
        'legacy and no-op command receipts', 'fractional ledger and stock projection', 'request assignment and event links',
        'override audit and expiry links', 'stacked holds and retained configured-role clearance history', 'hold assignment blocking',
        'RLS/ownership/ACLs', 'indexes/constraints/triggers/functions', 'append-only and replay/assignment uniqueness'],
      limitations: ['No runtime-role authorization, hosted restore, PITR, measured RPO/RTO or service rollback demonstrated']};
  } catch (error) { failure = error; }
  const cleanupFailed = [];
  for (const database of created.reverse()) {
    try { query('postgres', `DROP DATABASE IF EXISTS ${database} WITH (FORCE);`); }
    catch { cleanupFailed.push(database); }
  }
  try { rmSync(archiveCleanupTarget(directory), {recursive: true, force: true}); } catch { cleanupFailed.push(directory); }
  if (cleanupFailed.length) throw retainMismatchDiagnostics(Error(`Cleanup incomplete: ${cleanupFailed.join(', ')}; stop and ask the disposable-cluster owner to remove these exact drill resources; no pass recorded`), failure);
  if (failure) throw failure;
  return {...evidence, cleanup: 'both generated databases and temporary archive removed'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(runDrill(), null, 2)); }
  catch (error) {
    console.error(`Recovery drill BLOCKED/FAILED: ${error.message}`);
    const diagnostics = mismatchDiagnosticLine(error);
    if (diagnostics) console.error(diagnostics);
    process.exitCode = 1;
  }
}
