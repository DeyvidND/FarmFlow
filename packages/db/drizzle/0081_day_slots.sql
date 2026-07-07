-- Day-based slots: a slot row is now a "delivery day" (date + capacity).
-- Times become nullable; NULL times = whole-day slot. Legacy rows keep times.
ALTER TABLE "delivery_slots" ALTER COLUMN "time_from" DROP NOT NULL;
ALTER TABLE "delivery_slots" ALTER COLUMN "time_to" DROP NOT NULL;

-- Merge every future (tenant, date) group of time slots into ONE day-row:
--  * canonical row = earliest time_from (NULLs first so an already-converted
--    day-row stays canonical; id tiebreak keeps it deterministic),
--  * orders repointed to the canonical row,
--  * canonical capacity = SUM of the group's capacities (day total preserved),
--  * times nulled, remaining rows deleted.
-- Past dates untouched (history keeps its hours).
CREATE TEMP TABLE _slot_canon AS
SELECT DISTINCT ON (tenant_id, date)
       id AS canon_id, tenant_id, date
FROM delivery_slots
WHERE date >= CURRENT_DATE
ORDER BY tenant_id, date, time_from ASC NULLS FIRST, id;

CREATE TEMP TABLE _slot_caps AS
SELECT tenant_id, date, SUM(capacity)::int AS total_cap
FROM delivery_slots
WHERE date >= CURRENT_DATE
GROUP BY tenant_id, date;

UPDATE orders o
SET slot_id = c.canon_id
FROM delivery_slots s
JOIN _slot_canon c
  ON c.tenant_id IS NOT DISTINCT FROM s.tenant_id AND c.date = s.date
WHERE o.slot_id = s.id
  AND s.id <> c.canon_id;

DELETE FROM delivery_slots s
USING _slot_canon c
WHERE c.tenant_id IS NOT DISTINCT FROM s.tenant_id
  AND c.date = s.date
  AND s.id <> c.canon_id;

UPDATE delivery_slots s
SET time_from = NULL,
    time_to   = NULL,
    is_active = true,
    capacity  = k.total_cap
FROM _slot_canon c
JOIN _slot_caps k
  ON k.tenant_id IS NOT DISTINCT FROM c.tenant_id AND k.date = c.date
WHERE s.id = c.canon_id;

DROP TABLE _slot_canon;
DROP TABLE _slot_caps;
