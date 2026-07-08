-- Full audit 2026-07-08: hot-path indexes + purchase idempotency.
-- IF NOT EXISTS so a re-run / partially-applied env is safe.

-- Econt/Speedy panel shipments list + super-admin listDeliveryShipments keyset
-- on (tenant_id, created_at desc, id). Was an unbounded scan of the tenant's
-- whole shipment history via shipments_tenant_idx.
CREATE INDEX IF NOT EXISTS "shipments_tenant_created_idx" ON "shipments" USING btree ("tenant_id","created_at","id");
--> statement-breakpoint

-- Super-admin audit feed: unfiltered view is ORDER BY created_at desc, id desc
-- with no tenant/farmer filter. No created_at-leading index existed, so every
-- page seq-scanned + sorted the whole audit_logs table.
CREATE INDEX IF NOT EXISTS "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at","id");
--> statement-breakpoint

-- Purchase idempotency. recordPurchase used a check-then-insert that (a) was not
-- atomic — Stripe's twin webhooks could both see "no row" and both insert,
-- inflating funnel purchase counts — and (b) had no order_id index, so the guard
-- scanned every purchase row the tenant ever recorded. A partial unique index lets
-- the insert use ON CONFLICT DO NOTHING: race-free and O(log n).
-- Dedup any pre-existing duplicates first (keep the lowest id) or the CREATE fails.
DELETE FROM "site_events" a
  USING "site_events" b
  WHERE a."event_type" = 'purchase'
    AND b."event_type" = 'purchase'
    AND a."order_id" IS NOT NULL
    AND a."tenant_id" = b."tenant_id"
    AND a."order_id" = b."order_id"
    AND a."id" > b."id";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "site_events_purchase_order_uniq"
  ON "site_events" USING btree ("tenant_id","order_id")
  WHERE "event_type" = 'purchase';
