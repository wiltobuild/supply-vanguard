import {readFileSync} from 'node:fs';

// The host supplies an owner connection; this helper creates no identities or credentials.
export async function migrateResolution(client, direction) {
  if (!['up', 'down'].includes(direction)) throw new Error('Resolution migration direction must be up or down');
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(14014)');
    const installed = (await client.query("SELECT to_regclass('public.location_override') IS NOT NULL AS installed")).rows[0].installed;
    if (installed !== (direction === 'up')) await client.query(readFileSync(new URL(`./migrations/0001_resolution.${direction}.sql`, import.meta.url), 'utf8'));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
