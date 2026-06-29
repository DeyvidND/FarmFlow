-- Per-farmer courier opt-in. Vasil (farmer-admin) toggles this from the tenant
-- "Фермери" section. Only courier-enabled farmers with a connected carrier offer
-- the storefront courier option (Phase 2).
ALTER TABLE "farmers" ADD COLUMN "courier_enabled" boolean DEFAULT false NOT NULL;
