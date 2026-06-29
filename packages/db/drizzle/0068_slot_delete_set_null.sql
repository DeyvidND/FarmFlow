-- Deleting a delivery slot must orphan (not block) any order that referenced it.
-- The FK was ON DELETE NO ACTION, so hard-deleting a slot that any order pointed
-- at — even a cancelled one — failed with a foreign-key violation (500). The app
-- layer refuses to delete a slot with a LIVE order; cancelled orders should just
-- detach. SET NULL gives exactly that (orders.slot_id is nullable).
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_slot_id_delivery_slots_id_fk";
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_slot_id_delivery_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."delivery_slots"("id") ON DELETE set null ON UPDATE no action;
