DROP FUNCTION IF EXISTS public.clear_equipment_hold_with_evidence(uuid, text, text, text, timestamptz, text);
DROP TABLE IF EXISTS hold_clearance_receipt, hold_clearance_evidence CASCADE;
