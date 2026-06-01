ALTER TABLE "products" ADD COLUMN "slug" text;--> statement-breakpoint
-- Backfill existing rows: slugify the name + an id suffix to stay unique per tenant.
-- (The seed sets clean transliterated slugs; this only covers pre-existing data.)
UPDATE "products" SET "slug" = lower(regexp_replace(trim("name"), '\s+', '-', 'g')) || '-' || substr("id"::text, 1, 8) WHERE "slug" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_tenant_slug_unique" ON "products" USING btree ("tenant_id","slug");