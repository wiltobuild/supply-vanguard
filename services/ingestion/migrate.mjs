import {readFileSync} from 'node:fs';
import pg from 'pg';

const direction = process.argv[2];
let client;
try {
  if (!['up', 'down'].includes(direction) || !process.env.DATABASE_URL) throw new Error('Usage: set local DATABASE_URL, then npm run migrate -- up|down');
  client = new pg.Client({connectionString: process.env.DATABASE_URL});
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(13013)');
  const installed = (await client.query("SELECT to_regclass('public.ingestion_receipt') IS NOT NULL AS installed")).rows[0].installed;
  if (installed !== (direction === 'up')) {
    await client.query(readFileSync(new URL(`./migrations/0001_ingestion.${direction}.sql`, import.meta.url), 'utf8'));
  }
  await client.query('COMMIT');
  console.log(`Ingestion migration ${direction} committed`);
} catch {
  if (client) await client.query('ROLLBACK').catch(() => {});
  console.error('Ingestion migration failed; check local DATABASE_URL and core/auth migration prerequisites');
  process.exitCode = 1;
} finally { if (client) await client.end(); }
