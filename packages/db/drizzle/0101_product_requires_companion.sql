-- Companion rule (generalized „кайсии" combo): a product flagged requires_companion can't be
-- ordered alone — the cart must also hold at least one OTHER distinct product. Optionally that
-- companion must be worth at least `companion_min_price_stotinki` (EUR cents, same unit as
-- price_stotinki): „изисква още един продукт на стойност поне X €". NULL threshold = any other
-- product qualifies. Configurable per product/bundle, not hardcoded. Enforced in
-- OrdersService.reserveCartItems for every delivery method, plus a storefront pre-check.
-- Defaults (false / NULL) = today's behavior.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "requires_companion" boolean NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "companion_min_price_stotinki" integer;
