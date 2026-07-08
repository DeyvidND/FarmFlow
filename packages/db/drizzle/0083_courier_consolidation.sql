-- Courier shipment consolidation: a group of per-farmer courier draft shipments
-- (one customer, one destination) can be merged into ONE physical waybill. The
-- "master" is the collector farmer's shipment; its consolidation_group_id points
-- to its own id, and it collects the whole group's COD. The others become
-- status='consolidated' children whose consolidation_group_id points at the master.
ALTER TABLE "shipments"
  ADD COLUMN "consolidation_group_id" uuid REFERENCES "shipments"("id") ON DELETE SET NULL;

CREATE INDEX "shipments_consolidation_group_idx"
  ON "shipments" ("consolidation_group_id");
