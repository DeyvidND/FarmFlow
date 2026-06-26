-- Product variants (вид/грамаж) + promotional pricing.
-- product_variants: flat per-product priced+stocked options (one product, many prices).
-- products.sale_percent/sale_ends_at: % promo applied proportionally to base + variants.
-- order_items.variant_id/variant_label: per-line variant snapshot (label survives renames).
-- All additive + nullable → backward-compatible; the storefront keeps working until updated.
CREATE TABLE IF NOT EXISTS "product_variants" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "product_id" uuid NOT NULL,
  "label" text NOT NULL,
  "price_stotinki" integer NOT NULL,
  "stock_quantity" integer,
  "position" integer DEFAULT 0 NOT NULL,
  "deleted_at" timestamp,
  "created_at" timestamp DEFAULT now()
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_variants_product_position_idx"
  ON "product_variants" ("product_id","position","id");--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "sale_percent" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "sale_ends_at" timestamp;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "variant_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "variant_label" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fk"
    FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
