DROP INDEX IF EXISTS "newsletter_subscribers_tenant_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_tenant_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "products_tenant_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "reviews_tenant_status_created_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "articles_tenant_created_idx" ON "articles" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_created_idx" ON "tenants" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "newsletter_subscribers_tenant_created_idx" ON "newsletter_subscribers" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_tenant_created_idx" ON "orders" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_tenant_created_idx" ON "products" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_tenant_status_created_idx" ON "reviews" USING btree ("tenant_id","status","created_at","id");