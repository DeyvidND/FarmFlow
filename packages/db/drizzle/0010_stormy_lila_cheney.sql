ALTER TABLE "orders" ADD COLUMN "stripe_checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "stripe_payment_intent_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "stripe_product_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "stripe_price_id" text;