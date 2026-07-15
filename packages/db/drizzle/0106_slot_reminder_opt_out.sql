-- Per-day opt-out for the day-of delivery-window reminder (sms-reminder module):
-- a farmer can suppress the reminder for one delivery day without disabling the
-- tenant-wide toggle. Defaults false (send) so every existing row keeps sending.
ALTER TABLE "delivery_slots" ADD COLUMN IF NOT EXISTS "reminder_opt_out" boolean NOT NULL DEFAULT false;
