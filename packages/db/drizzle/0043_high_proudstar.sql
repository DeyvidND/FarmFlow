ALTER TYPE "public"."user_role" ADD VALUE 'farmer';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "farmer_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_farmer_id_farmers_id_fk" FOREIGN KEY ("farmer_id") REFERENCES "public"."farmers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_farmer_id_uniq" ON "users" USING btree ("farmer_id") WHERE "users"."farmer_id" is not null;