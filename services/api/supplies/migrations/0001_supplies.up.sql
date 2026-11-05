-- Apply after core and auth. Consumables never create serialized equipment records.
CREATE TABLE public.supply_sku (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organization(id),
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 200),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  unit text NOT NULL CHECK (unit ~ '^[a-z][a-z0-9_-]{0,31}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, code)
);
CREATE TABLE public.supply_bin (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  sku_id uuid NOT NULL,
  location_id uuid NOT NULL,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, code),
  FOREIGN KEY (organization_id, sku_id) REFERENCES public.supply_sku(organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES public.location(organization_id, id)
);
CREATE INDEX supply_bin_sku_idx ON public.supply_bin(organization_id, sku_id);
CREATE INDEX supply_bin_location_idx ON public.supply_bin(organization_id, location_id);
CREATE TABLE public.supply_bin_stock (
  organization_id uuid NOT NULL,
  bin_id uuid NOT NULL,
  quantity numeric(15,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (organization_id, bin_id),
  FOREIGN KEY (organization_id, bin_id) REFERENCES public.supply_bin(organization_id, id)
);
CREATE TABLE public.supply_stock_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  bin_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('adjustment', 'restock')),
  delta numeric(15,3) NOT NULL CHECK (delta <> 0),
  quantity_before numeric(15,3) NOT NULL CHECK (quantity_before >= 0),
  quantity_after numeric(15,3) GENERATED ALWAYS AS (quantity_before + delta) STORED CHECK (quantity_after >= 0),
  expected_version integer NOT NULL CHECK (expected_version >= 0 AND expected_version < 2147483647),
  version_after integer GENERATED ALWAYS AS (expected_version + 1) STORED,
  actor_id uuid NOT NULL REFERENCES public.auth_user(id),
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 100),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  correlation_id text CHECK (correlation_id IS NULL OR length(btrim(correlation_id)) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (kind <> 'restock' OR delta > 0),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, bin_id, expected_version),
  FOREIGN KEY (organization_id, bin_id) REFERENCES public.supply_bin_stock(organization_id, bin_id)
);
CREATE INDEX supply_stock_history_idx ON public.supply_stock_transaction(organization_id, bin_id, version_after);

CREATE FUNCTION public.supply_init_stock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.supply_bin_stock(organization_id, bin_id) VALUES (NEW.organization_id, NEW.id);
  RETURN NEW;
END $$;
CREATE FUNCTION public.supply_apply_stock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  -- UPDATE takes a row lock and rechecks the predicate after waiting for a concurrent writer.
  UPDATE public.supply_bin_stock SET quantity = NEW.quantity_after, version = NEW.version_after
    WHERE organization_id = NEW.organization_id AND bin_id = NEW.bin_id
      AND version = NEW.expected_version AND quantity = NEW.quantity_before;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock version conflict' USING ERRCODE = '40001'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.supply_init_stock(), public.supply_apply_stock() FROM PUBLIC;
CREATE TRIGGER supply_bin_init AFTER INSERT ON public.supply_bin FOR EACH ROW EXECUTE FUNCTION public.supply_init_stock();
-- AFTER INSERT is intentional: an ON CONFLICT retry must never apply a delta a second time.
CREATE TRIGGER supply_stock_apply AFTER INSERT ON public.supply_stock_transaction FOR EACH ROW EXECUTE FUNCTION public.supply_apply_stock();
CREATE TRIGGER supply_sku_immutable BEFORE UPDATE OR DELETE ON public.supply_sku FOR EACH ROW EXECUTE FUNCTION public.forbid_change();
CREATE TRIGGER supply_bin_immutable BEFORE UPDATE OR DELETE ON public.supply_bin FOR EACH ROW EXECUTE FUNCTION public.forbid_change();
CREATE TRIGGER supply_stock_immutable BEFORE UPDATE OR DELETE ON public.supply_stock_transaction FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['supply_sku', 'supply_bin', 'supply_bin_stock', 'supply_stock_transaction'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY supply_read ON public.%I FOR SELECT USING (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L))', t,
      CASE WHEN t = 'supply_stock_transaction' THEN 'audit:read' ELSE 'inventory:read' END);
    EXECUTE format('CREATE POLICY supply_insert ON public.%I FOR INSERT WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission(%L)%s)', t,
      'supplies:write', CASE WHEN t = 'supply_stock_transaction' THEN ' AND actor_id = public.auth_user_id()' ELSE '' END);
  END LOOP;
END $$;
-- Only the trigger owner receives table UPDATE privileges. Runtime has SELECT, never direct writes to balances.
CREATE POLICY supply_balance_update ON public.supply_bin_stock FOR UPDATE
  USING (organization_id = public.auth_organization_id() AND public.auth_has_permission('supplies:write'))
  WITH CHECK (organization_id = public.auth_organization_id() AND public.auth_has_permission('supplies:write'));
