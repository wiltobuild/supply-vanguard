-- Apply after core + auth. No roles, credentials, core changes or location resolution.
CREATE TABLE public.ingestion_nonce (
  organization_id uuid NOT NULL REFERENCES public.organization(id),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 64),
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 1 AND 100),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, source_id, nonce)
);
CREATE TABLE public.ingestion_receipt (
  organization_id uuid NOT NULL REFERENCES public.organization(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 100),
  observation_id uuid NOT NULL REFERENCES public.equipment_observation(id),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 64),
  user_id uuid NOT NULL REFERENCES public.auth_user(id),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key)
);
CREATE TABLE public.ingestion_dead_letter (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organization(id),
  user_id uuid NOT NULL REFERENCES public.auth_user(id),
  received_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason IN ('malformed', 'unauthorized-source', 'replay', 'replay-window', 'unknown-reference', 'idempotency-conflict')),
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^[a-f0-9]{64}$')
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ingestion_nonce', 'ingestion_receipt', 'ingestion_dead_letter'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY ingestion_read ON public.%I FOR SELECT USING (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L))', t,
      CASE WHEN t = 'ingestion_dead_letter' THEN 'audit:read' ELSE 'equipment:write' END);
    EXECUTE format('CREATE POLICY ingestion_insert ON public.%I FOR INSERT WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L)%s)', t, 'equipment:write',
      CASE WHEN t IN ('ingestion_receipt', 'ingestion_dead_letter') THEN ' AND user_id = public.auth_user_id()' ELSE '' END);
    EXECUTE format('CREATE TRIGGER ingestion_append_only BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.forbid_change()', t);
  END LOOP;
END $$;
