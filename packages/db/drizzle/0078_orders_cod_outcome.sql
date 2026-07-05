DO $$ BEGIN
  CREATE TYPE "cod_outcome" AS ENUM('received', 'refused');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cod_outcome" "cod_outcome";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cod_outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cod_outcome_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cod_outcome_source" text;--> statement-breakpoint
UPDATE "orders"
   SET "cod_outcome" = 'received',
       "cod_outcome_at" = COALESCE("paid_at", "created_at"),
       "cod_outcome_source" = 'manual'
 WHERE "payment_method" = 'cod' AND "status" = 'delivered' AND "cod_outcome" IS NULL;
