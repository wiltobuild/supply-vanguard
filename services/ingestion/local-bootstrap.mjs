import {readFileSync} from 'node:fs';
import {mkdtemp, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {createAuthorization} from '../api/auth/index.mjs';
import {createLocalIdentityProvider} from '../api/auth/local-identity.mjs';
import {createLocalSourceVerifier} from './local-verifier.mjs';
import {createFileRejectionJournal} from './journal.mjs';
import {createIngestion} from './index.mjs';

const sql = path => readFileSync(new URL(path, import.meta.url), 'utf8');
// Disposable local-only bootstrap for the simulator and integration tests, never an API route.
// Imports native test binaries intentionally; production supplies its own pool and verifier.
export async function createSyntheticLocal({mode, now = Date.now} = {}) {
  if (!['development', 'test'].includes(mode) || process.env.NODE_ENV === 'production') throw new Error('Synthetic bootstrap restricted to explicit development/test mode');
  const directory = await mkdtemp(join(tmpdir(), 'sv-ingestion-'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const password = randomBytes(32).toString('base64url');
  const cluster = new EmbeddedPostgres({databaseDir: join(directory, 'db'), port, user: 'sv_local_owner', password,
    authMethod: 'scram-sha-256', persistent: false, createPostgresUser: false,
    postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {}});
  // The dependency uses taskkill /f on Windows, which can orphan PostgreSQL 18 I/O workers
  // and keep inherited pipes open. Use the bundled pg_ctl's orderly shutdown instead.
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const {pg_ctl} = await import(`@embedded-postgres/${platform}-${process.arch}`);
  let stopping;
  cluster.stop = () => stopping ??= (async () => {
    const pidFileExists = await access(join(directory, 'db', 'postmaster.pid')).then(() => true, () => false);
    if (pidFileExists) await promisify(execFile)(pg_ctl, ['stop', '-D', join(directory, 'db'), '-m', 'fast', '-w', '-t', '20'], {windowsHide: true, timeout: 25_000});
    await rm(directory, {recursive: true, force: true});
  })();
  let owner, connections;
  try {
    await cluster.initialise();
    await cluster.start();
    owner = new pg.Client({host: '127.0.0.1', port, user: 'sv_local_owner', password, database: 'postgres'});
    await owner.connect();
    // Owner is confined to this throwaway cluster. Seed BEFORE forced RLS; no shared bootstrap edits.
    await owner.query(sql('../api/db/migrations/0001_core.up.sql'));
    await owner.query(sql('../api/db/seed/seed.sql'));
    await owner.query(sql('../api/auth/migrations/0001_auth.up.sql'));
    await owner.query(sql('./migrations/0001_ingestion.up.sql'));
    const organizationId = (await owner.query('SELECT id FROM organization')).rows[0].id;
    const userId = randomUUID();
    await owner.query('INSERT INTO auth_user(id, issuer, subject) VALUES ($1, $2, $3)', [userId, 'urn:supply-vanguard:local', 'synthetic-simulator']);
    await owner.query("INSERT INTO auth_membership(organization_id, user_id, role) VALUES ($1, $2, 'operator')", [organizationId, userId]);
    // Separate unprivileged role, ephemeral random password; never retain a production credential.
    const runtimePassword = randomBytes(32).toString('hex');
    await owner.query(`CREATE ROLE sv_ingestion_local LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
      GRANT USAGE ON SCHEMA public TO sv_ingestion_local;
      GRANT SELECT ON auth_user, auth_membership, equipment, location TO sv_ingestion_local;
      GRANT SELECT, INSERT ON equipment_observation, ingestion_nonce, ingestion_receipt, ingestion_dead_letter TO sv_ingestion_local;
      GRANT EXECUTE ON FUNCTION auth_resolve_identity(text, text) TO sv_ingestion_local;`);
    connections = new pg.Pool({host: '127.0.0.1', port, user: 'sv_ingestion_local', password: runtimePassword, database: 'postgres', max: 12});
    const identities = createLocalIdentityProvider({mode, now});
    const token = identities.issue('synthetic-simulator');
    const verification = createLocalSourceVerifier({mode, now});
    const signer = verification.provision({sourceId: 'synthetic-nicu', organizationId, userId});
    const authorization = createAuthorization({identityProvider: identities, pool: connections});
    const journalPath = join(directory, 'rejections.ndjson');
    const ingestion = createIngestion({authorization, verification, rejectionJournal: createFileRejectionJournal(journalPath), now});
    const equipmentId = (await owner.query("SELECT id FROM equipment WHERE external_id = 'EQ-001'")).rows[0].id;
    const locationId = (await owner.query("SELECT id FROM location WHERE external_key = 'room-101'")).rows[0].id;
    return {organizationId, userId, equipmentId, locationId, signer, verification, identities, token,
      request: {headers: {authorization: `Bearer ${token}`}, socket: {remoteAddress: '127.0.0.1'}},
      owner, pool: connections, authorization, ingestion, journalPath,
      async close() {
        await connections.end();
        await owner.end();
        await cluster.stop();
      }
    };
  } catch (error) {
    if (connections) await connections.end();
    if (owner) await owner.end().catch(() => {});
    await cluster.stop();
    throw error;
  }
}
