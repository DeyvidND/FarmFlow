-- 0112 (journal idx 110) — basket order lines.
-- A „кошница" (products.category = 'bundle') explodes at checkout into one parent
-- line carrying the fixed basket price plus one zero-priced child line per member
-- product. Children point at the parent so prep, stock restore and the order view
-- can group them. CASCADE: dropping the basket line drops its children with it.
ALTER TABLE order_items
  ADD COLUMN bundle_parent_id uuid REFERENCES order_items(id) ON DELETE CASCADE;

CREATE INDEX order_items_bundle_parent_idx ON order_items (bundle_parent_id)
  WHERE bundle_parent_id IS NOT NULL;
