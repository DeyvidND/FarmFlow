ALTER TABLE "delivery_slots" ADD COLUMN IF NOT EXISTS "capacity" integer NOT NULL DEFAULT 1;
