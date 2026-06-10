ALTER TABLE "audit_logs" ADD COLUMN "admin_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_platform_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."platform_admins"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
