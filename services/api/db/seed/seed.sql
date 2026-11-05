-- Synthetic data only. Mirrors packages/domain/seed.js and the 3D ward rooms. Safe to run once per empty database.
DO $$
DECLARE
  org uuid; fac uuid; w uuid;
BEGIN
  INSERT INTO organization (name) VALUES ('Demo organization (synthetic)') RETURNING id INTO org;
  INSERT INTO facility (organization_id, name) VALUES (org, 'Demo facility') RETURNING id INTO fac;
  INSERT INTO ward (organization_id, facility_id, name) VALUES (org, fac, 'NICU reference section') RETURNING id INTO w;
  INSERT INTO location (organization_id, ward_id, external_key, name, kind)
  SELECT org, w, k, n, kind FROM (VALUES
    ('room-101', 'Infant room 101', 'room'), ('room-102', 'Infant room 102', 'room'), ('room-103', 'Infant room 103', 'room'),
    ('room-104', 'Infant room 104', 'room'), ('room-105', 'Infant room 105', 'room'), ('room-106', 'Infant room 106', 'room'),
    ('clean-supply', 'Clean supply', 'room'), ('staff-base', 'Staff workroom', 'area'),
    ('equipment-store', 'Equipment store', 'store'), ('family-lounge', 'Family lounge', 'area')
  ) AS v (k, n, kind);
  INSERT INTO equipment_type (organization_id, model_kind, name) VALUES
    (org, 'incubator', 'Transport incubator'), (org, 'infusion', 'Infusion pump'), (org, 'monitor', 'Portable monitor'),
    (org, 'warmer', 'Radiant warmer'), (org, 'supply-cart', 'Bedside cart');
  INSERT INTO equipment (organization_id, external_id, name, equipment_type_id, location_id, status, provenance)
  SELECT org, e.ext, e.nm,
         (SELECT id FROM equipment_type t WHERE t.organization_id = org AND t.model_kind = e.kind),
         (SELECT id FROM location l WHERE l.organization_id = org AND l.external_key = e.loc),
         e.st, 'synthetic-seed'
  FROM (VALUES
    ('EQ-001', 'Transport incubator', 'incubator', 'equipment-store', 'available'),
    ('EQ-002', 'Infusion pump 01', 'infusion', 'room-101', 'in-use'),
    ('EQ-003', 'Infusion pump 02', 'infusion', 'equipment-store', 'available'),
    ('EQ-004', 'Portable monitor 01', 'monitor', 'room-102', 'in-use'),
    ('EQ-005', 'Portable monitor 02', 'monitor', 'equipment-store', 'maintenance'),
    ('EQ-006', 'Radiant warmer', 'warmer', 'room-103', 'cleaning'),
    ('EQ-007', 'Bedside cart 104', 'supply-cart', 'room-104', 'available'),
    ('EQ-008', 'Bedside cart 106', 'supply-cart', 'room-106', 'available')
  ) AS e (ext, nm, kind, loc, st);
END $$;
