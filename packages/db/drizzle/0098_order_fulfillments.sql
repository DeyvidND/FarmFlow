-- Task #14: per-farmer, per-order fulfilment self-tracking. A farmer marks each of
-- TOMORROW's orders in_production / fulfilled from the «Утре» panel (built off the
-- daily "tomorrow" email); the owner sees who is behind. One row per (order, farmer)
-- pair — a shared multi-farmer order gets one independent row per producer, so one
-- producer's farm running behind never blocks another's status on the same order.
CREATE TABLE IF NOT EXISTS "order_fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"tenant_id" uuid,
	"order_id" uuid,
	"farmer_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_fulfillments" ADD CONSTRAINT "order_fulfillments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_fulfillments" ADD CONSTRAINT "order_fulfillments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_fulfillments" ADD CONSTRAINT "order_fulfillments_farmer_id_farmers_id_fk" FOREIGN KEY ("farmer_id") REFERENCES "public"."farmers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- One state row per (order, farmer) — re-marking updates, never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS "order_fulfillments_order_farmer_uniq" ON "order_fulfillments" ("order_id","farmer_id");
--> statement-breakpoint
-- «Утре» panel: this farmer's fulfilment rows, tenant-scoped.
CREATE INDEX IF NOT EXISTS "order_fulfillments_tenant_farmer_idx" ON "order_fulfillments" ("tenant_id","farmer_id");
