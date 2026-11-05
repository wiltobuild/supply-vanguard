-- Roll auth back before rolling the core database back.
DO $$
DECLARE t text; p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organization', 'facility', 'ward', 'location', 'equipment_type', 'equipment', 'equipment_observation', 'equipment_event'] LOOP
    FOREACH p IN ARRAY ARRAY['auth_read', 'auth_insert', 'auth_update', 'auth_delete'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
DROP FUNCTION public.auth_has_permission(text);
DROP FUNCTION public.auth_resolve_identity(text, text);
DROP TABLE public.auth_membership;
DROP TABLE public.auth_user;
DROP FUNCTION public.auth_organization_id();
DROP FUNCTION public.auth_user_id();
