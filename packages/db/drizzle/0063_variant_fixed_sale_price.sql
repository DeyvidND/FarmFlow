-- Per-variant fixed promo price (alternative to the product-level % promo).
-- NULL = the variant has no fixed promo (it follows the product's % if any).
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS sale_price_stotinki integer;
