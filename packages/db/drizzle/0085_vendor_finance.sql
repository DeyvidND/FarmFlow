-- Vendor finance (DORMANT feature — no tenant has it enabled by default).
-- 1) commission_entries: per-(order, farmer) commission ledger. Gross = item-only
--    sum (delivery fee excluded, same rule as turnover). rate_bps is snapshotted at
--    accrual time so enabling commission later never retro-charges old orders.
-- 2) vendor_subscription_charges: per-farmer monthly fee tracker ('YYYY-MM'), the
--    operator collects the money off-platform and marks rows paid/waived.
-- 3) farmers gain per-farmer overrides (NULL = inherit tenant default from
--    tenants.settings.vendorFinance).
CREATE TYPE "public"."commission_entry_status" AS ENUM('accrued', 'voided', 'settled');
--> statement-breakpoint
CREATE TYPE "public"."vendor_charge_status" AS ENUM('due', 'paid', 'waived');
--> statement-breakpoint
ALTER TABLE "farmers" ADD COLUMN "commission_rate_bps" integer;
--> statement-breakpoint
ALTER TABLE "farmers" ADD COLUMN "subscription_fee_stotinki" integer;
--> statement-breakpoint
CREATE TABLE "commission_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"tenant_id" uuid,
	"order_id" uuid,
	"farmer_id" uuid,
	"gross_stotinki" integer NOT NULL,
	"rate_bps" integer NOT NULL,
	"commission_stotinki" integer NOT NULL,
	"status" "commission_entry_status" DEFAULT 'accrued' NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_farmer_id_farmers_id_fk" FOREIGN KEY ("farmer_id") REFERENCES "public"."farmers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "commission_entries_order_farmer_uniq" ON "commission_entries" USING btree ("order_id","farmer_id");
--> statement-breakpoint
CREATE INDEX "commission_entries_tenant_farmer_created_idx" ON "commission_entries" USING btree ("tenant_id","farmer_id","created_at");
--> statement-breakpoint
CREATE TABLE "vendor_subscription_charges" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"tenant_id" uuid,
	"farmer_id" uuid,
	"period" text NOT NULL,
	"fee_stotinki" integer NOT NULL,
	"status" "vendor_charge_status" DEFAULT 'due' NOT NULL,
	"paid_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "vendor_subscription_charges" ADD CONSTRAINT "vendor_subscription_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_subscription_charges" ADD CONSTRAINT "vendor_subscription_charges_farmer_id_farmers_id_fk" FOREIGN KEY ("farmer_id") REFERENCES "public"."farmers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_subscription_charges_farmer_period_uniq" ON "vendor_subscription_charges" USING btree ("farmer_id","period");
--> statement-breakpoint
CREATE INDEX "vendor_subscription_charges_tenant_period_idx" ON "vendor_subscription_charges" USING btree ("tenant_id","period");
