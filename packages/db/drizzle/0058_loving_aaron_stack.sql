CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"tenant_id" uuid,
	"file_name" text,
	"carrier_default" text DEFAULT 'econt' NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"status" text DEFAULT 'validating' NOT NULL,
	"settings" jsonb,
	"ai_report" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"batch_id" uuid NOT NULL,
	"tenant_id" uuid,
	"row_index" integer NOT NULL,
	"raw" jsonb,
	"receiver_name" text,
	"receiver_phone" text,
	"delivery_mode" text,
	"city" text,
	"office" text,
	"address" text,
	"street_no" text,
	"weight_grams" integer,
	"contents" text,
	"cod_amount_stotinki" integer,
	"declared_value_stotinki" integer,
	"carrier" text DEFAULT 'econt' NOT NULL,
	"validation_status" text DEFAULT 'error' NOT NULL,
	"validation" jsonb,
	"resolved_refs" jsonb,
	"shipment_id" uuid,
	"create_status" text,
	"create_error" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batches_tenant_idx" ON "import_batches" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "import_rows_batch_idx" ON "import_rows" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "import_rows_tenant_idx" ON "import_rows" USING btree ("tenant_id");