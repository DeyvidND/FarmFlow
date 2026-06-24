CREATE TABLE "cod_risk" (
	"phone" text PRIMARY KEY NOT NULL,
	"strikes" integer DEFAULT 0 NOT NULL,
	"last_event_type" text,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cod_risk_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"phone" text NOT NULL,
	"tenant_id" uuid,
	"shipment_id" uuid,
	"type" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "report_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "cod_risk_events" ADD CONSTRAINT "cod_risk_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_risk_events" ADD CONSTRAINT "cod_risk_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cod_risk_events_phone_idx" ON "cod_risk_events" USING btree ("phone");