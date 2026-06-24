ALTER TABLE "shipments" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "receiver_name" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "receiver_phone" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "delivery_mode" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "receiver_office_code" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "receiver_city" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "receiver_address" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "weight_kg" numeric;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "contents" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "courier_request_id" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "courier_request_status" text;