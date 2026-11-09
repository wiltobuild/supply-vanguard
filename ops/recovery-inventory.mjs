import {readFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const repository = new URL('../', import.meta.url);
// Deliberate order: core + seed, auth, then additive capabilities. Never apply every SQL file blindly.
export const recoveryMigrations = Object.freeze([
  {id: 'core', path: 'services/api/db/migrations/0001_core.up.sql', tables: ['organization', 'facility', 'ward', 'location', 'equipment_type', 'equipment', 'equipment_observation', 'equipment_event']},
  {id: 'auth', path: 'services/api/auth/migrations/0001_auth.up.sql', tables: ['auth_user', 'auth_membership']},
  {id: 'equipment-receipts', path: 'services/api/equipment/migrations/0001_receipts.up.sql', tables: ['equipment_command_receipt']},
  {id: 'supplies', path: 'services/api/supplies/migrations/0001_supplies.up.sql', tables: ['supply_sku', 'supply_bin', 'supply_bin_stock', 'supply_stock_transaction']},
  {id: 'requests', path: 'services/api/requests/migrations/0001_requests.up.sql', tables: ['request', 'request_item', 'item_assignment', 'request_event']},
  {id: 'holds', path: 'services/api/holds/migrations/0001_holds.up.sql', tables: ['hold_clearance_rule', 'equipment_hold']},
  {id: 'ingestion', path: 'services/ingestion/migrations/0001_ingestion.up.sql', tables: ['ingestion_nonce', 'ingestion_receipt', 'ingestion_dead_letter']},
  {id: 'location-resolution', path: 'services/ingestion/resolution/migrations/0001_resolution.up.sql', tables: ['location_override', 'location_override_audit']},
]);
export const recoveryTables = Object.freeze(recoveryMigrations.flatMap(migration => migration.tables).sort());
export function validateMigrationPaths(paths) {
  const expected = recoveryMigrations.map(migration => migration.path).sort();
  const actual = [...paths].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Recovery migration inventory differs from services/**/*.up.sql; review missing/new migrations before any database operation');
}
export function validateTableInventory(tables) {
  if (JSON.stringify(Object.keys(tables).sort()) !== JSON.stringify(recoveryTables)) throw Error('Recovery table inventory is incomplete or contains unreviewed tables');
}
export function loadRecoveryInventory(root = repository) {
  const discover = (directory = 'services/') => readdirSync(new URL(directory, root), {withFileTypes: true}).flatMap(entry => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];
    const path = directory + entry.name;
    return entry.isDirectory() ? discover(path + '/') : entry.name.endsWith('.up.sql') ? [path] : [];
  });
  validateMigrationPaths(discover());
  const migrations = recoveryMigrations.map(migration => {
    const sql = readFileSync(new URL(migration.path, root), 'utf8');
    return {...migration, sql, sha256: createHash('sha256').update(sql).digest('hex')};
  });
  return {migrations, seedSql: readFileSync(new URL('services/api/db/seed/seed.sql', root), 'utf8')};
}
export function inventoryEvidence(inventory) {
  return {migrationCount: inventory.migrations.length, tableCount: recoveryTables.length,
    migrations: inventory.migrations.map(({id, path, sha256}) => ({id, path, sha256}))};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw Error('Usage: node ops/recovery-inventory.mjs');
    console.log(JSON.stringify(inventoryEvidence(loadRecoveryInventory()), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
