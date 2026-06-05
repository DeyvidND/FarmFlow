ALTER TYPE "public"."subscription_status" ADD VALUE 'past_due' BEFORE 'inactive';--> statement-breakpoint
ALTER TABLE "email_pushes" ADD COLUMN "stripe_invoice_item_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "premium" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "grace_until" timestamp with time zone;