ALTER TABLE "products" ADD COLUMN "bundle_items" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "compare_at_price_stotinki" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;