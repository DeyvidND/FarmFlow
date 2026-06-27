-- Perf audit 2026-06-27: indexes for hot query paths.
-- IF NOT EXISTS so a re-run / partially-applied env is safe.

-- Status-refresh crons (Econt + Speedy) and Speedy listShipments filter on
-- (carrier, status). Was a full-table scan over every shipment incl. terminal rows.
CREATE INDEX IF NOT EXISTS "shipments_carrier_status_idx" ON "shipments" USING btree ("carrier","status");
--> statement-breakpoint
-- cod-risk listCandidates: WHERE tenant_id = ? AND report_status = 'candidate'.
CREATE INDEX IF NOT EXISTS "shipments_tenant_report_idx" ON "shipments" USING btree ("tenant_id","report_status");
--> statement-breakpoint
-- Login matches case-insensitively (auth.service: lower(email) = ?). The unique
-- index on raw email can't serve it, so login was a full seq-scan of users.
-- Functional index makes it sargable. NON-unique: uniqueness already enforced by
-- users_email_unique on the raw column, and case-collisions in legacy rows must
-- not block the build.
CREATE INDEX IF NOT EXISTS "users_email_lower_idx" ON "users" USING btree (lower("email"));
