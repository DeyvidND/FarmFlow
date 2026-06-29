-- Phase 3: per-farmer courier shipments. Which farmer owns/ships this parcel --
-- copied from orders.farmer_id when the draft is created. NULL for legacy /
-- marketplace (tenant-level) Econt/Speedy shipments. Lets the dostavki list +
-- COD reconciliation scope to a single farmer (previously returned []).
ALTER TABLE "shipments" ADD COLUMN "farmer_id" uuid;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_farmer_id_farmers_id_fk" FOREIGN KEY ("farmer_id") REFERENCES "public"."farmers"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "shipments_tenant_farmer_idx" ON "shipments" ("tenant_id","farmer_id");
