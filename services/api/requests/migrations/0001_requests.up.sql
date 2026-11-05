-- SV-020: requests with several items, and atomic item claims. Apply after core (SV-004) and auth (SV-005).
-- Tenant-scoped like the core schema: every reference carries organization_id, and row-level security uses the
-- SV-005 context functions. Claims are provisional assignments; they do not change the equipment's status or version.
CREATE TABLE request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization (id),
  requested_by text NOT NULL CHECK (length(btrim(requested_by)) > 0),
  note text CHECK (note IS NULL OR length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

-- One row per requested item. The request summary is derived from these states, never stored.
CREATE TABLE request_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  request_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no >= 1),
  equipment_type_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'assigned')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, request_id, line_no),
  FOREIGN KEY (organization_id, request_id) REFERENCES request (organization_id, id),
  FOREIGN KEY (organization_id, equipment_type_id) REFERENCES equipment_type (organization_id, id)
);

CREATE TABLE item_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  request_item_id uuid NOT NULL,
  equipment_id uuid NOT NULL,
  assigned_by text NOT NULL CHECK (length(btrim(assigned_by)) > 0),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  released_at timestamptz,
  CHECK (active = (released_at IS NULL)),
  FOREIGN KEY (organization_id, request_item_id) REFERENCES request_item (organization_id, id),
  FOREIGN KEY (organization_id, equipment_id) REFERENCES equipment (organization_id, id)
);
-- The backstop that makes double assignment impossible even if a caller skips the claim function.
CREATE UNIQUE INDEX item_assignment_one_active_per_equipment ON item_assignment (organization_id, equipment_id) WHERE active;
CREATE UNIQUE INDEX item_assignment_one_active_per_item ON item_assignment (organization_id, request_item_id) WHERE active;

CREATE TABLE request_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_item_id uuid,
  equipment_id uuid,
  kind text NOT NULL CHECK (kind IN ('request-created', 'item-claimed')),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (organization_id, request_id) REFERENCES request (organization_id, id),
  FOREIGN KEY (organization_id, request_item_id) REFERENCES request_item (organization_id, id),
  FOREIGN KEY (organization_id, equipment_id) REFERENCES equipment (organization_id, id)
);
CREATE INDEX request_event_request_idx ON request_event (organization_id, request_id, recorded_at);
CREATE TRIGGER request_event_append_only BEFORE UPDATE OR DELETE ON request_event
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Atomic claim. Locks the asset first, then the item (always in that order, so claims cannot deadlock), and checks
-- everything in one transaction: item still open, right equipment type, asset version unchanged, asset available,
-- no other active assignment. Errors carry a stable code in the message ('sv:...') for the API to map.
-- SECURITY INVOKER: row-level security and the caller's permissions apply.
CREATE FUNCTION public.claim_request_item(p_request uuid, p_line integer, p_equipment uuid, p_expected_version integer, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  org uuid := public.auth_organization_id();
  eq equipment%ROWTYPE;
  it request_item%ROWTYPE;
  existing uuid;
  new_id uuid;
BEGIN
  IF org IS NULL THEN RAISE EXCEPTION 'sv:no_tenant_context' USING ERRCODE = '42501'; END IF;
  SELECT * INTO eq FROM equipment WHERE organization_id = org AND id = p_equipment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sv:equipment_not_found' USING ERRCODE = 'SV404'; END IF;
  SELECT * INTO it FROM request_item WHERE organization_id = org AND request_id = p_request AND line_no = p_line FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sv:item_not_found' USING ERRCODE = 'SV404'; END IF;
  IF it.state = 'assigned' THEN
    -- A retry of a claim that already succeeded (same asset, same actor) gets the original assignment back.
    SELECT id INTO existing FROM item_assignment
      WHERE organization_id = org AND request_item_id = it.id AND equipment_id = p_equipment AND assigned_by = p_actor AND active;
    IF existing IS NOT NULL THEN
      RETURN jsonb_build_object('assignmentId', existing, 'replayed', true);
    END IF;
    RAISE EXCEPTION 'sv:item_already_assigned' USING ERRCODE = 'SV409';
  END IF;
  IF eq.equipment_type_id <> it.equipment_type_id THEN RAISE EXCEPTION 'sv:wrong_equipment_type' USING ERRCODE = 'SV422'; END IF;
  IF eq.version <> p_expected_version THEN RAISE EXCEPTION 'sv:stale_version' USING ERRCODE = 'SV409'; END IF;
  IF eq.status <> 'available' THEN RAISE EXCEPTION 'sv:not_assignable' USING ERRCODE = 'SV422'; END IF;
  IF EXISTS (SELECT 1 FROM item_assignment WHERE organization_id = org AND equipment_id = p_equipment AND active) THEN
    RAISE EXCEPTION 'sv:equipment_already_assigned' USING ERRCODE = 'SV409';
  END IF;
  INSERT INTO item_assignment (organization_id, request_item_id, equipment_id, assigned_by)
    VALUES (org, it.id, p_equipment, p_actor) RETURNING id INTO new_id;
  UPDATE request_item SET state = 'assigned' WHERE organization_id = org AND id = it.id;
  INSERT INTO request_event (organization_id, request_id, request_item_id, equipment_id, kind, actor, detail)
    VALUES (org, p_request, it.id, p_equipment, 'item-claimed', p_actor, jsonb_build_object('equipmentVersion', eq.version, 'lineNo', p_line));
  RETURN jsonb_build_object('assignmentId', new_id, 'replayed', false);
END $$;
REVOKE ALL ON FUNCTION public.claim_request_item(uuid, integer, uuid, integer, text) FROM PUBLIC;

-- Row-level security, using the SV-005 context. Reads need inventory:read, writes equipment:write. No delete policies.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['request', 'request_item', 'item_assignment', 'request_event'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY auth_read ON public.%I FOR SELECT USING (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L))', t, 'inventory:read');
    EXECUTE format('CREATE POLICY auth_insert ON public.%I FOR INSERT WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L))', t, 'equipment:write');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['request_item', 'item_assignment'] LOOP
    EXECUTE format('CREATE POLICY auth_update ON public.%I FOR UPDATE USING (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L)) WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L))', t, 'equipment:write', 'equipment:write');
  END LOOP;
END $$;
