-- Apply after db/migrations/0001_core. Creates no database roles or credentials.
CREATE TABLE public.auth_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL CHECK (length(btrim(issuer)) BETWEEN 1 AND 500),
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 500),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (issuer, subject)
);
CREATE TABLE public.auth_membership (
  organization_id uuid NOT NULL REFERENCES public.organization(id),
  user_id uuid NOT NULL REFERENCES public.auth_user(id),
  role text NOT NULL CHECK (role IN ('viewer', 'operator', 'supply_manager', 'equipment_manager', 'admin')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (organization_id, user_id)
);

CREATE FUNCTION public.auth_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('sv.user_id', true), '')::uuid
$$;
CREATE FUNCTION public.auth_organization_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('sv.organization_id', true), '')::uuid
$$;

ALTER TABLE public.auth_user ENABLE ROW LEVEL SECURITY;
-- Deliberately not FORCE on auth_user: its table owner resolves verified identities below.
-- The runtime connection must be a separate non-owner role with NOBYPASSRLS.
CREATE POLICY auth_user_self ON public.auth_user FOR SELECT
  USING (id = public.auth_user_id());
ALTER TABLE public.auth_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_membership FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_membership_self ON public.auth_membership FOR SELECT
  USING (user_id = public.auth_user_id() AND organization_id = public.auth_organization_id());

-- Only this narrow function runs as its owner. It exposes an ID, never roles or a token.
-- Fixed search path and qualified references prevent object substitution by a runtime role.
CREATE FUNCTION public.auth_resolve_identity(verified_issuer text, verified_subject text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT id FROM public.auth_user WHERE issuer = verified_issuer AND subject = verified_subject AND active
$$;
REVOKE ALL ON FUNCTION public.auth_resolve_identity(text, text) FROM PUBLIC;

CREATE FUNCTION public.auth_has_permission(permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.auth_membership m JOIN public.auth_user u ON u.id = m.user_id
    WHERE m.user_id = public.auth_user_id() AND m.organization_id = public.auth_organization_id()
      AND m.active AND u.active
      AND CASE m.role
        WHEN 'viewer' THEN permission = ANY(ARRAY['inventory:read'])
        WHEN 'operator' THEN permission = ANY(ARRAY['inventory:read', 'equipment:write'])
        WHEN 'supply_manager' THEN permission = ANY(ARRAY['inventory:read', 'supplies:write', 'audit:read', 'audit:export'])
        WHEN 'equipment_manager' THEN permission = ANY(ARRAY['inventory:read', 'equipment:write', 'equipment:manage', 'audit:read', 'audit:export'])
        WHEN 'admin' THEN permission = ANY(ARRAY['inventory:read', 'equipment:write', 'equipment:manage', 'supplies:write', 'audit:read', 'audit:export', 'organization:manage', 'membership:manage'])
        ELSE false
      END
  )
$$;

ALTER TABLE public.organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_read ON public.organization FOR SELECT
  USING (id = public.auth_organization_id() AND public.auth_has_permission('inventory:read'));
CREATE POLICY auth_update ON public.organization FOR UPDATE
  USING (id = public.auth_organization_id() AND public.auth_has_permission('organization:manage'))
  WITH CHECK (id = public.auth_organization_id() AND public.auth_has_permission('organization:manage'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['facility', 'ward', 'location', 'equipment_type', 'equipment', 'equipment_observation', 'equipment_event'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY auth_read ON public.%I FOR SELECT USING (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L))', t,
      CASE WHEN t = 'equipment_event' THEN 'audit:read' ELSE 'inventory:read' END);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['facility', 'ward', 'location', 'equipment_type'] LOOP
    EXECUTE format('CREATE POLICY auth_insert ON public.%I FOR INSERT WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L))', t, 'organization:manage');
    EXECUTE format('CREATE POLICY auth_update ON public.%I FOR UPDATE USING (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L)) WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L))', t, 'organization:manage', 'organization:manage');
    EXECUTE format('CREATE POLICY auth_delete ON public.%I FOR DELETE USING (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L))', t, 'organization:manage');
  END LOOP;
END $$;

CREATE POLICY auth_insert ON public.equipment FOR INSERT
  WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission('equipment:manage'));
CREATE POLICY auth_update ON public.equipment FOR UPDATE
  USING (organization_id = public.auth_organization_id() AND public.auth_has_permission('equipment:write'))
  WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission('equipment:write'));
CREATE POLICY auth_delete ON public.equipment FOR DELETE
  USING (organization_id = public.auth_organization_id() AND public.auth_has_permission('equipment:manage'));
CREATE POLICY auth_insert ON public.equipment_observation FOR INSERT
  WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission('equipment:write'));
CREATE POLICY auth_insert ON public.equipment_event FOR INSERT
  WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission('equipment:write'));
-- No UPDATE/DELETE policies for append-only records. No runtime membership/user mutation policies.
-- Existing triggers still enforce domain transitions, versions, and append-only history.
