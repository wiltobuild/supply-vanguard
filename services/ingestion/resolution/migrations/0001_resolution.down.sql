ALTER TABLE public.location_override DROP CONSTRAINT location_override_requires_audit;
DROP TABLE public.location_override_audit;
DROP TABLE public.location_override;
