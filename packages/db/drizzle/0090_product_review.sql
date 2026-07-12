ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "needs_review" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_tenant_pending_review_idx" ON "products" ("tenant_id") WHERE "needs_review" = true;
