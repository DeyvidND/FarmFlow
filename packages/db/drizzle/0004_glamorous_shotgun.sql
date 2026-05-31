CREATE TYPE "public"."delivery_type" AS ENUM('address', 'econt');--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "delivery_address" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "product_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "customer_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "customer_phone" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "customer_email" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_type" "delivery_type" DEFAULT 'address' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "econt_office" text;