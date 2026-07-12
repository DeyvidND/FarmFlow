-- Task #13: per-order delivery time window + notification state (own delivery).
-- Wall-clock Europe/Sofia times ('HH:MM'). status: draft (generated) → approved
-- (operator confirmed) → sent (customer notified). All additive + nullable; NULL
-- until a window is generated for the order. notified_at records when the customer
-- was emailed their window.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_window_start" time;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_window_end" time;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_window_status" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_window_notified_at" timestamp with time zone;
