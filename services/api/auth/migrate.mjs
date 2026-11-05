import {readFileSync} from 'node:fs';
import {psql} from '../db/lib.mjs';

// Separate lifecycle preserves the existing core migration history. Uses existing DATABASE_URL.
const command = process.argv[2];
try {
  if (!['up', 'down'].includes(command)) throw new Error('Usage: node services/api/auth/migrate.mjs up|down');
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the local development database');
  const sql = readFileSync(new URL(`./migrations/0001_auth.${command}.sql`, import.meta.url), 'utf8');
  const guard = command === 'up'
    ? "IF to_regclass('public.auth_user') IS NOT NULL THEN RAISE EXCEPTION 'Auth already installed'; END IF;"
    : "IF to_regclass('public.auth_user') IS NULL THEN RAISE EXCEPTION 'Auth is not installed'; END IF;";
  psql(process.env.DATABASE_URL, `BEGIN; SELECT pg_advisory_xact_lock(55005); DO $$ BEGIN ${guard} END $$;\n${sql}\nCOMMIT;`);
  console.log(`Auth migration ${command} committed`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
