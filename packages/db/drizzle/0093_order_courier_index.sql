-- Task #6: manual courier assignment for the route/маршрути screen (own delivery).
-- Additive, nullable. NULL = auto sweep-split by geography; a 0-based index pins the
-- order to that courier. Out-of-range values are ignored by the router (fall back to
-- auto), so lowering the courier count never breaks a stored assignment.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "courier_index" smallint;
