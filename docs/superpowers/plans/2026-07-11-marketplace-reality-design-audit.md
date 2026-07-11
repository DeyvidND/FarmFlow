# Marketplace Reality + Design Audit — farmmarket.bg

**Date:** 2026-07-11 · **Method:** 5 parallel Opus auditors (marketplace reality, backend wiring + break-risk, mobile/responsive, modern-marketplace design research) + firsthand live inspection of farmmarket.bg at 375px.

Answers the four questions: (1) does the marketplace actually work, (2) is it wired to the backend the same way as pazar chaika, (3) does the dormant vendor-finance work break anything, (4) is it mobile-perfect — plus a modern-marketplace (eMAG etc.) design direction.

---

## TL;DR

- **It works as a multi-vendor CATALOG, not yet a transactional MARKETPLACE.** The storefront genuinely renders per-farmer (directory, per-farmer pages, farmer-attributed products, farmer search, farmer-first home). But the money layer is single-shop: the cart is vendor-blind, checkout produces one flat order, and order-split / commission / payout are respectively dormant-behind-a-flag / built-dormant-on-a-branch / not-built.
- **Wiring parity: YES.** The marketplace uses the exact same `/public/:slug/bootstrap` bundle, endpoints, Redis cache and invalidation as single-tenant chaika. `multiFarmer` only decides whether the `farmers[]` array is populated. No special-casing.
- **Break risk from vendor-finance: essentially none, now hardened to zero.** The only storefront query touching the changed `farmers` table was a bare `.select()`; converted to an explicit column projection so it can never reference a not-yet-migrated column. Also, prod self-migrates on boot (`main.ts:37`) — see the deploy-model note.
- **Mobile: 8/10.** Strong mobile-first foundation; real bugs are a clipped product-card stepper on phones and sub-4.5:1 muted text.

---

## 1. Does the marketplace actually work?

**Verdict: multi-vendor catalog, not a transactional marketplace.**

### Works today (marketplace-grade presentation, all gated on `tenants.multiFarmer`)
- **Farmers directory** `/farmers` — grid of farmer cards with product + category counts, name search. (`fermerski-pazar-chaika/src/pages/farmers.astro` → `GET /public/:slug/farmers`)
- **Per-farmer storefront page** `/farmer/[id]` — hero (bio, role, since, own phone/email, gallery), their products grouped into their categories; unknown id → 404. (`src/pages/farmer/[id].astro`, `catalog.ts:farmerSubsections`)
- **Farmer-first home** — when `multiFarmer`, hero CTA flips to "Виж фермерите" and a farmers section renders. (`src/pages/index.astro`)
- **Farmer attribution on every product** — card meta shows farmer name; product page links "Виж стопанството". (`ProductCard.astro`, `product/[slug].astro`)
- **Search + discovery** — `/shop` search matches product **and** farmer name; category chips + "Най-продавани" best-sellers chip (real sales-ranked ids from `/bootstrap`).
- **Farmer accounts** — owner-provisioned scoped logins (`role='farmer'`, `farmerId`), invite email, producers see only their own data. On main. (Owner-run model, no self-signup.)

### Single-shop, not marketplace (the transaction layer)
- **Vendor-blind cart** — `CartItem` has no `farmerId` (`src/lib/cart.ts`); cart is a flat list, no per-farmer grouping/subtotals.
- **Flat checkout** — one order posted to `POST /public/:slug/checkout`.
- **Order-split exists but DORMANT** — `orders.service.ts createCourierOrders()` splits lines by `farmerId` into N single-farmer orders, but only on the `courier` path, which is disabled storefront-wide (`config.ts ONLY_LOCAL_DELIVERY=true`). So no live order is ever split.
- **No farmer filter on the shop grid** — you reach a single farmer only via the directory, not by filtering `/shop`.
- **Farmer URLs are UUIDs** (`/farmer/<uuid>`), not SEO/human slugs.

### The 4 "missing backend pieces" — current status
| Piece | Status |
|---|---|
| Farmer accounts | ✅ Built, on main (owner-provisioned) |
| Order-split by farmer | ⚠️ Built but dormant (courier path only, which is off) |
| Commission ledger | ⚠️ Built dormant on branch `feat/vendor-finance-dormant` (migr 0085) |
| Payout / fund settlement | ❌ Not built — `settled` flag is bookkeeping only; no money moves. COD is farmer-collected; card (Stripe) lands in the single tenant account |

**So:** to become a *real* marketplace, the work is (a) make the cart + checkout vendor-aware and split orders regardless of delivery method, (b) decide the money model (platform-intermediated payout vs. today's farmer-collected COD + owner commission bookkeeping), (c) polish the catalog into a true marketplace UX (below).

---

## 2. Is it wired to the backend the same way as pazar chaika?

**Yes — identical shape.** Both single-tenant chaika and a multiFarmer marketplace consume the same public surface:

- `GET /public/:slug/bootstrap` — one bundle: `{storefront, products, farmers, subcategories, productOfWeek, homeReviews, availability, bestSellerIds}` (7 reads fanned out in `Promise.all`).
- `GET /public/:slug` (tenant profile), `GET /public/:slug/farmers`, public products (via bootstrap), `POST …/newsletter|/contact`, checkout, shipping-compare.
- Caching: shared slug→tenant resolver (`tenant:{slug}`), per-resource Redis (`farmers:{tid}`, `catalog:{tid}`, …, TTL 300s), bootstrap bundle `bootstrap:{slug}` TTL 15s + CDN `s-maxage=60`. Farmer cache invalidated on all 8 farmer mutations.
- `multiFarmer` is **not** special-cased in code paths — `farmers.findPublicBySlug` simply early-returns `[]` when `!multiFarmer`. Products always carry `farmerId`; the farmer directory is the only multiFarmer-gated payload. The marketplace path is as robust as the core.

---

## 3. Does the dormant vendor-finance work break anything?

**No — and the one theoretical exposure is now hardened to zero.**

- Migration 0085 is purely additive: 2 enums, 2 **nullable** farmers columns, 2 new tables. `orders` untouched. Existing rows/old code unaffected.
- The commission seams (cancel/COD/Stripe-paid) are fire-and-forget (`void this.commission?.…`) with try/catch-swallow — a checkout / COD-mark / Stripe-paid write cannot 500 from the dormant ledger even pre-migration.
- **The only storefront query reading the changed `farmers` table was a bare `.select()` in `findPublicBySlug`** — which would enumerate the new columns and 500 a multiFarmer bootstrap if code somehow served before 0085. **Fixed this session:** converted to an explicit 12-column projection, so the SQL never references the finance columns → immune to any schema-ahead-of-migration window, and the owner-only commercial terms are stripped at the SQL level (belt-and-suspenders on top of the existing destructure-strip).
- **Deploy-model note (needs reconciling):** `server/src/main.ts:37 await runMigrations()` runs on boot **before** the app serves traffic, unconditionally ("every deploy self-heals the schema… github → dokploy"). This contradicts the plan's premise and the memory note "deploy does NOT run migrations." If prod boots through this path, 0085 self-applies before serving and the storefront is safe regardless of the manual runbook. Worth confirming against actual prod before relying on either model.

**Bottom line:** the current live site (a multiFarmer tenant) is safe; single-farm storefronts were never at risk (early-return). No storefront break from this work.

---

## 4. Is it mobile-perfect?

**Current grade: 8/10.** Genuinely mobile-first: 17px base / 1.6 line-height, 16px inputs (no iOS zoom), inlined critical CSS, sticky safe-area checkout bar with keyboard-aware hide, thorough Cyrillic wrapping, no page-level horizontal overflow at 360/375/768/1280, cards purpose-trimmed for 2-up phones.

Fix to reach 10/10 (all in `fermerski-pazar-chaika`):
1. **[P2] Clipped product-card stepper** — at ≤600px the fixed ~143px stepper overflows the ~120px 2-up card and the −/+ get cut by `overflow:hidden`. Stretch it full-width (or drop qty on card, default 1). Busiest screen; elder-relevant. (`main.css` `.product__foot .stepper`, `ProductCard.astro`)
2. **[P2] Muted-text contrast** — `--muted #6F7A69` on `#FAFBF8` ≈ 4.4:1 (under AA), and 12–13.5px content labels. Darken one step and lift smallest content text to 14px.
3. **[P3] Cart line-item actions overflow < ~355px** — add `flex-wrap:wrap` to `.li-actions`.
4. **[P3] 44px card CTAs** — `.btn--sm` is ~36px tall; bump vertical padding on touch.
5. **[P3] 24px terms checkbox** — final polish.

---

## Design direction — a modern marketplace, tuned for a small local food market

Full research brief (eMAG, CrowdFarming, Barn2Door, Etsy, Wolt/Instacart, NN/g, elder-a11y) with sources is in the session transcript. Distilled direction:

**Model: discover by farmer, buy by product, re-order by farmer.** Home is farmer-forward and curated (the ~10-40 producers are a browsable asset a 500-vendor site can't show); browse/search is product-first with farmer attribution on every card + a "filter by farmer" facet; the product page bridges both ("Още от този стопанин").

Highest-value patterns to adopt (ranked):
1. **Sticky bottom action bar** (mobile) — cart + dual-currency total + one big CTA, always in thumb reach. Biggest mobile-conversion lever, forgiving for elderly users.
2. **Farmer as a named, faced entity on every card** — avatar + name + village, linking to their page. The trust unit, and the core differentiator vs a soulless bazaar. (Never anonymous "seller".)
3. **Per-farmer page as a real micro-storefront** — story, region + pickup, certifications, their categories/best-sellers/articles, in-page search. Powers land-and-expand.
4. **Dominant search + subcategory chips above the grid** — shallow food taxonomy; search indexes product + farmer + category.
5. **Food-tuned product card** — big photo, name, farmer avatar, dual price **with unit**, seasonal/promo/bestseller badge, one-tap add.
6. **Seasonality as a positive signal** — "В сезон" / "Прясно тази седмица" from availability windows; a reason to return weekly.
7. **Late-checkout slot sheet** — service option (Доставка vs Взимане) as two big cards → day tabs → large radio windows; reserve on selection.
8. **Curated home rails** instead of an infinite grid — "Прясно тази седмица", "Най-поръчвани", "От нашите стопани", articles teaser.
9. **Provenance-based trust** (not review counts) — "Проверен производител", years active, real farm photos.
10. **Dual €/лв + elder-first type as a global constraint** — ≥17px body, ≥48px targets, plain BG labels, лв primary / € secondary consistently.

**Deliberately DON'T copy from big marketplaces:** mega-menus + deep facet stacks, anonymous merchant IDs, urgency/dark patterns (countdowns, fake scarcity), infinite-scroll warehouse grids, rating-count-gated trust, spec-sheet density, generic stock/AI imagery. All of these make a small trust-based farm market feel cold and hurt elder readability.

A mobile "now → 10/10" mockup (enhanced card + sticky cart bar) was shown in the session.

---

## Recommended next steps (prioritized)

**A. Ship-safe now (low risk):**
- Merge the dormant vendor-finance branch (audited: no P0/P1; the `findPublicBySlug` hardening is in it).
- Reconcile the deploy/migration model against prod (does `main.ts` self-migrate?). Update the memory note either way.

**B. Mobile 10/10 (storefront CSS, ships to live farmmarket.bg — needs a deploy checkpoint):**
- The 5 fixes above. Small, high-confidence; hold for a deliberate push since chaika auto-deploys on merge.

**C. Marketplace UX uplift (design work, phased):**
- Product card v2 (farmer avatar + seasonal badge + un-clipped stepper), sticky cart bar, farmer filter on `/shop`, per-farmer micro-store enrichment, seasonal home rail, human slugs for farmer URLs.

**D. True transactional marketplace (biggest, needs product decisions):**
- Vendor-aware cart + split checkout on all delivery methods (not just courier); the money model (payout vs. commission-bookkeeping-on-COD); enable the dormant order-split + commission ledger deliberately, in that order.
