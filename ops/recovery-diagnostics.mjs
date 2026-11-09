import {createHash} from 'node:crypto';
import {recoveryTables} from './recovery-inventory.mjs';

export const diagnosticLimits = Object.freeze({entries: 8, depth: 12, nodes: 10_000, pathCharacters: 160, bytes: 8192});
const phases = new Set(['source-fixture', 'post-restore', 'post-protection-probes']);
// Only public schema/contract labels may appear in paths. Never echo an arbitrary JSON key:
// a key itself can contain a token, connection string, SQL body or other sensitive value.
const labels = new Set([...recoveryTables, ...(`tables metadata rls indexes policies constraints triggers functions
 table enabled forced owner acl name unique valid definition schemaname tablename policyname permissive roles cmd qual with_check securityDefiner config
 id organization_id facility_id ward_id parent_id external_key kind created_at equipment_type_id location_id status version note last_admin_edit_at
 last_verified_location_id last_verified_at last_verified_source provenance equipment_id observed_at received_at source actor correlation_id idempotency_key
 recorded_at before_state after_state issuer subject active user_id role request result actor_id legacy quantity_before quantity_after expected_version
 version_after bin_id delta reason source_id nonce observation_id fingerprint envelope_digest sku_id code unit quantity requested_by request_id line_no state
 request_item_id assigned_by assigned_at released_at override_id starts_at expires_at policy cleared_by cleared_at placed_by placed_at
 schemaVersion modelKind locationId lastVerified lastAdminEditAt observedAt expectedVersion changed replayed record organizationId equipmentId evaluatedAt
 policyVersion freshness receivedAt evidence conflictingLocationIds override maxOverrideMs freshMs staleMs conflictWindowMs`).trim().split(/\s+/)]);
const registeredDiagnostics = new WeakMap();
const encoded = value => JSON.stringify(value);
const hashText = value => createHash('sha256').update(value).digest('hex');
const valueHash = (value, present) => hashText(present ? (encoded(value) ?? '<undefined>') : '<missing>');
const freeze = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};

export function snapshotMismatchDiagnostics(before, after, {phase} = {}) {
  const differences = [];
  let visited = 0, truncated = false;
  const add = (kind, path, a, b, aPresent = true, bPresent = true) => {
    if (differences.length === diagnosticLimits.entries) { truncated = true; return; }
    differences.push({kind, path, beforeSha256: valueHash(a, aPresent), afterSha256: valueHash(b, bPresent)});
  };
  const visit = (a, b, path, depth, aPresent = true, bPresent = true) => {
    if (differences.length === diagnosticLimits.entries) { truncated = true; return false; }
    visited++;
    if (aPresent === bPresent && encoded(a) === encoded(b)) return true;
    if (!aPresent || !bPresent) { add('missing', path, a, b, aPresent, bPresent); return true; }
    if (depth >= diagnosticLimits.depth) { truncated = true; add('depth-limit', path, a, b); return true; }
    const aObject = a !== null && typeof a === 'object', bObject = b !== null && typeof b === 'object';
    if (!aObject || !bObject || Array.isArray(a) !== Array.isArray(b)) { add('value', path, a, b); return true; }
    const keys = Array.isArray(a)
      ? Array.from({length: Math.min(Math.max(a.length, b.length), diagnosticLimits.nodes + 1)}, (_, index) => index)
      : [...new Set([...Object.keys(a), ...Object.keys(b)])];
    if (!Array.isArray(a)) {
      const left = Object.keys(a), right = Object.keys(b);
      if (left.length === right.length && left.every(key => Object.hasOwn(b, key)) && encoded(left) !== encoded(right)) {
        // Key order is part of the existing strict JSON hash. Do not silently canonicalize it.
        add('key-order', path, a, b);
      }
    }
    for (let index = 0; index < keys.length; index++) {
      if (visited >= diagnosticLimits.nodes) { truncated = true; add('node-limit', path, a, b); return false; }
      const key = keys[index];
      const next = path + (Array.isArray(a) ? `[${key}]` : labels.has(key) ? `.${key}` : `.property[${index}]`);
      if (next.length > diagnosticLimits.pathCharacters) { truncated = true; add('path-limit', path, a, b); return true; }
      if (!visit(a[key], b[key], next, depth + 1, Object.hasOwn(a, key), Object.hasOwn(b, key))) return false;
    }
    return true;
  };
  visit(before, after, '$', 0);
  const result = {phase: phases.has(phase) ? phase : 'unspecified',
    beforeSha256: valueHash(before, true), afterSha256: valueHash(after, true), differences, truncated};
  // Fixed labels/hash lengths and the entry/path caps normally remain well below this guard.
  while (Buffer.byteLength(JSON.stringify(result)) > diagnosticLimits.bytes && differences.length) {
    differences.pop(); result.truncated = true;
  }
  return freeze(result);
}

export class SnapshotMismatchError extends Error {
  constructor(before, after, options) {
    super('Restored data or security/schema metadata differs');
    this.name = 'SnapshotMismatchError';
    const diagnostics = snapshotMismatchDiagnostics(before, after, options);
    Object.defineProperty(this, 'diagnostics', {value: diagnostics, enumerable: true});
    registeredDiagnostics.set(this, diagnostics);
  }
}

// Preserve the safe mismatch receipt if cleanup fails, without changing cleanup/error priority.
export function retainMismatchDiagnostics(outer, inner) {
  const diagnostics = registeredDiagnostics.get(inner);
  if (diagnostics) registeredDiagnostics.set(outer, diagnostics);
  return outer;
}
export function mismatchDiagnosticLine(error) {
  const diagnostics = registeredDiagnostics.get(error);
  return diagnostics ? 'Recovery comparison diagnostics: ' + JSON.stringify(diagnostics) : null;
}
