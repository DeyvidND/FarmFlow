CREATE TABLE IF NOT EXISTS "route_courier_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "date" text NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "leg_index" smallint NOT NULL,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "route_courier_assign_tenant_date_account_uniq" UNIQUE ("tenant_id", "date", "account_id"),
  CONSTRAINT "route_courier_assign_tenant_date_leg_uniq" UNIQUE ("tenant_id", "date", "leg_index")
);
