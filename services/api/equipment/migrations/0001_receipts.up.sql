-- Apply transactionally after core and auth, with equipment writers quiesced.
CREATE TABLE public.equipment_command_receipt (
 organization_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 7 AND 106 AND left(idempotency_key,6) = 'admin:'),
 equipment_id uuid NOT NULL,
 actor_id uuid,
 legacy boolean NOT NULL DEFAULT false,
 request jsonb,
 result jsonb,
 correlation_id text,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id, idempotency_key),
 FOREIGN KEY (organization_id, equipment_id) REFERENCES public.equipment(organization_id,id),
 FOREIGN KEY (organization_id, actor_id) REFERENCES public.auth_membership(organization_id,user_id),
 CHECK ((legacy AND actor_id IS NULL AND request IS NULL AND result IS NULL)
     OR (NOT legacy AND actor_id IS NOT NULL AND jsonb_typeof(request) = 'object' AND request IS NOT NULL
         AND jsonb_typeof(result) = 'object' AND result IS NOT NULL))
);
-- Fail rather than silently omit legacy keys under RLS. The maintenance connection must
-- already be able to read all events; no new privilege or audit policy is installed.
SET LOCAL row_security = off;
INSERT INTO public.equipment_command_receipt (organization_id,idempotency_key,equipment_id,legacy)
 SELECT organization_id,idempotency_key,equipment_id,true FROM public.equipment_event
 WHERE left(idempotency_key,6) = 'admin:';
SET LOCAL row_security = on;
ALTER TABLE public.equipment_command_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equipment_command_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY receipt_read ON public.equipment_command_receipt FOR SELECT
 USING (organization_id = public.auth_organization_id() AND actor_id = public.auth_user_id()
        AND NOT legacy AND public.auth_has_permission('equipment:write'));
CREATE POLICY receipt_insert ON public.equipment_command_receipt FOR INSERT
 WITH CHECK (organization_id = public.auth_organization_id() AND actor_id = public.auth_user_id()
             AND NOT legacy AND public.auth_has_permission('equipment:write'));
CREATE TRIGGER equipment_command_receipt_append_only BEFORE UPDATE OR DELETE ON public.equipment_command_receipt
 FOR EACH ROW EXECUTE FUNCTION public.forbid_change();
-- Deployment grants SELECT, INSERT on this table to its existing runtime role explicitly.
-- No PUBLIC grants, UPDATE/DELETE grants or equipment_event policy/grant changes.
