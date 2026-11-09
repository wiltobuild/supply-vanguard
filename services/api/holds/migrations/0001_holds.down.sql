DROP TRIGGER IF EXISTS item_assignment_block_on_hold ON item_assignment;
DROP FUNCTION IF EXISTS public.block_assignment_on_hold();
DROP FUNCTION IF EXISTS public.clear_equipment_hold(uuid, text);
DROP FUNCTION IF EXISTS public.place_equipment_hold(uuid, text, text, text);
DROP TABLE IF EXISTS equipment_hold, hold_clearance_rule CASCADE;
DROP FUNCTION IF EXISTS public.equipment_hold_guard();
