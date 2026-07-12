-- Task #9/#10: turnover-by-basis needs the day an order was ACTUALLY delivered,
-- distinct from order-placed day (created_at) and scheduled delivery day
-- (delivery_slots.date). NULL until the order first transitions into 'delivered'.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill legacy delivered orders so historical turnover-by-delivered-day is not
-- empty for them. Best available proxy, in priority order: the COD money-outcome
-- timestamp (set when the farmer marked cash collected — usually at/near delivery),
-- else the Stripe paid timestamp, else created_at as a last resort.
UPDATE "orders"
SET "delivered_at" = COALESCE("cod_outcome_at", "paid_at", "created_at")
WHERE "status" = 'delivered' AND "delivered_at" IS NULL;
--> statement-breakpoint
-- Turnover-by-delivered-day bucketing / to-date sums (partial: most orders are
-- never delivered-at-NULL forever, but plenty are pending/confirmed at any time).
CREATE INDEX IF NOT EXISTS "orders_tenant_delivered_idx" ON "orders" ("tenant_id", "delivered_at") WHERE "delivered_at" IS NOT NULL;
