-- Farmer profile v1: operator notes (private), long public story, payout account.
-- Three additive nullable columns on farmers. story is PUBLIC (added to the public
-- projection in findPublicBySlug); internal_notes + payout are operator-only.
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "internal_notes" text;
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "story" text;
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "payout" jsonb;
