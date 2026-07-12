CREATE TABLE "error_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"tenant_id" uuid,
	"path" text NOT NULL,
	"resolved_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "error_resolutions" ADD CONSTRAINT "error_resolutions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "error_resolutions_tenant_path_idx" ON "error_resolutions" USING btree ("tenant_id","path") WHERE "tenant_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "error_resolutions_platform_path_idx" ON "error_resolutions" USING btree ("path") WHERE "tenant_id" is null;
