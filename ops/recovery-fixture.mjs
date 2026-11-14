// SQL storage fixtures only, never an API/identity bootstrap or production provisioning path.
// Insert this before the receipts migration to exercise its actual legacy-key backfill.
export const legacyEventSql = `
INSERT INTO equipment_event(organization_id, equipment_id, kind, actor, source, recorded_at, idempotency_key, before_state, after_state)
  SELECT organization_id, id, 'admin', 'synthetic-recovery', 'synthetic-fixture', '2026-11-05T09:59:00Z',
    'admin:ops-synthetic-legacy', to_jsonb(e), to_jsonb(e) FROM equipment e WHERE external_id='EQ-001';
`;
export const fixtureSql = `
INSERT INTO auth_user(id, issuer, subject) VALUES ('00000000-0000-4000-8000-00000000f017', 'urn:sv:ops:synthetic', 'recovery-fixture');
INSERT INTO auth_membership(organization_id, user_id, role)
  SELECT id, '00000000-0000-4000-8000-00000000f017', 'operator' FROM organization;
INSERT INTO equipment_observation(id, organization_id, equipment_id, location_id, observed_at, received_at, source, actor, idempotency_key)
  SELECT '00000000-0000-4000-8000-00000000f018', e.organization_id, e.id, l.id,
    '2026-11-05T10:00:00Z', '2026-11-05T10:01:00Z', 'simulator', 'synthetic-recovery', 'ops-synthetic-observation'
  FROM equipment e JOIN location l ON l.organization_id=e.organization_id AND l.external_key='room-101'
  WHERE e.external_id='EQ-001';
INSERT INTO ingestion_nonce(organization_id, source_id, nonce, received_at)
  SELECT organization_id, 'ops-synthetic', 'ops-synthetic-nonce', received_at FROM equipment_observation;
INSERT INTO ingestion_receipt(organization_id, idempotency_key, observation_id, source_id, user_id, fingerprint, received_at)
  SELECT organization_id, idempotency_key, id, 'ops-synthetic', '00000000-0000-4000-8000-00000000f017', repeat('a',64), received_at FROM equipment_observation;
INSERT INTO ingestion_dead_letter(organization_id, user_id, received_at, reason, envelope_digest)
  SELECT id, '00000000-0000-4000-8000-00000000f017', '2026-11-05T10:03:00Z', 'replay', repeat('b',64) FROM organization;

-- A successful no-op preserves its original complete response independently of the legacy reservation.
INSERT INTO equipment_command_receipt(organization_id, idempotency_key, equipment_id, actor_id, request, result, recorded_at)
  SELECT e.organization_id, 'admin:ops-synthetic-noop', e.id, '00000000-0000-4000-8000-00000000f017',
    jsonb_build_object('expectedVersion',e.version), jsonb_build_object('changed',false,'replayed',false,'record',
      jsonb_build_object('schemaVersion',1,'id',e.external_id,'name',e.name,'modelKind',t.model_kind,
        'locationId',l.external_key,'status',e.status,'version',e.version,'lastVerified',null,
        'lastAdminEditAt',null,'provenance',e.provenance)), '2026-11-05T10:02:00Z'
  FROM equipment e JOIN equipment_type t ON t.id=e.equipment_type_id AND t.organization_id=e.organization_id
    JOIN location l ON l.id=e.location_id AND l.organization_id=e.organization_id WHERE e.external_id='EQ-001';

INSERT INTO supply_sku(id, organization_id, code, name, unit)
  SELECT '00000000-0000-4000-8000-00000000f030', id, 'OPS-SYNTHETIC', 'Synthetic supply', 'each' FROM organization;
INSERT INTO supply_bin(id, organization_id, sku_id, location_id, code)
  SELECT '00000000-0000-4000-8000-00000000f031', organization_id, '00000000-0000-4000-8000-00000000f030', id, 'OPS-SYNTHETIC-BIN'
  FROM location WHERE external_key='clean-supply';
INSERT INTO supply_stock_transaction(organization_id, bin_id, kind, delta, quantity_before, expected_version, actor_id, source, reason, idempotency_key)
  SELECT organization_id, id, 'restock', 12.375, 0, 0, '00000000-0000-4000-8000-00000000f017', 'synthetic-fixture', 'Synthetic restock', 'ops-stock-1' FROM supply_bin;
INSERT INTO supply_stock_transaction(organization_id, bin_id, kind, delta, quantity_before, expected_version, actor_id, source, reason, idempotency_key)
  SELECT organization_id, id, 'adjustment', -0.125, 12.375, 1, '00000000-0000-4000-8000-00000000f017', 'synthetic-fixture', 'Synthetic correction', 'ops-stock-2' FROM supply_bin;

INSERT INTO request(id, organization_id, requested_by, note, created_at)
  SELECT '00000000-0000-4000-8000-00000000f040', id, 'synthetic-recovery', 'Synthetic equipment request', '2026-11-05T10:00:00Z' FROM organization;
INSERT INTO request_item(id, organization_id, request_id, line_no, equipment_type_id)
  SELECT '00000000-0000-4000-8000-00000000f041', organization_id, '00000000-0000-4000-8000-00000000f040', 1, equipment_type_id FROM equipment WHERE external_id='EQ-001';
INSERT INTO request_event(organization_id, request_id, kind, actor, recorded_at, detail)
  SELECT organization_id, id, 'request-created', 'synthetic-recovery', '2026-11-05T10:00:00Z', '{"itemCount":1}' FROM request;
SELECT set_config('sv.organization_id',(SELECT id::text FROM organization),true);
SELECT set_config('sv.user_id','00000000-0000-4000-8000-00000000f017',true);
SELECT claim_request_item('00000000-0000-4000-8000-00000000f040',1,(SELECT id FROM equipment WHERE external_id='EQ-001'),0,'synthetic-recovery');

INSERT INTO location_override(id, organization_id, equipment_id, location_id, observed_at, starts_at, expires_at)
  SELECT '00000000-0000-4000-8000-00000000f050', e.organization_id, e.id, l.id,
    '2026-11-05T10:02:00Z', '2026-11-05T10:03:00Z', '2026-11-05T10:13:00Z'
  FROM equipment e JOIN location l ON l.organization_id=e.organization_id AND l.external_key='room-102' WHERE e.external_id='EQ-001';
INSERT INTO location_override_audit(override_id, organization_id, user_id, idempotency_key, fingerprint, recorded_at, reason, policy, before_state, after_state)
  SELECT id, organization_id, '00000000-0000-4000-8000-00000000f017', 'ops-synthetic-override', repeat('c',64), starts_at,
    'Synthetic attestation', '{"version":"ops-synthetic-v1","freshMs":60000,"staleMs":600000,"conflictWindowMs":0,"maxOverrideMs":3600000}',
    jsonb_build_object('state','aging','reason','observation','observedAt','2026-11-05T10:00:00.000Z'),
    jsonb_build_object('state','fresh','reason','manual-override','locationId',location_id,'observedAt','2026-11-05T10:02:00.000Z',
      'override',jsonb_build_object('id',id,'organizationId',organization_id,'equipmentId',equipment_id,'locationId',location_id))
  FROM location_override;

-- Reuse the holds task's documented TEST mappings, never an operational clearance policy.
-- These synthetic auth rows have no tokens, login credentials, database roles or grants.
INSERT INTO auth_user(id,issuer,subject) VALUES
  ('00000000-0000-4000-8000-00000000f060','urn:sv:ops:synthetic','synthetic-supply-clearer'),
  ('00000000-0000-4000-8000-00000000f061','urn:sv:ops:synthetic','synthetic-equipment-clearer');
INSERT INTO auth_membership(organization_id,user_id,role)
  SELECT o.id,v.user_id::uuid,v.role FROM organization o CROSS JOIN (VALUES
    ('00000000-0000-4000-8000-00000000f060','supply_manager'),
    ('00000000-0000-4000-8000-00000000f061','equipment_manager')) v(user_id,role);
INSERT INTO hold_clearance_rule(organization_id,kind,role)
  SELECT o.id,v.kind,v.role FROM organization o CROSS JOIN (VALUES
    ('dirty','supply_manager'),('fault','equipment_manager')) v(kind,role);
-- Maintenance/unknown deliberately have no fixture rule: clearance must fail closed.
INSERT INTO equipment_hold(id,organization_id,equipment_id,kind,reason,placed_by,placed_at)
  SELECT '00000000-0000-4000-8000-00000000f070',organization_id,id,'dirty','Synthetic cleared history',
    'user:00000000-0000-4000-8000-00000000f017',transaction_timestamp()-interval '2 minutes'
  FROM equipment WHERE external_id='EQ-003';
SELECT set_config('sv.user_id','00000000-0000-4000-8000-00000000f060',true);
SELECT clear_equipment_hold('00000000-0000-4000-8000-00000000f070','user:00000000-0000-4000-8000-00000000f060');
INSERT INTO equipment_hold(id,organization_id,equipment_id,kind,reason,placed_by,placed_at)
  SELECT v.id::uuid,e.organization_id,e.id,v.kind,'Synthetic stacked hold',
    'user:00000000-0000-4000-8000-00000000f017',clock_timestamp()
  FROM equipment e CROSS JOIN (VALUES
    ('00000000-0000-4000-8000-00000000f071','dirty'),
    ('00000000-0000-4000-8000-00000000f072','fault'),
    ('00000000-0000-4000-8000-00000000f073','maintenance'),
    ('00000000-0000-4000-8000-00000000f074','unknown')) v(id,kind)
  WHERE e.external_id='EQ-003';
SELECT set_config('sv.user_id','00000000-0000-4000-8000-00000000f017',true);
`;

export function fixtureSetupSql(inventory) {
  const [core, auth, ...additive] = inventory.migrations;
  if (core?.id !== 'core' || auth?.id !== 'auth' || additive[0]?.id !== 'equipment-receipts') throw Error('Unexpected recovery migration order');
  return `BEGIN;\n${core.sql}\n${inventory.seedSql}\n${auth.sql}\n${legacyEventSql}\n${additive.map(m => m.sql).join('\n')}\n${fixtureSql}\nCOMMIT;`;
}
