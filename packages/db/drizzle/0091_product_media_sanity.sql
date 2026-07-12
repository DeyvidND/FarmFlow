ALTER TABLE "product_media" ADD COLUMN IF NOT EXISTS "original_url" text;
--> statement-breakpoint
ALTER TABLE "product_media" ADD COLUMN IF NOT EXISTS "auto_fixed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "product_media" ADD COLUMN IF NOT EXISTS "sanity_verdict" text;
--> statement-breakpoint
ALTER TABLE "product_media" ADD COLUMN IF NOT EXISTS "sanity_reason" text;
