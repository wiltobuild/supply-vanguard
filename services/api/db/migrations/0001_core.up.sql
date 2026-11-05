-- SV-004: tenant-scoped core schema. Every table carries organization_id, and every
-- cross-table reference includes it, so a row can never point at another tenant's row.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organization (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE facility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization (id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  UNIQUE (organization_id, id)
);

CREATE TABLE ward (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  facility_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, facility_id) REFERENCES facility (organization_id, id)
);

-- Locations form a hierarchy (room, then cabinet) and keep a stable external key.
CREATE TABLE location (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  ward_id uuid NOT NULL,
  parent_id uuid,
  external_key text NOT NULL CHECK (length(btrim(external_key)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  kind text NOT NULL CHECK (kind IN ('room', 'store', 'cabinet', 'area')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, external_key),
  CHECK (parent_id IS NULL OR parent_id <> id),
  FOREIGN KEY (organization_id, ward_id) REFERENCES ward (organization_id, id),
  FOREIGN KEY (organization_id, parent_id) REFERENCES location (organization_id, id)
);

CREATE TABLE equipment_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization (id),
  model_kind text NOT NULL CHECK (length(btrim(model_kind)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, model_kind)
);

-- Serialized equipment. Status and note are administrative; last_verified_* is physical-location
-- confidence and is only ever set from an observation, never from a status edit.
CREATE TABLE equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  equipment_type_id uuid NOT NULL,
  location_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('available', 'in-use', 'cleaning', 'maintenance', 'retired')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  note text CHECK (note IS NULL OR length(note) <= 500),
  last_admin_edit_at timestamptz,
  last_verified_location_id uuid,
  last_verified_at timestamptz,
  last_verified_source text CHECK (last_verified_source IN ('manual-check-in', 'barcode', 'qr', 'rfid', 'ble', 'rtls', 'simulator')),
  provenance text NOT NULL CHECK (length(btrim(provenance)) > 0),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, external_id),
  CHECK ((last_verified_at IS NULL) = (last_verified_location_id IS NULL)
     AND (last_verified_at IS NULL) = (last_verified_source IS NULL)),
  FOREIGN KEY (organization_id, equipment_type_id) REFERENCES equipment_type (organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES location (organization_id, id),
  FOREIGN KEY (organization_id, last_verified_location_id) REFERENCES location (organization_id, id)
);

-- Observations and events are append-only.
CREATE TABLE equipment_observation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  equipment_id uuid NOT NULL,
  location_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('manual-check-in', 'barcode', 'qr', 'rfid', 'ble', 'rtls', 'simulator')),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  correlation_id text,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  CHECK (observed_at <= received_at),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, equipment_id) REFERENCES equipment (organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES location (organization_id, id)
);

CREATE TABLE equipment_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  equipment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('admin', 'observation')),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  source text NOT NULL CHECK (length(btrim(source)) > 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  before_state jsonb,
  after_state jsonb NOT NULL,
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, equipment_id) REFERENCES equipment (organization_id, id)
);

CREATE INDEX equipment_location_idx ON equipment (organization_id, location_id);
CREATE INDEX equipment_status_idx ON equipment (organization_id, status);
CREATE INDEX equipment_observation_equipment_idx ON equipment_observation (organization_id, equipment_id, observed_at DESC);
CREATE INDEX equipment_event_equipment_idx ON equipment_event (organization_id, equipment_id, recorded_at DESC);

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER equipment_observation_append_only BEFORE UPDATE OR DELETE ON equipment_observation
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER equipment_event_append_only BEFORE UPDATE OR DELETE ON equipment_event
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Administrative edits must bump version by exactly one, follow the allowed status transitions
-- (same rules as packages/domain/contracts.js), and never change a retired item.
CREATE FUNCTION equipment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed text[];
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.external_id <> OLD.external_id THEN
    RAISE EXCEPTION 'equipment identity cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.note IS DISTINCT FROM OLD.note OR NEW.name IS DISTINCT FROM OLD.name THEN
    IF OLD.status = 'retired' THEN
      RAISE EXCEPTION 'retired equipment cannot be changed' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'administrative edits must increase version by one (expected %, got %)', OLD.version + 1, NEW.version USING ERRCODE = 'serialization_failure';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      allowed := CASE OLD.status
        WHEN 'available' THEN ARRAY['in-use', 'cleaning', 'maintenance', 'retired']
        WHEN 'in-use' THEN ARRAY['cleaning', 'maintenance', 'retired']
        WHEN 'cleaning' THEN ARRAY['available', 'maintenance', 'retired']
        WHEN 'maintenance' THEN ARRAY['cleaning', 'available', 'retired']
        ELSE ARRAY[]::text[] END;
      IF NOT (NEW.status = ANY (allowed)) THEN
        RAISE EXCEPTION 'status transition % to % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'version only changes with an administrative edit' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Location confidence never moves backward.
  IF OLD.last_verified_at IS NOT NULL AND NEW.last_verified_at IS NOT NULL AND NEW.last_verified_at < OLD.last_verified_at THEN
    RAISE EXCEPTION 'last verified time cannot move backward' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER equipment_guard_trigger BEFORE UPDATE ON equipment
  FOR EACH ROW EXECUTE FUNCTION equipment_guard();
