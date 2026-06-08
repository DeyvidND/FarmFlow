CREATE INDEX IF NOT EXISTS "email_pushes_tenant_idx" ON "email_pushes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "newsletter_subscribers_tenant_email_idx" ON "newsletter_subscribers" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_stripe_pi_idx" ON "orders" USING btree ("stripe_payment_intent_id") WHERE "orders"."stripe_payment_intent_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_stripe_account_idx" ON "tenants" USING btree ("stripe_account_id") WHERE "tenants"."stripe_account_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_stripe_customer_idx" ON "tenants" USING btree ("stripe_customer_id") WHERE "tenants"."stripe_customer_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_stripe_subscription_idx" ON "tenants" USING btree ("stripe_subscription_id") WHERE "tenants"."stripe_subscription_id" is not null;