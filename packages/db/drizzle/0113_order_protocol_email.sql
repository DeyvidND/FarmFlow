-- 0113_order_protocol_email.sql
-- Phase 2: track the bilateral protocol email sent at order confirm.
-- NUMBERING: this worktree's journal tail was idx 110 / 0112_consolidated_protocols
-- (another phase's migration) as of 2026-07-22, so 0113 / idx 111 was the next
-- free slot at write time. If another branch also claims 0113 before this
-- merges, whoever merges SECOND must renumber this file + its _journal.json
-- entry (see plan doc "Assumptions" #1).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS protocol_email_status text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS protocol_email_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS protocol_email_error text;
