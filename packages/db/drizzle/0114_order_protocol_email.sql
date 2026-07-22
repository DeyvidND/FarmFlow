-- 0114_order_protocol_email.sql
-- Phase 2: track the bilateral protocol email sent at order confirm.
-- NUMBERING: renumbered to 0114 / idx 112 at the main merge (2026-07-22) —
-- main had already taken 0112 (order_item_bundle_parent) and this feature's
-- own consolidated-protocols migration takes 0113, so this is the next free.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS protocol_email_status text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS protocol_email_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS protocol_email_error text;
