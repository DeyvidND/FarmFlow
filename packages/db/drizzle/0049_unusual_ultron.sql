ALTER TABLE "tenants" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "demo_expires_at" timestamp with time zone;