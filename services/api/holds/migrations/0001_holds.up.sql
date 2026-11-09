-- SV-021: independent, stacking equipment holds. Apply after core (SV-004), auth (SV-005) and requests (SV-020).
-- A hold is an overlay on an asset: it never changes the asset's status or version. While any hold on an asset is active,
-- the asset cannot be assigned. Each kind is cleared only by the role the organization has configured for that kind;
-- no role names or administrator exceptions are built in.
CREATE TABLE hold_clearance_rule (
  organization_id uuid NOT NULL REFERENCES organization (id),
  kind text NOT NULL CHECK (kind IN ('dirty', 'fault', 'maintenance', 'unknown')),
  role text NOT NULL CHECK (role IN ('viewer', 'operator', 'supply_manager', 'equipment_manager', 'admin')),
  PRIMARY KEY (organization_id, kind)
);

-- Rows are never deleted. Clearing flips active to false and records who and when, so history is the table itself.
CREATE TABLE equipment_hold (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  equipment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dirty', 'fault', 'maintenance', 'unknown')),
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  placed_by text NOT NULL CHECK (length(btrim(placed_by)) > 0),
  placed_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  cleared_by text,
  cleared_at timestamptz,
  CHECK (active = (cleared_by IS NULL AND cleared_at IS NULL)),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, equipment_id) REFERENCES equipment (organization_id, id)
);
-- Kinds stack independently, so one active hold per kind per asset.
CREATE UNIQUE INDEX equipment_hold_one_active_per_kind ON equipment_hold (organization_id, equipment_id, kind) WHERE active;
CREATE INDEX equipment_hold_equipment_idx ON equipment_hold (organization_id, equipment_id, placed_at);

CREATE FUNCTION public.equipment_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'equipment_hold rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.active IS NOT TRUE
     OR NEW.active IS NOT FALSE
     OR NEW.cleared_by IS NULL OR NEW.cleared_at IS NULL
     OR NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.equipment_id <> OLD.equipment_id
     OR NEW.kind <> OLD.kind OR NEW.placed_by <> OLD.placed_by OR NEW.placed_at <> OLD.placed_at
     OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'a hold can only be cleared: active to inactive with who and when' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER equipment_hold_guard_trigger BEFORE UPDATE OR DELETE ON equipment_hold
  FOR EACH ROW EXECUTE FUNCTION public.equipment_hold_guard();

-- Any active hold blocks assignment, enforced where assignments are written, so it holds even if the claim function is bypassed.
CREATE FUNCTION public.block_assignment_on_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM equipment_hold WHERE organization_id = NEW.organization_id AND equipment_id = NEW.equipment_id AND active) THEN
    RAISE EXCEPTION 'sv:equipment_on_hold' USING ERRCODE = 'SV422';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_assignment_block_on_hold BEFORE INSERT ON item_assignment
  FOR EACH ROW EXECUTE FUNCTION public.block_assignment_on_hold();

-- Place a hold. Locks the asset first, the same as the claim function, so a hold and a claim on one asset are serialized:
-- whichever commits first wins, and a claim that arrives after a committed hold is refused. Repeating an active kind returns it.
CREATE FUNCTION public.place_equipment_hold(p_equipment uuid, p_kind text, p_reason text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  org uuid := public.auth_organization_id();
  eq uuid;
  existing uuid;
  new_id uuid;
BEGIN
  IF org IS NULL THEN RAISE EXCEPTION 'sv:no_tenant_context' USING ERRCODE = '42501'; END IF;
  SELECT id INTO eq FROM equipment WHERE organization_id = org AND id = p_equipment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sv:equipment_not_found' USING ERRCODE = 'SV404'; END IF;
  SELECT id INTO existing FROM equipment_hold WHERE organization_id = org AND equipment_id = p_equipment AND kind = p_kind AND active;
  IF existing IS NOT NULL THEN RETURN jsonb_build_object('holdId', existing, 'placed', false); END IF;
  INSERT INTO equipment_hold (organization_id, equipment_id, kind, reason, placed_by)
    VALUES (org, p_equipment, p_kind, p_reason, p_actor) RETURNING id INTO new_id;
  RETURN jsonb_build_object('holdId', new_id, 'placed', true);
END $$;

-- Clear a hold. Allowed only for a member whose role is the one configured for this hold's kind. No rule configured means
-- nobody can clear it (fail closed). The role is read from the caller's own active membership, never from a request.
CREATE FUNCTION public.clear_equipment_hold(p_hold uuid, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  org uuid := public.auth_organization_id();
  h equipment_hold%ROWTYPE;
  need text;
  done uuid;
BEGIN
  IF org IS NULL THEN RAISE EXCEPTION 'sv:no_tenant_context' USING ERRCODE = '42501'; END IF;
  SELECT * INTO h FROM equipment_hold WHERE organization_id = org AND id = p_hold;
  IF NOT FOUND THEN RAISE EXCEPTION 'sv:hold_not_found' USING ERRCODE = 'SV404'; END IF;
  IF NOT h.active THEN RAISE EXCEPTION 'sv:hold_already_cleared' USING ERRCODE = 'SV409'; END IF;
  SELECT role INTO need FROM hold_clearance_rule WHERE organization_id = org AND kind = h.kind;
  IF need IS NULL THEN RAISE EXCEPTION 'sv:no_clearance_rule' USING ERRCODE = 'SV422'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth_membership WHERE organization_id = org AND user_id = public.auth_user_id() AND active AND role = need) THEN
    RAISE EXCEPTION 'sv:wrong_role' USING ERRCODE = 'SV403';
  END IF;
  UPDATE equipment_hold SET active = false, cleared_by = p_actor, cleared_at = now()
    WHERE organization_id = org AND id = p_hold AND active RETURNING id INTO done;
  IF done IS NULL THEN RAISE EXCEPTION 'sv:hold_already_cleared' USING ERRCODE = 'SV409'; END IF;
  RETURN jsonb_build_object('holdId', done, 'cleared', true);
END $$;
REVOKE ALL ON FUNCTION public.place_equipment_hold(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_equipment_hold(uuid, text) FROM PUBLIC;

-- Row-level security on the SV-005 context. Reads need inventory:read. Placing needs equipment:write. Only the matching role
-- may update (clear) a hold, even through direct SQL. Only organization:manage (admin) may configure clearance rules, which is
-- configuration, not a way to clear holds.
ALTER TABLE public.equipment_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equipment_hold FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_read ON public.equipment_hold FOR SELECT
  USING (organization_id = public.auth_organization_id() AND public.auth_has_permission('inventory:read'));
CREATE POLICY auth_insert ON public.equipment_hold FOR INSERT
  WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission('equipment:write'));
CREATE POLICY auth_clear ON public.equipment_hold FOR UPDATE
  USING (organization_id = public.auth_organization_id() AND EXISTS (
    SELECT 1 FROM public.hold_clearance_rule r JOIN public.auth_membership m ON m.organization_id = r.organization_id
    WHERE r.organization_id = equipment_hold.organization_id AND r.kind = equipment_hold.kind
      AND m.user_id = public.auth_user_id() AND m.active AND m.role = r.role))
  WITH CHECK (organization_id = public.auth_organization_id());
ALTER TABLE public.hold_clearance_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hold_clearance_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_read ON public.hold_clearance_rule FOR SELECT
  USING (organization_id = public.auth_organization_id() AND public.auth_has_permission('inventory:read'));
CREATE POLICY auth_insert ON public.hold_clearance_rule FOR INSERT
  WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission('organization:manage'));
CREATE POLICY auth_update ON public.hold_clearance_rule FOR UPDATE
  USING (organization_id = public.auth_organization_id() AND public.auth_has_permission('organization:manage'))
  WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission('organization:manage'));
