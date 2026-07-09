-- Server-side 5xx failures, written fire-and-forget by GlobalExceptionFilter.
-- Backs the super-admin cross-tenant "Проблеми" feed (GET /platform/problems):
-- recent errors grouped by farm/path so operator errors are visible without
-- digging through external Sentry.
CREATE TABLE "error_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"admin_id" uuid,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status_code" integer NOT NULL,
	"message" text,
	"stack" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_admin_id_platform_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."platform_admins"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "error_events_created_idx" ON "error_events" USING btree ("created_at","id");
--> statement-breakpoint
CREATE INDEX "error_events_tenant_idx" ON "error_events" USING btree ("tenant_id","created_at");
