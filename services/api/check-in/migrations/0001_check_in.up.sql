-- Apply after core and auth migrations, using the migration owner. No new runtime roles.
CREATE TABLE public.check_in_receipt (
 organization_id uuid NOT NULL REFERENCES public.organization(id),
 idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 80),
 user_id uuid NOT NULL REFERENCES public.auth_user(id),
 request jsonb NOT NULL,
 result jsonb,
 PRIMARY KEY (organization_id, idempotency_key)
);
ALTER TABLE public.check_in_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_in_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY check_in_read ON public.check_in_receipt FOR SELECT USING (
 organization_id = public.auth_organization_id() AND user_id = public.auth_user_id()
 AND public.auth_has_permission('equipment:write'));
CREATE POLICY check_in_insert ON public.check_in_receipt FOR INSERT WITH CHECK (
 organization_id = public.auth_organization_id() AND user_id = public.auth_user_id()
 AND public.auth_has_permission('equipment:write'));
CREATE POLICY check_in_finish ON public.check_in_receipt FOR UPDATE USING (
 organization_id = public.auth_organization_id() AND user_id = public.auth_user_id()
 AND public.auth_has_permission('equipment:write')) WITH CHECK (
 organization_id = public.auth_organization_id() AND user_id = public.auth_user_id()
 AND public.auth_has_permission('equipment:write'));
CREATE FUNCTION public.check_in_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'check-in receipts cannot be deleted'; END IF;
 IF OLD.result IS NOT NULL OR NEW.result IS NULL OR
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
    NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.request IS DISTINCT FROM OLD.request THEN
  RAISE EXCEPTION 'check-in receipt is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER check_in_receipt_immutable BEFORE UPDATE OR DELETE ON public.check_in_receipt
 FOR EACH ROW EXECUTE FUNCTION public.check_in_receipt_guard();
