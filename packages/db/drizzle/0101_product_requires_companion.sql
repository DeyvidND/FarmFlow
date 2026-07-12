-- Companion rule: a product flagged requires_companion can't be ordered alone — the cart must
-- also hold at least one OTHER distinct product („само кайсии не ми се разнасят"). Configurable
-- per product, not hardcoded. Enforced in OrdersService.reserveCartItems for every delivery
-- method, plus a storefront pre-check. Default false = today's behavior.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "requires_companion" boolean NOT NULL DEFAULT false;
