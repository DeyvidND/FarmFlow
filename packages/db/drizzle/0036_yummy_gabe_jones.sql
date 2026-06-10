ALTER TABLE "article_media" DROP CONSTRAINT "article_media_article_id_articles_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "newsletter_subscribers_tenant_email_idx";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_media" ADD CONSTRAINT "article_media_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_messages_tenant_created_idx" ON "contact_messages" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_farmer_idx" ON "products" USING btree ("farmer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_subcategory_idx" ON "products" USING btree ("subcategory_id");--> statement-breakpoint
-- Remove any pre-existing duplicate (tenant_id, email) rows (keep the oldest) so the
-- UNIQUE index below can be created. New inserts use ON CONFLICT DO NOTHING.
DELETE FROM "newsletter_subscribers" a USING "newsletter_subscribers" b WHERE a.ctid > b.ctid AND a.tenant_id = b.tenant_id AND a.email = b.email;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "newsletter_subscribers_tenant_email_idx" ON "newsletter_subscribers" USING btree ("tenant_id","email");