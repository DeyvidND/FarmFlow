-- Phase 3: per-farmer courier shipments. Which farmer owns/ships this parcel --
-- copied from orders.farmer_id when the draft is created. NULL for legacy /
-- marketplace (tenant-level) Econt/Speedy shipments. Lets the dostavki list +
-- COD reconciliation scope to a single farmer (previously returned []).
--
-- IDEMPOTENT: the drizzle node-postgres migrator runs these statement-breakpoints in
-- autocommit (no wrapping transaction), so a deploy that died after ADD COLUMN but
-- before the migration was recorded left the column in place and a retry failed with
-- "column already exists". IF NOT EXISTS / DROP-then-ADD make every statement
-- re-runnable from any partial state.
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "farmer_id" uuid;--> statement-breakpoint
ALTER TABLE "shipments" DROP CONSTRAINT IF EXISTS "shipments_farmer_id_farmers_id_fk";--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_farmer_id_farmers_id_fk" FOREIGN KEY ("farmer_id") REFERENCES "public"."farmers"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_tenant_farmer_idx" ON "shipments" ("tenant_id","farmer_id");
