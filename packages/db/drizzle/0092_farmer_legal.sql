-- Farmer-as-seller marketplace: legal seller identity (КЗП/НАП disclosure).
-- Single additive nullable jsonb column mirroring farmers.branding / farmers.cover_crop.
-- NULL = not yet provided (a farmer without it can't be flipped to a live seller).
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "legal" jsonb;
