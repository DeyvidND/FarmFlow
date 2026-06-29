-- Phase 2: nationwide courier delivery per farmer.
-- 'courier' = a split single-farmer COD order shipped by the farmer's own carrier
-- (Econt/Speedy) from their own delivery account. farmer_id tags which farmer the
-- (split) order belongs to. NULL for legacy / local / pickup / Econt orders; set
-- only on courier-split orders. ON DELETE set null so removing a farmer never
-- blocks on the FK and keeps the order's history.
ALTER TYPE "public"."delivery_type" ADD VALUE 'courier';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "farmer_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_farmer_id_farmers_id_fk" FOREIGN KEY ("farmer_id") REFERENCES "public"."farmers"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "orders_farmer_idx" ON "orders" ("farmer_id");
