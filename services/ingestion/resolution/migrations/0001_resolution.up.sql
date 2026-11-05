-- SV-014: additive task-local tables only. Apply after core, auth and ingestion.
-- Minimal override facts support current inventory projection. Reason/actor/before-state
-- remain in the separately protected immutable audit, not inventory reads.
CREATE TABLE public.location_override (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  equipment_id uuid NOT NULL,
  location_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (observed_at <= starts_at AND starts_at < expires_at),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, equipment_id) REFERENCES public.equipment(organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES public.location(organization_id, id)
);
CREATE INDEX location_override_current_idx ON public.location_override(organization_id, equipment_id, starts_at DESC, id DESC);
CREATE TABLE public.location_override_audit (
  override_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.auth_user(id),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 100),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  correlation_id text CHECK (correlation_id IS NULL OR length(btrim(correlation_id)) BETWEEN 1 AND 100),
  policy jsonb NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, override_id) REFERENCES public.location_override(organization_id, id)
);
-- Facts cannot commit without their audit partner, including a direct runtime SQL caller.
ALTER TABLE public.location_override ADD CONSTRAINT location_override_requires_audit
  FOREIGN KEY (id) REFERENCES public.location_override_audit(override_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.location_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_override FORCE ROW LEVEL SECURITY;
ALTER TABLE public.location_override_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_override_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY resolution_read ON public.location_override FOR SELECT USING
  (organization_id = public.auth_organization_id() AND public.auth_has_permission('inventory:read'));
CREATE POLICY resolution_read ON public.location_override_audit FOR SELECT USING
  (organization_id = public.auth_organization_id() AND public.auth_has_permission('audit:read'));
CREATE POLICY resolution_insert ON public.location_override FOR INSERT WITH CHECK
  (organization_id = public.auth_organization_id() AND public.auth_has_permission('equipment:manage'));
CREATE POLICY resolution_insert ON public.location_override_audit FOR INSERT WITH CHECK
  (organization_id = public.auth_organization_id() AND user_id = public.auth_user_id()
    AND public.auth_has_permission('equipment:manage'));
CREATE TRIGGER resolution_append_only BEFORE UPDATE OR DELETE ON public.location_override
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();
CREATE TRIGGER resolution_append_only BEFORE UPDATE OR DELETE ON public.location_override_audit
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();
