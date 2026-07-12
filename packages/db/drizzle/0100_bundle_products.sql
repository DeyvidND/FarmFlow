-- Ready-made packages / „Фермерска кошница": a bundle product (products.category='bundle')
-- gets real, add/removable child product references (not just the free-text bundle_items
-- lines). Each row links a bundle to a member product with a quantity. Logistics-ready
-- (queryable membership). ON DELETE CASCADE both ways: dropping a bundle or a member removes
-- its links. Unique (bundle_id, product_id) so a member appears once per bundle.
CREATE TABLE IF NOT EXISTS "product_bundle_items" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "tenant_id" uuid REFERENCES "tenants"("id"),
  "bundle_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "quantity" integer NOT NULL DEFAULT 1,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "product_bundle_items_bundle_idx" ON "product_bundle_items" ("bundle_id","position","id");
CREATE UNIQUE INDEX IF NOT EXISTS "product_bundle_items_bundle_product_unique" ON "product_bundle_items" ("bundle_id","product_id");
CREATE INDEX IF NOT EXISTS "product_bundle_items_product_idx" ON "product_bundle_items" ("product_id");
