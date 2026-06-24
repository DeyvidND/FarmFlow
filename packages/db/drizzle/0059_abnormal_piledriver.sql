ALTER TABLE "import_batches" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "import_rows" ALTER COLUMN "tenant_id" SET NOT NULL;