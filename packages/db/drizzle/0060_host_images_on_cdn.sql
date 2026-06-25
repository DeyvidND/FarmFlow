-- Data migration: move stored image hosts off the raw R2 dev URL
-- pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev -> cdn.fermeribg.com.
-- Image URLs are persisted as ABSOLUTE urls (StorageService.upload returns the full
-- public url, callers store it verbatim), so the old r2.dev host is baked into every
-- image column + HTML body + settings/blocks JSONB. Resend flags off-domain image
-- hosts (Gmail spam signal); serving images from the sending domain's subdomain fixes
-- the "Host images on the sending domain" deliverability warning. Mirrors 0052.
--
-- DEPLOY ORDER (critical): the cdn.fermeribg.com custom domain MUST already be attached
-- to the R2 bucket before this runs, or rewritten URLs 404. R2 serves both the dev URL
-- and the custom domain off the same bucket once attached, so old (pub-*.r2.dev) and new
-- (cdn.fermeribg.com) links coexist during cutover. Set R2_PUBLIC_URL=https://cdn.fermeribg.com
-- so NEW uploads use the cdn host too.
--
-- Idempotent: each UPDATE is guarded by a LIKE on the old host (no-op once migrated,
-- and won't touch rows that never referenced it). JSONB is rewritten via ::text so
-- only the hostname inside string values changes — structure stays valid JSON.

-- Catalog image_url columns
UPDATE "products" SET "image_url" = replace("image_url", 'pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev', 'cdn.fermeribg.com') WHERE "image_url" LIKE '%pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev%';--> statement-breakpoint
UPDATE "farmers" SET "image_url" = replace("image_url", 'pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev', 'cdn.fermeribg.com') WHERE "image_url" LIKE '%pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev%';--> statement-breakpoint
UPDATE "subcategories" SET "image_url" = replace("image_url", 'pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev', 'cdn.fermeribg.com') WHERE "image_url" LIKE '%pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev%';--> statement-breakpoint

-- Gallery media urls
UPDATE "product_media" SET "url" = replace("url", 'pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev', 'cdn.fermeribg.com') WHERE "url" LIKE '%pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev%';--> statement-breakpoint
UPDATE "farmer_media" SET "url" = replace("url", 'pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev', 'cdn.fermeribg.com') WHERE "url" LIKE '%pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev%';--> statement-breakpoint
UPDATE "subcategory_media" SET "url" = replace("url", 'pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev', 'cdn.fermeribg.com') WHERE "url" LIKE '%pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev%';--> statement-breakpoint

-- Articles: cover image + inline <img src> inside the sanitized HTML body
UPDATE "articles" SET "cover_image_url" = replace("cover_image_url", 'pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev', 'cdn.fermeribg.com') WHERE "cover_image_url" LIKE '%pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev%';--> statement-breakpoint
UPDATE "articles" SET "body" = replace("body", 'pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev', 'cdn.fermeribg.com') WHERE "body" LIKE '%pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev%';--> statement-breakpoint
UPDATE "article_media" SET "url" = replace("url", 'pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev', 'cdn.fermeribg.com') WHERE "url" LIKE '%pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev%';--> statement-breakpoint

-- JSONB: tenant branding/landing/slot media (settings) + newsletter block builder (blocks)
UPDATE "tenants" SET "settings" = replace("settings"::text, 'pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev', 'cdn.fermeribg.com')::jsonb WHERE "settings"::text LIKE '%pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev%';--> statement-breakpoint
UPDATE "newsletter_campaigns" SET "blocks" = replace("blocks"::text, 'pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev', 'cdn.fermeribg.com')::jsonb WHERE "blocks"::text LIKE '%pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev%';
