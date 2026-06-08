ALTER TABLE "delivery_slots" ADD COLUMN "customer_note" text;--> statement-breakpoint
ALTER TABLE "delivery_slots" ADD COLUMN "driver_note" text;--> statement-breakpoint
ALTER TABLE "delivery_slots" ADD COLUMN "generated" boolean DEFAULT false NOT NULL;