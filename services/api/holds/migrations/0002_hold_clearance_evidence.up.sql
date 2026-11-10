-- SV-031: clearance evidence for holds. Additive: 0001_holds is not rewritten and the legacy clear_equipment_hold() is unchanged.
-- Apply after 0001_holds. A supplied reference and observation are RECORDED ASSERTIONS. Nothing here says they are enough to clear
-- a hold: whether evidence is sufficient is an open owner decision (see README). The role check is the same one the legacy clear uses.
CREATE TABLE hold_clearance_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  hold_id uuid NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  reference text NOT NULL CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9 ._:#/-]{0,127}$'),
  observed_at timestamptz NOT NULL,
  note text CHECK (note IS NULL OR (length(note) <= 500 AND note !~ '[\x01-\x1f\x7f]')),
  recorded_by text NOT NULL CHECK (length(btrim(recorded_by)) > 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (observed_at <= recorded_at),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, hold_id),
  FOREIGN KEY (organization_id, hold_id) REFERENCES equipment_hold (organization_id, id)
);
-- Retry receipts. One per (organization, Idempotency-Key). Visible only to the actor who made them.
CREATE TABLE hold_clearance_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,88}$'),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  hold_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, hold_id) REFERENCES equipment_hold (organization_id, id),
  FOREIGN KEY (organization_id, evidence_id) REFERENCES hold_clearance_evidence (organization_id, id)
);
CREATE TRIGGER hold_clearance_evidence_append_only BEFORE UPDATE OR DELETE ON hold_clearance_evidence
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER hold_clearance_receipt_append_only BEFORE UPDATE OR DELETE ON hold_clearance_receipt
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Clear a hold WITH evidence, atomically: the clearance, the evidence and the retry receipt all commit, or none does.
-- The actor and the time come from the database (the authenticated session and now()), never from the request. The role is read from
-- the caller's own active membership, exactly as in the legacy clear. A per-hold advisory lock serializes concurrent attempts on one hold.
-- Every refusal carries a stable code in the message ('sv:...'). Conflicts never reveal who else used a key.
CREATE FUNCTION public.clear_equipment_hold_with_evidence(p_hold uuid, p_key text, p_hash text, p_reference text, p_observed_at timestamptz, p_note text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  org uuid := public.auth_organization_id();
  uid uuid := public.auth_user_id();
  actor text;
  h equipment_hold%ROWTYPE;
  r hold_clearance_receipt%ROWTYPE;
  need text;
  ev uuid;
  done uuid;
BEGIN
  IF org IS NULL OR uid IS NULL THEN RAISE EXCEPTION 'sv:no_tenant_context' USING ERRCODE = '42501'; END IF;
  actor := 'user:' || uid::text;
  PERFORM pg_advisory_xact_lock(hashtextextended('sv:hold-clear:' || p_hold::text, 0));
  SELECT * INTO h FROM equipment_hold WHERE organization_id = org AND id = p_hold;
  IF NOT FOUND THEN RAISE EXCEPTION 'sv:hold_not_found' USING ERRCODE = 'SV404'; END IF;
  -- Retry: this caller's own receipt for the key. An exact repeat returns the original outcome; anything else is a conflict.
  SELECT * INTO r FROM hold_clearance_receipt WHERE organization_id = org AND idempotency_key = p_key;
  IF FOUND THEN
    IF r.request_hash = p_hash AND r.hold_id = p_hold THEN
      RETURN jsonb_build_object('holdId', r.hold_id, 'evidenceId', r.evidence_id, 'cleared', true, 'replayed', true);
    END IF;
    RAISE EXCEPTION 'sv:idempotency_conflict' USING ERRCODE = 'SV409';
  END IF;
  IF NOT h.active THEN RAISE EXCEPTION 'sv:hold_already_cleared' USING ERRCODE = 'SV409'; END IF;
  SELECT role INTO need FROM hold_clearance_rule WHERE organization_id = org AND kind = h.kind;
  IF need IS NULL THEN RAISE EXCEPTION 'sv:no_clearance_rule' USING ERRCODE = 'SV422'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth_membership WHERE organization_id = org AND user_id = uid AND active AND role = need) THEN
    RAISE EXCEPTION 'sv:wrong_role' USING ERRCODE = 'SV403';
  END IF;
  -- Defense in depth: the API validates the same shape, and the table constraints check it again.
  IF p_reference IS NULL OR p_reference !~ '^[A-Za-z0-9][A-Za-z0-9 ._:#/-]{0,127}$' OR p_observed_at IS NULL OR p_observed_at > now()
     OR (p_note IS NOT NULL AND (length(p_note) > 500 OR p_note ~ '[\x01-\x1f\x7f]')) THEN
    RAISE EXCEPTION 'sv:evidence_invalid' USING ERRCODE = 'SV422';
  END IF;
  UPDATE equipment_hold SET active = false, cleared_by = actor, cleared_at = now()
    WHERE organization_id = org AND id = p_hold AND active RETURNING id INTO done;
  IF done IS NULL THEN RAISE EXCEPTION 'sv:hold_already_cleared' USING ERRCODE = 'SV409'; END IF;
  INSERT INTO hold_clearance_evidence (organization_id, hold_id, schema_version, reference, observed_at, note, recorded_by)
    VALUES (org, p_hold, 1, p_reference, p_observed_at, p_note, actor) RETURNING id INTO ev;
  BEGIN
    INSERT INTO hold_clearance_receipt (organization_id, idempotency_key, actor, request_hash, hold_id, evidence_id)
      VALUES (org, p_key, actor, p_hash, p_hold, ev);
  EXCEPTION WHEN unique_violation THEN
    -- The key already belongs to someone else (their receipt is invisible to this caller). The same answer as any other conflict.
    RAISE EXCEPTION 'sv:idempotency_conflict' USING ERRCODE = 'SV409';
  END;
  RETURN jsonb_build_object('holdId', done, 'evidenceId', ev, 'cleared', true, 'replayed', false);
END $$;
REVOKE ALL ON FUNCTION public.clear_equipment_hold_with_evidence(uuid, text, text, text, timestamptz, text) FROM PUBLIC;

-- Row-level security on the SV-005 context. Evidence is readable with inventory:read. It can be written only by a member whose role
-- is the one configured for that hold's kind (the same rule as clearing). Receipts are visible and writable only by their own actor.
-- No update or delete policy exists, and the append-only triggers refuse both for every role.
ALTER TABLE public.hold_clearance_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hold_clearance_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_read ON public.hold_clearance_evidence FOR SELECT
  USING (organization_id = public.auth_organization_id() AND public.auth_has_permission('inventory:read'));
CREATE POLICY auth_insert ON public.hold_clearance_evidence FOR INSERT
  WITH CHECK (organization_id = public.auth_organization_id() AND EXISTS (
    SELECT 1 FROM public.equipment_hold h
    JOIN public.hold_clearance_rule r ON r.organization_id = h.organization_id AND r.kind = h.kind
    JOIN public.auth_membership m ON m.organization_id = h.organization_id AND m.user_id = public.auth_user_id() AND m.active AND m.role = r.role
    WHERE h.organization_id = hold_clearance_evidence.organization_id AND h.id = hold_clearance_evidence.hold_id));
ALTER TABLE public.hold_clearance_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hold_clearance_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_read ON public.hold_clearance_receipt FOR SELECT
  USING (organization_id = public.auth_organization_id() AND actor = 'user:' || public.auth_user_id()::text);
CREATE POLICY auth_insert ON public.hold_clearance_receipt FOR INSERT
  WITH CHECK (organization_id = public.auth_organization_id() AND actor = 'user:' || public.auth_user_id()::text);
