-- Product-level fixed promo price (alternative to the % discount) for plain products.
-- NULL = no fixed promo. Mutually exclusive with sale_percent (a fixed price clears
-- the %). Varianted products use product_variants.sale_price_stotinki instead.
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_price_stotinki integer;
