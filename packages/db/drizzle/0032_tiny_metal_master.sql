CREATE TYPE "public"."payment_method" AS ENUM('online', 'cod');--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_method" "payment_method" DEFAULT 'online' NOT NULL;