import {readFileSync} from 'node:fs';
import pg from 'pg';
const command = process.argv[2];
let client;
try {
  if (!['up','down'].includes(command) || !process.env.DATABASE_URL) throw Error('Set local DATABASE_URL; usage: node services/api/replenishment/migrate.mjs up|down');
  client = new pg.Client({connectionString:process.env.DATABASE_URL});
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(55010)');
  const installed = (await client.query("SELECT to_regclass('public.replenishment_task') IS NOT NULL AS installed")).rows[0].installed;
  if (installed !== (command === 'up')) await client.query(readFileSync(new URL(`./migrations/0001_replenishment.${command}.sql`,import.meta.url),'utf8'));
  await client.query('COMMIT');
  console.log(`Replenishment ${command} committed${installed === (command === 'up') ? ' (already in desired state)' : ''}`);
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally { await client?.end(); }
