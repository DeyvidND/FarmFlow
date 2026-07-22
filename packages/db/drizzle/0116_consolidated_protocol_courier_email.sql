-- 0116_consolidated_protocol_courier_email.sql
-- Per-LEG courier-email delivery state for §4.4 „Прати на куриерите": which
-- courier already received their own leg's обобщен protocol by email, which
-- send failed, and why. Lets „Прати на непратените" resend ONLY to the not-yet-
-- delivered legs (onlyFailed) instead of re-emailing every courier on each click.
-- Set on the scope='leg' row; a scope='day' row never carries these.
ALTER TABLE "consolidated_protocols" ADD COLUMN IF NOT EXISTS "courier_email_status" text;
ALTER TABLE "consolidated_protocols" ADD COLUMN IF NOT EXISTS "courier_email_at" timestamp with time zone;
ALTER TABLE "consolidated_protocols" ADD COLUMN IF NOT EXISTS "courier_email_error" text;
