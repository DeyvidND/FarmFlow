ALTER TABLE "products" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "product_of_week_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "product_of_week_mode" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "product_of_week_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "product_of_week_note" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenants" ADD CONSTRAINT "tenants_product_of_week_id_products_id_fk" FOREIGN KEY ("product_of_week_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_tenant_position_idx" ON "products" USING btree ("tenant_id","position","created_at","id");--> statement-breakpoint
UPDATE "products" p SET "position" = s.rn - 1
FROM (
  SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn
  FROM "products"
) s
WHERE p.id = s.id;