ALTER TABLE "tenants" ADD COLUMN "farm_address" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "farm_lat" numeric(10, 7);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "farm_lng" numeric(10, 7);