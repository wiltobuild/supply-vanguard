import {createHash} from 'node:crypto';
import {validateTableInventory} from './recovery-inventory.mjs';
import {locationPolicy} from '../packages/domain/location/index.js';
import {summarizeHolds, validateRuleInput} from '../packages/domain/holds/index.js';
import {SnapshotMismatchError} from './recovery-diagnostics.mjs';
import {validateSchemaMetadata} from './recovery-schema.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw Error(message); };
const time = value => Date.parse(value);
const sameTime = (a, b) => Number.isFinite(time(a)) && time(a) === time(b);
const milli = value => {
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(String(value));
  if (!match) throw Error('Invalid exact supply quantity');
  return (match[1] ? -1n : 1n) * (BigInt(match[2]) * 1000n + BigInt((match[3] ?? '').padEnd(3, '0')));
};
const counts = {organization: 1, facility: 1, ward: 1, location: 10, equipment_type: 5, equipment: 8,
  equipment_observation: 1, equipment_event: 1, auth_user: 3, auth_membership: 3, equipment_command_receipt: 2,
  supply_sku: 1, supply_bin: 1, supply_bin_stock: 1, supply_stock_transaction: 2,
  request: 1, request_item: 1, item_assignment: 1, request_event: 2,
  ingestion_nonce: 1, ingestion_receipt: 1, ingestion_dead_letter: 1, location_override: 1, location_override_audit: 1,
  hold_clearance_rule: 2, equipment_hold: 5};

export function verifySnapshot(before, after, options) {
  if (digest(after) !== digest(before)) throw new SnapshotMismatchError(before, after, options);
  validateSchemaMetadata(before.metadata);
  const t = before.tables;
  validateTableInventory(t);
  for (const [name, count] of Object.entries(counts)) requireThat(Array.isArray(t[name]) && t[name].length === count, `Missing synthetic evidence: ${name}`);
  const organization = t.organization[0].id;
  const sameTenant = row => row.organization_id === organization;
  for (const [name, rows] of Object.entries(t)) {
    if (!['organization', 'auth_user'].includes(name)) requireThat(rows.every(sameTenant), 'Synthetic evidence crosses tenant boundaries');
  }
  const member = t.auth_membership.find(row => row.role === 'operator');
  const user = t.auth_user.find(row => row.id === member?.user_id);
  requireThat(user && t.auth_membership.every(row => t.auth_user.some(actor => actor.id === row.user_id)), 'Missing synthetic membership link');
  const equipmentFor = id => t.equipment.find(row => row.id === id);
  const locationFor = id => t.location.find(row => row.id === id);
  const obs = t.equipment_observation[0], receipt = t.ingestion_receipt[0];
  requireThat(equipmentFor(obs.equipment_id) && locationFor(obs.location_id), 'Observation references missing inventory');
  requireThat(receipt.observation_id === obs.id && receipt.idempotency_key === obs.idempotency_key
    && receipt.user_id === user.id && sameTime(receipt.received_at, obs.received_at), 'Ingestion receipt does not match original observation');
  requireThat(time(obs.observed_at) < time(obs.received_at), 'Physical and receipt time must remain distinct');
  requireThat(t.ingestion_nonce[0].source_id === receipt.source_id, 'Missing source replay evidence');

  const legacy = t.equipment_command_receipt.find(row => row.legacy === true);
  const command = t.equipment_command_receipt.find(row => row.legacy === false);
  requireThat(legacy && legacy.actor_id === null && legacy.request === null && legacy.result === null
    && t.equipment_event.some(event => event.equipment_id === legacy.equipment_id && event.idempotency_key === legacy.idempotency_key), 'Legacy command reservation lost its audit key');
  const equipment = command && equipmentFor(command.equipment_id);
  requireThat(equipment && command.actor_id === user.id && command.request?.expectedVersion === equipment.version
    && command.result?.record?.id === equipment.external_id && command.result.record.version === equipment.version
    && command.result.changed === false && command.result.replayed === false, 'Command receipt lost original no-op response or actor link');

  const sku = t.supply_sku[0], bin = t.supply_bin[0], balance = t.supply_bin_stock[0];
  requireThat(bin.sku_id === sku.id && sku.unit === 'each' && locationFor(bin.location_id) && balance.bin_id === bin.id, 'Supply bin mapping or unit lost');
  let quantity = 0n, version = 0;
  for (const entry of [...t.supply_stock_transaction].sort((a, b) => a.expected_version - b.expected_version)) {
    requireThat(entry.bin_id === bin.id && entry.actor_id === user.id && entry.expected_version === version
      && entry.version_after === version + 1 && milli(entry.quantity_before) === quantity && milli(entry.delta) !== 0n,
    'Stock ledger has a broken version, actor or quantity chain');
    quantity += milli(entry.delta); version++;
    requireThat(quantity >= 0n && milli(entry.quantity_after) === quantity, 'Stock ledger generated quantity differs');
  }
  requireThat(balance.version === version && milli(balance.quantity) === quantity && quantity === 12250n, 'Stock balance does not reconcile with fractional ledger');

  const request = t.request[0], item = t.request_item[0], assignment = t.item_assignment[0];
  const assigned = equipmentFor(assignment.equipment_id);
  requireThat(item.request_id === request.id && item.state === 'assigned' && assignment.request_item_id === item.id
    && assignment.active === true && assignment.released_at === null && assigned?.equipment_type_id === item.equipment_type_id,
  'Request assignment lost its item, equipment type or active state');
  requireThat(t.request_event.every(event => event.request_id === request.id)
    && t.request_event.some(event => event.kind === 'request-created')
    && t.request_event.some(event => event.kind === 'item-claimed' && event.request_item_id === item.id && event.equipment_id === assigned.id),
  'Request assignment lost its audit event');

  const rules = new Map();
  for (const rule of t.hold_clearance_rule) {
    validateRuleInput(rule.kind, {role: rule.role});
    requireThat(!rules.has(rule.kind), 'Duplicate synthetic hold clearance rule');
    rules.set(rule.kind, rule.role);
  }
  const heldEquipment = equipmentFor(t.equipment_hold[0].equipment_id);
  requireThat(heldEquipment && heldEquipment.id !== assigned.id && heldEquipment.status === 'available' && heldEquipment.version === 0,
    'Held equipment identity or unchanged administrative state lost');
  const activeKinds = new Set();
  for (const hold of t.equipment_hold) {
    requireThat(hold.equipment_id === heldEquipment.id && ['dirty','fault','maintenance','unknown'].includes(hold.kind)
      && t.auth_user.some(actor => hold.placed_by === `user:${actor.id}`) && Number.isFinite(time(hold.placed_at)), 'Hold inventory/actor link lost');
    if (hold.active === true) {
      requireThat(hold.cleared_by === null && hold.cleared_at === null && !activeKinds.has(hold.kind), 'Active hold clearance state or kind uniqueness lost');
      activeKinds.add(hold.kind);
    } else {
      const clearer = t.auth_membership.find(actor => hold.cleared_by === `user:${actor.user_id}`);
      requireThat(hold.active === false && time(hold.cleared_at) >= time(hold.placed_at) && clearer?.active === true
        && rules.has(hold.kind) && clearer.role === rules.get(hold.kind), 'Cleared hold lost configured-role evidence or history');
      const later = t.equipment_hold.find(candidate => candidate.active && candidate.kind === hold.kind);
      requireThat(later && time(later.placed_at) >= time(hold.cleared_at), 'Cleared hold history was replaced or reordered');
    }
  }
  const summary = summarizeHolds(t.equipment_hold);
  requireThat(summary.blocked && summary.active === 4 && summary.total === 5 && activeKinds.size === 4
    && !rules.has('maintenance') && !rules.has('unknown'), 'Stacked hold or unconfigured-rule evidence lost');

  const override = t.location_override[0], audit = t.location_override_audit[0];
  const policy = locationPolicy(audit.policy);
  requireThat(audit.override_id === override.id && audit.user_id === user.id && equipmentFor(override.equipment_id)
    && locationFor(override.location_id) && sameTime(audit.recorded_at, override.starts_at), 'Override lost its required audit/reference partner');
  requireThat(time(override.observed_at) <= time(override.starts_at) && time(override.starts_at) < time(override.expires_at)
    && time(override.expires_at) - time(override.starts_at) <= policy.maxOverrideMs, 'Override physical/start/expiry bounds differ');
  requireThat(audit.after_state?.locationId === override.location_id && sameTime(audit.after_state.observedAt, override.observed_at)
    && audit.after_state.override?.id === override.id && audit.after_state.override.organizationId === organization
    && audit.after_state.override.equipmentId === override.equipment_id && audit.after_state.override.locationId === override.location_id,
  'Override audit lost original projection identity or physical time');

  const security = before.metadata.rls;
  requireThat(Array.isArray(security) && security.length === Object.keys(counts).length, 'Incomplete RLS metadata');
  for (const name of Object.keys(counts)) {
    const row = security.find(entry => entry.table === name);
    requireThat(row?.enabled === true && row.forced === (name !== 'auth_user') && typeof row.owner === 'string' && row.owner.length > 0,
      'Expected RLS flags or table ownership missing');
  }
  for (const name of ['item_assignment_one_active_per_equipment', 'item_assignment_one_active_per_item', 'equipment_hold_one_active_per_kind']) {
    requireThat(before.metadata.indexes?.some(index => index.name === name && index.unique && index.valid), 'Active-assignment unique index missing');
  }
  for (const [table, name, fn] of [['item_assignment','item_assignment_block_on_hold','block_assignment_on_hold'],
    ['equipment_hold','equipment_hold_guard_trigger','equipment_hold_guard']]) {
    requireThat(before.metadata.triggers?.some(trigger => trigger.table === table && trigger.name === name && trigger.enabled === 'O'
      && trigger.definition.includes(fn)), 'Hold assignment/history protection trigger missing');
  }
  return {dataSha256: digest(t), metadataSha256: digest(before.metadata), tableCount: Object.keys(t).length};
}
