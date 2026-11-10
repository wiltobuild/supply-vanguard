-- Restores the 0002 body of clear_equipment_hold_with_evidence() (replay checked by receipt only). Grants are unchanged.
CREATE OR REPLACE FUNCTION public.clear_equipment_hold_with_evidence(p_hold uuid, p_key text, p_hash text, p_reference text, p_observed_at timestamptz, p_note text)
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
