-- Tier-2 „Бранд идентичност" per-farmer control layer (paid, operator-unlocked).
-- NULL = default compact marketplace card (today's behavior). Additive, nullable —
-- zero blast radius for existing farmers. See docs/tier2-brand-identity-spec.md.
ALTER TABLE farmers ADD COLUMN IF NOT EXISTS branding jsonb;
