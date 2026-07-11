-- Marketplace ranking tier for farmers (operator-assigned). Additive, nullable-safe.
ALTER TABLE farmers ADD COLUMN IF NOT EXISTS tier smallint NOT NULL DEFAULT 1;
