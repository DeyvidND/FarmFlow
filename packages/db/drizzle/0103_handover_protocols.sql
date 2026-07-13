-- Goods handover documents for own delivery: farmer→operator pickup protocol and
-- operator→customer delivery receipt, one table discriminated by `kind`. Snapshots freeze
-- both parties' legal/identity and the item lines at signing so a later edit can't mutate a
-- signed record; the PDF is regenerated deterministically from the row. `protocol_number` is
-- a per-tenant human sequence (like orders.order_number). NOT a fiscal receipt (Наредба Н-18).
CREATE TABLE IF NOT EXISTS "handover_protocols" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "tenant_id" uuid REFERENCES "tenants"("id"),
  "kind" text NOT NULL,
  "farmer_id" uuid REFERENCES "farmers"("id") ON DELETE SET NULL,
  "order_id" uuid REFERENCES "orders"("id") ON DELETE SET NULL,
  "slot_id" uuid REFERENCES "delivery_slots"("id") ON DELETE SET NULL,
  "protocol_number" integer,
  "from_snapshot" jsonb NOT NULL,
  "to_snapshot" jsonb NOT NULL,
  "items" jsonb NOT NULL,
  "order_ids" uuid[],
  "total_stotinki" integer NOT NULL DEFAULT 0,
  "from_signature_png" text,
  "to_signature_png" text,
  "sign_mode" text NOT NULL DEFAULT 'pending',
  "meta" jsonb,
  "status" text NOT NULL DEFAULT 'draft',
  "signed_at" timestamp with time zone,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "handover_tenant_created_idx" ON "handover_protocols" ("tenant_id","created_at","id");
CREATE UNIQUE INDEX IF NOT EXISTS "handover_tenant_number_unique" ON "handover_protocols" ("tenant_id","protocol_number");
CREATE INDEX IF NOT EXISTS "handover_farmer_idx" ON "handover_protocols" ("farmer_id");
CREATE INDEX IF NOT EXISTS "handover_order_idx" ON "handover_protocols" ("order_id");
