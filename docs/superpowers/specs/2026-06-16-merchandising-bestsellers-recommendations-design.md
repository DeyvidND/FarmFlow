# Merchandising: „Най-продавани" pill + cart bought-together picks

**Date:** 2026-06-16
**Repos:** FarmFlow (backend + web admin) · fermerski-pazar-chaika (storefront)
**Branch:** `feat/merchandising-bestsellers-recs` (both repos)

## Goal

Two independent, admin-toggleable merchandising features:

1. **„Най-продавани"** — a best-sellers filter chip on the shop page, inserted as the
   **2nd chip** (immediately after „Всички"). Ranks products by total quantity sold.
2. **Cart bought-together picks** — up to **3** recommended products on the cart screen
   („Твоята количка"), driven by co-occurrence with the items currently in the cart.

The two are **separate features** with separate logic, separate toggles, and separate
placements. They share only the underlying sales data.

No DB migration: everything derives from existing `orders` / `order_items` plus one new
`settings.merchandising` jsonb leaf.

## Data source & ranking

Both features read the same `order_items ⋈ orders` aggregate. A sale counts when the order
is **not cancelled** — reuse the existing stats filter `status is distinct from 'cancelled'`
(`live`). Null `product_id` rows are excluded.

## 1. Backend — `RecommendationsService` (orders module)

Two Redis-cached methods.

### `bestSellerIds(tenantId): Promise<string[]>`
```sql
select oi.product_id, sum(oi.quantity) as qty
from order_items oi
join orders o on o.id = oi.order_id
where o.tenant_id = $1
  and o.status is distinct from 'cancelled'
  and oi.product_id is not null
group by oi.product_id
order by qty desc
limit 8
```
- Returns ranked product ids (highest sales first).
- Cache key `bestsellers:{tenantId}`, TTL 600s. No bust on order write — sales ranking
  drifts slowly and a 10-min staleness is fine.

### `boughtTogether(tenantId, cartIds: string[]): Promise<PublicProduct[]>`
- Find orders that contain ANY `cartId`; aggregate the **other** products in those baskets;
  rank by `count(distinct order_id)` desc, then `sum(quantity)` desc; drop `cartIds`; take 3.
- **Fallback ladder** (never returns empty when the catalog can fill it):
  1. co-occurrence results, then
  2. best-sellers minus `cartIds`, then
  3. ★featured / newest minus `cartIds`.
- Exclude products that are **sold out** (active availability window remaining = 0) where
  that data is known.
- Map result ids → full `PublicProduct` via the cached `findPublicBySlug(slug)` catalog, so
  the cart page can render product cards directly without a second fetch.
- Input `cartIds` capped at 50, uuid-validated, unknown ids ignored.
- Cache key `bought:{tenantId}:{sortedCartIds}`, TTL 120s.

## 2. Backend — exposure

- **Bootstrap** (`GET /public/:slug/bootstrap`) gains `bestSellerIds: string[]`, populated
  only when `merchandising.bestSellers.show` is on (else `[]`). The shop page already loads
  bootstrap, so no extra round trip.
- **New public endpoint** `GET /public/:slug/recommendations?ids=<csv-uuids>` →
  `PublicProduct[]`. Returns `[]` when `merchandising.recommendations.show` is off
  (defensive — the storefront also gates the call). Cart page calls it client-side with the
  cart's product ids.

## 3. Backend — admin toggle (`settings.merchandising`)

New leaf `server/src/modules/tenants/merchandising.ts`, mirroring `landing.ts` exactly
(pure leaf, no imports → shared by read + write paths; idempotent resolve+clamp):

```ts
export interface MerchandisingBlock { show: boolean; }
export interface PublicMerchandising {
  bestSellers: MerchandisingBlock;      // shop „Най-продавани" chip
  recommendations: MerchandisingBlock;  // cart bought-together picks
}
export const DEFAULT_MERCHANDISING: PublicMerchandising = {
  bestSellers: { show: false },
  recommendations: { show: false },
};
export function resolveMerchandising(raw: unknown): PublicMerchandising { /* clamp */ }
```

- Both default **off** (opt-in, like the reviews block).
- `MerchandisingDto` (mirrors `LandingDto`).
- `PATCH /tenants/me/merchandising` on the tenants controller; service writes `settings.merchandising`
  via the existing atomic jsonb-set path and busts the `tenant:{slug}` cache.
- Projected into `TenantMeta.merchandising` in `public-cache.service.ts`
  (`resolveMerchandising(settingsObj?.merchandising)`), so it rides the warm storefront profile.

## 4. Web admin

`client/src/components/settings/merchandising-card.tsx` — a trimmed clone of `landing-card.tsx`:
two `ToggleSwitch` rows + `SaveBar`, loading via new `getMerchandising()` / saving via
`updateMerchandising()` in `api-client.ts`. Mounted on the same settings screen that hosts the
landing card.

- Row 1: „Най-продавани" — desc „Раздел с най-продаваните продукти в магазина."
- Row 2: „Препоръчани в количката" — desc „Показва „Често купувано заедно" в количката."

## 5. Storefront (chaika)

- **types.ts**: add `Storefront.merchandising?: { bestSellers: { show: boolean }; recommendations: { show: boolean } }`
  and `Bootstrap.bestSellerIds?: string[]`.
- **shop.astro**: when `sf.merchandising?.bestSellers?.show` and the best-seller set is
  non-empty, render `<button class="chip" data-tab="best-sellers">Най-продавани</button>` as
  the 2nd chip (after „Всички"). Best-seller set = `bestSellerIds` ∩ active catalog, padded
  with `featured()` up to 8; pass `bestSeller={set.has(p.id)}` to each `ProductCard`.
- **ProductCard.astro**: new optional prop `bestSeller?: boolean` → emits `data-bestseller="1"`.
- **ui.ts `tabs()`**: extend the filter predicate to
  `key === 'all' || card.dataset.cat === key || (key === 'best-sellers' && card.dataset.bestseller === '1')`.
- **cart.astro**: set a data flag on `#cartArea` from `sf.merchandising?.recommendations?.show`.
- **cart-page.ts**: when the flag is on and the cart is non-empty, after rendering the cart
  fetch `${PUBLIC_BASE}/recommendations?ids=<cart ids>` and render up to 3 product cards in a
  „Често купувано заедно" block below the cart lines, each with an add button reusing
  `Cart.add`. Reuses the existing thumbnail/image plumbing.

## Edge cases

- Quiet/new shop, no sales: best-sellers pill is padded from featured/newest so it never
  shows thin; cart picks fall through the ladder to featured/newest. If the catalog has < 3
  other products, the cart block shows fewer (or hides when 0).
- Toggle off: bootstrap omits `bestSellerIds` (→ no chip); recommendations endpoint returns
  `[]` (→ cart block hidden). Storefront gates both on the profile flag too.
- Pill membership is by best-seller set; cards stay in **catalog order** within the pill
  (rank-ordered display is out of scope).

## Testing

- **Backend jest**: `bestSellerIds` (ranking, cancelled excluded, null product excluded),
  `boughtTogether` (co-occurrence ranking, cart-id exclusion, full fallback ladder, sold-out
  exclusion), `resolveMerchandising` (defaults / clamp / garbage), recommendations controller
  (toggle-off → `[]`, id cap/validation).
- **chaika**: `astro check` + `pnpm build`.
- Full server suite + client tsc/build green before done.

## Out of scope (later)

Rank-ordered display inside the pill; per-vendor item-count config; personalization beyond
basket co-occurrence (no per-customer history / ML).
