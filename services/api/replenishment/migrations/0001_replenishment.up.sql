-- Apply after core, auth and supplies. No default thresholds, roles, credentials or channels.
CREATE TABLE public.replenishment_par (
  organization_id uuid NOT NULL,
  bin_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  quantity numeric(15,3) NOT NULL CHECK (quantity >= 0),
  actor_id uuid NOT NULL REFERENCES public.auth_user(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, bin_id, version),
  FOREIGN KEY (organization_id, bin_id) REFERENCES public.supply_bin(organization_id, id)
);
CREATE TABLE public.replenishment_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  bin_id uuid NOT NULL,
  par_version integer NOT NULL,
  detected_quantity numeric(15,3) NOT NULL CHECK (detected_quantity >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','completed')),
  assignee_id uuid REFERENCES public.auth_user(id),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, bin_id, par_version) REFERENCES public.replenishment_par(organization_id, bin_id, version),
  CHECK ((status = 'open' AND assignee_id IS NULL AND completed_at IS NULL) OR
    (status = 'assigned' AND assignee_id IS NOT NULL AND completed_at IS NULL) OR
    (status = 'completed' AND assignee_id IS NOT NULL AND completed_at IS NOT NULL))
);
-- The active queue item IS the in-app alert. Repeated detection cannot create duplicate alerts.
CREATE UNIQUE INDEX replenishment_one_active_bin ON public.replenishment_task(organization_id, bin_id) WHERE status <> 'completed';
CREATE TABLE public.replenishment_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  bin_id uuid NOT NULL,
  task_id uuid,
  kind text NOT NULL CHECK (kind IN ('par-configured','low-par-detected','assigned','completed','count-corrected')),
  actor_id uuid NOT NULL REFERENCES public.auth_user(id),
  detail jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, bin_id) REFERENCES public.supply_bin(organization_id, id),
  FOREIGN KEY (organization_id, task_id) REFERENCES public.replenishment_task(organization_id, id)
);
CREATE INDEX replenishment_history ON public.replenishment_event(organization_id, bin_id, id);
CREATE TABLE public.replenishment_receipt (
  organization_id uuid NOT NULL REFERENCES public.organization(id),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  actor_id uuid NOT NULL REFERENCES public.auth_user(id),
  command jsonb NOT NULL,
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, idempotency_key)
);
CREATE TRIGGER replenishment_par_immutable BEFORE UPDATE OR DELETE ON public.replenishment_par FOR EACH ROW EXECUTE FUNCTION public.forbid_change();
CREATE TRIGGER replenishment_event_immutable BEFORE UPDATE OR DELETE ON public.replenishment_event FOR EACH ROW EXECUTE FUNCTION public.forbid_change();
CREATE TRIGGER replenishment_receipt_immutable BEFORE UPDATE OR DELETE ON public.replenishment_receipt FOR EACH ROW EXECUTE FUNCTION public.forbid_change();
-- Only workflow projection columns may change. Original detection and terminal state remain fixed.
CREATE FUNCTION public.replenishment_task_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.id,NEW.organization_id,NEW.bin_id,NEW.par_version,NEW.detected_quantity,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.bin_id,OLD.par_version,OLD.detected_quantity,OLD.created_at)
    OR NEW.version <> OLD.version + 1 OR NOT
    ((OLD.status='open' AND NEW.status='assigned' AND NEW.assignee_id=public.auth_user_id()) OR
     (OLD.status='assigned' AND NEW.status='completed' AND NEW.assignee_id=OLD.assignee_id AND OLD.assignee_id=public.auth_user_id()))
  THEN RAISE EXCEPTION 'invalid replenishment transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.replenishment_task_guard() FROM PUBLIC;
CREATE TRIGGER replenishment_task_transition BEFORE UPDATE ON public.replenishment_task FOR EACH ROW EXECUTE FUNCTION public.replenishment_task_guard();
CREATE TRIGGER replenishment_task_no_delete BEFORE DELETE ON public.replenishment_task FOR EACH ROW EXECUTE FUNCTION public.forbid_change();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['replenishment_par','replenishment_task','replenishment_event','replenishment_receipt'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY replenishment_read ON public.%I FOR SELECT USING (organization_id=public.auth_organization_id() AND public.auth_has_permission(%L))',t,
      CASE t WHEN 'replenishment_event' THEN 'audit:read' WHEN 'replenishment_receipt' THEN 'supplies:write' ELSE 'inventory:read' END);
    EXECUTE format('CREATE POLICY replenishment_insert ON public.%I FOR INSERT WITH CHECK (organization_id=public.auth_organization_id() AND public.auth_has_permission(''supplies:write'')%s)',t,
      CASE WHEN t='replenishment_task' THEN ' AND status=''open'' AND version=0 AND assignee_id IS NULL' ELSE ' AND actor_id=public.auth_user_id()' END);
  END LOOP;
END $$;
CREATE POLICY replenishment_update ON public.replenishment_task FOR UPDATE
  USING (organization_id=public.auth_organization_id() AND public.auth_has_permission('supplies:write'))
  WITH CHECK (organization_id=public.auth_organization_id() AND public.auth_has_permission('supplies:write'));
