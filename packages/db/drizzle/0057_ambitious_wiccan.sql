ALTER TABLE "shipments" ADD COLUMN "carrier" text DEFAULT 'econt' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracking_number" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "carrier_shipment_id" text;