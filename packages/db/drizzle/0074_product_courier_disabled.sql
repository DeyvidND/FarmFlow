ALTER TABLE products ADD COLUMN IF NOT EXISTS courier_disabled boolean NOT NULL DEFAULT false;
