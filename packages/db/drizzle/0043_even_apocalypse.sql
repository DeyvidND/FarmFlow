CREATE TABLE "product_availability_windows" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"tenant_id" uuid,
	"product_id" uuid NOT NULL,
	"starts_at" date NOT NULL,
	"ends_at" date NOT NULL,
	"quantity" integer NOT NULL,
	"remaining" integer NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "availability_section_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "availability_title" text;--> statement-breakpoint
ALTER TABLE "product_availability_windows" ADD CONSTRAINT "product_availability_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_availability_windows" ADD CONSTRAINT "product_availability_windows_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_availability_windows_product_range_idx" ON "product_availability_windows" USING btree ("product_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "product_availability_windows_tenant_idx" ON "product_availability_windows" USING btree ("tenant_id");