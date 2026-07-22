-- 0113_consolidated_protocols.sql
-- Обобщен приемо-предавателен протокол за целия курс (scope='day') или един
-- куриерски лег (scope='leg'). Own numbering series (doc_number, printed
-- "ОБ-<n>"), separate from handover_protocols.protocol_number. Content is
-- NEVER stored while draft; only frozen_rows (populated at sign time) is.
CREATE TABLE IF NOT EXISTS "consolidated_protocols" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "scope" text NOT NULL,
  "date" date NOT NULL,
  "leg_index" integer,
  "doc_number" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "meta" jsonb,
  "overrides" jsonb,
  "frozen_rows" jsonb,
  "receiver_signature_png" text,
  "signed_at" timestamp with time zone,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "consolidated_protocols_tenant_doc_number_uniq" ON "consolidated_protocols" ("tenant_id","doc_number");
-- COALESCE is mandatory — see the schema.ts comment on tenantDateScopeLegUniq.
-- Without it, two scope='day' rows for the same tenant+date (both leg_index IS
-- NULL) do NOT collide in Postgres and a duplicate day protocol slips through.
CREATE UNIQUE INDEX IF NOT EXISTS "consolidated_protocols_tenant_date_scope_leg_uniq" ON "consolidated_protocols" ("tenant_id","date","scope",COALESCE("leg_index",-1));
