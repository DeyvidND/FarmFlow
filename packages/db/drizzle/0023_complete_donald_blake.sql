CREATE INDEX IF NOT EXISTS "delivery_slots_tenant_date_idx" ON "delivery_slots" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "farmers_tenant_position_idx" ON "farmers" USING btree ("tenant_id","position","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "newsletter_subscribers_tenant_created_idx" ON "newsletter_subscribers" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_tenant_created_idx" ON "orders" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_tenant_status_idx" ON "orders" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_slot_idx" ON "orders" USING btree ("slot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_tenant_created_idx" ON "products" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_tenant_status_created_idx" ON "reviews" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_tenant_idx" ON "shipments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcategories_tenant_position_idx" ON "subcategories" USING btree ("tenant_id","position","created_at");