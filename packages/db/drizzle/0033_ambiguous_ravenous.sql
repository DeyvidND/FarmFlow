ALTER TABLE "tenants" ADD COLUMN "articles_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "reviews_enabled" boolean DEFAULT true NOT NULL;