ALTER TABLE newsletter_campaigns ADD COLUMN IF NOT EXISTS auto_generated boolean NOT NULL DEFAULT false;
