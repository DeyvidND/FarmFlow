-- Data migration: rebrand the stored CDN host cdn.farmsteadflow.com -> cdn.fermeribg.com.
-- Image URLs are persisted as ABSOLUTE urls (StorageService.upload returns the full
-- public url, callers store it verbatim), so the old host is baked into every image
-- column + HTML body + settings/blocks JSONB. This rewrites them in place so the
-- farmsteadflow.com Cloudflare zone can be retired without 404-ing existing images.
-- Idempotent: each UPDATE is guarded by a LIKE on the old host (no-op once migrated,
-- and won't touch rows that never referenced it). JSONB is rewritten via ::text so
-- only the hostname inside string values changes — structure stays valid JSON.

-- Catalog image_url columns
UPDATE "products" SET "image_url" = replace("image_url", 'cdn.farmsteadflow.com', 'cdn.fermeribg.com') WHERE "image_url" LIKE '%cdn.farmsteadflow.com%';--> statement-breakpoint
UPDATE "farmers" SET "image_url" = replace("image_url", 'cdn.farmsteadflow.com', 'cdn.fermeribg.com') WHERE "image_url" LIKE '%cdn.farmsteadflow.com%';--> statement-breakpoint
UPDATE "subcategories" SET "image_url" = replace("image_url", 'cdn.farmsteadflow.com', 'cdn.fermeribg.com') WHERE "image_url" LIKE '%cdn.farmsteadflow.com%';--> statement-breakpoint

-- Gallery media urls
UPDATE "product_media" SET "url" = replace("url", 'cdn.farmsteadflow.com', 'cdn.fermeribg.com') WHERE "url" LIKE '%cdn.farmsteadflow.com%';--> statement-breakpoint
UPDATE "farmer_media" SET "url" = replace("url", 'cdn.farmsteadflow.com', 'cdn.fermeribg.com') WHERE "url" LIKE '%cdn.farmsteadflow.com%';--> statement-breakpoint
UPDATE "subcategory_media" SET "url" = replace("url", 'cdn.farmsteadflow.com', 'cdn.fermeribg.com') WHERE "url" LIKE '%cdn.farmsteadflow.com%';--> statement-breakpoint

-- Articles: cover image + inline <img src> inside the sanitized HTML body
UPDATE "articles" SET "cover_image_url" = replace("cover_image_url", 'cdn.farmsteadflow.com', 'cdn.fermeribg.com') WHERE "cover_image_url" LIKE '%cdn.farmsteadflow.com%';--> statement-breakpoint
UPDATE "articles" SET "body" = replace("body", 'cdn.farmsteadflow.com', 'cdn.fermeribg.com') WHERE "body" LIKE '%cdn.farmsteadflow.com%';--> statement-breakpoint
UPDATE "article_media" SET "url" = replace("url", 'cdn.farmsteadflow.com', 'cdn.fermeribg.com') WHERE "url" LIKE '%cdn.farmsteadflow.com%';--> statement-breakpoint

-- JSONB: tenant branding/landing/slot media (settings) + newsletter block builder (blocks)
UPDATE "tenants" SET "settings" = replace("settings"::text, 'cdn.farmsteadflow.com', 'cdn.fermeribg.com')::jsonb WHERE "settings"::text LIKE '%cdn.farmsteadflow.com%';--> statement-breakpoint
UPDATE "newsletter_campaigns" SET "blocks" = replace("blocks"::text, 'cdn.farmsteadflow.com', 'cdn.fermeribg.com')::jsonb WHERE "blocks"::text LIKE '%cdn.farmsteadflow.com%';
