-- Super-admin audit drill-down by producer. audit_logs.farmer_id records WHICH
-- farmer (producer sub-account) performed a mutation, when the actor is a
-- farmer-role login. NULL for owner/admin/system rows and all legacy rows
-- (no backfill) — producer drill-down is populated going forward.
--
-- IDEMPOTENT: the drizzle node-postgres migrator runs these statement-breakpoints in
-- autocommit (no wrapping transaction), so a deploy that died mid-migration must be
-- re-runnable. IF NOT EXISTS / DROP-then-ADD make every statement safe from any
-- partial state.
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "farmer_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_farmer_id_farmers_id_fk";--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_farmer_id_farmers_id_fk" FOREIGN KEY ("farmer_id") REFERENCES "public"."farmers"("id") ON DELETE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_farmer_idx" ON "audit_logs" ("farmer_id","created_at");
