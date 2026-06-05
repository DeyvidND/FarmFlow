ALTER TABLE "orders" ADD COLUMN "order_number" integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_tenant_number_unique" ON "orders" USING btree ("tenant_id","order_number");--> statement-breakpoint
-- Backfill existing orders: number them per tenant in creation order (#1, #2, …).
UPDATE "orders" o
SET "order_number" = s.rn
FROM (
  SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn
  FROM "orders"
) s
WHERE o.id = s.id;