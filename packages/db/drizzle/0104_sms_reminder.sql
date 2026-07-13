CREATE TABLE IF NOT EXISTS "sms_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"tenant_id" uuid,
	"order_id" uuid,
	"phone" text NOT NULL,
	"body" text NOT NULL,
	"segments" smallint DEFAULT 1 NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"status" text NOT NULL,
	"error" text,
	"kind" text DEFAULT 'delivery_window' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sms_log" ADD CONSTRAINT "sms_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sms_log" ADD CONSTRAINT "sms_log_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_log_tenant_created_idx" ON "sms_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_log_order_idx" ON "sms_log" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_window_sms_at" timestamp with time zone;
