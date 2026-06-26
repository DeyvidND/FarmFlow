-- Durable Nekorekten snapshot on cod_risk.
-- Replaces the 7-day Redis cache (codrisk:nk:<phone>) with DB columns so results
-- survive restarts/eviction and can use adaptive TTLs (90d flagged / 30d clean).
-- All columns nullable: NULL nk_checked_at = "never checked against Nekorekten".
ALTER TABLE "cod_risk" ADD COLUMN "nk_found" boolean;--> statement-breakpoint
ALTER TABLE "cod_risk" ADD COLUMN "nk_count" integer;--> statement-breakpoint
ALTER TABLE "cod_risk" ADD COLUMN "nk_reports" jsonb;--> statement-breakpoint
ALTER TABLE "cod_risk" ADD COLUMN "nk_checked_at" timestamp with time zone;
