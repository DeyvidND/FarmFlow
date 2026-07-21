-- 0111_handover_signatures.sql
-- Reusable, encrypted per-party signatures for handover protocols.
ALTER TABLE farmers ADD COLUMN IF NOT EXISTS signature_png text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS operator_signature_png text;
