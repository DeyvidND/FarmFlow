-- 0111_manual_expenses.sql
-- Manual expenses table for farm-entered operational costs.
CREATE TABLE IF NOT EXISTS "manual_expenses" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "amount_stotinki" integer NOT NULL,
  "category" text NOT NULL,
  "courier_account_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "note" text,
  "created_at" timestamp DEFAULT now(),
  "created_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "manual_expenses_tenant_date_idx" ON "manual_expenses" ("tenant_id", "date");
CREATE INDEX IF NOT EXISTS "manual_expenses_tenant_courier_idx" ON "manual_expenses" ("tenant_id", "courier_account_id");
