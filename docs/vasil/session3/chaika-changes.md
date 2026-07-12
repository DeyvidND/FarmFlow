# Session 3 — Storefront (chaika) changes — DOCUMENTED, NOT APPLIED

These are the storefront-side changes for tasks #1, #2, #11. They live in the **chaika**
repo (farmmarket.bg storefront, deployed to Cloudflare Workers) and are **intentionally NOT
applied here**. All the backend/API support they need is already built and live on
`feat/vasil-products-cart`. This file is the hand-off spec so chaika can consume it.

The storefront reads the public catalog from `GET /public/:slug/products` (Redis-cached, 300s
TTL — a change to a product/bundle shows after the cache expires or is invalidated on write).

---

## New / changed fields on the public product payload (`PublicProduct`)

| field | type | meaning |
|-------|------|---------|
| `courierShippable` | `boolean` | `true` = may go on an Econt/Speedy waybill; `false` = pickup / local delivery only. Positive alias of the server's `courierDisabled`. (task #11) |
| `bundleProducts` | `PublicBundleItem[] \| undefined` | Present on `category === 'bundle'` products. Resolved member products: `{ productId, name, slug, image, quantity, priceStotinki }`. Empty array when a bundle has no live members. (task #1) |
| `requiresCompanion` | `boolean` | `true` = this product cannot be ordered alone; the cart must also hold ≥1 OTHER product (see threshold). (task #2) |
| `companionMinPriceStotinki` | `number \| null` | Optional EUR-cents threshold (same unit as `priceStotinki`). When set, the required OTHER product must cost ≥ this. `null` = any other product qualifies. (task #2) |

`priceStotinki` / `companionMinPriceStotinki` are **EUR cents** (÷100 → euros; format "X,XX €").

---

## Task #1 — „Фермерска кошница" / готови пакети (ready-made bundles)

**Backend:** an operator/farmer builds a bundle as a normal product with `category='bundle'`
and attaches real member products via `PUT /products/:id/bundle-items`. The public payload then
carries `bundleProducts[]`.

**Storefront work:**
1. Add a „Готови пакети" / „Кошница на седмицата" section (or a badge on the product card) for
   products where `category === 'bundle'`.
2. On the bundle product card / page, render `bundleProducts[]` as the contents list
   (image + name + „× quantity"). If `bundleProducts` is empty/absent, hide the contents block.
3. „Добави пакета в кошницата" adds the bundle product itself (single line, its own
   `priceStotinki`) — the bundle is sold as one SKU. (It is NOT an expand-into-components add;
   the members are informational, mirroring the current Product-of-the-Week behaviour.)
4. A bundle inherits the same `courierShippable` / `requiresCompanion` rules as any product —
   apply the checkout logic below to bundles too.

---

## Task #2 — Mandatory companion (generalized „кайсии" combo, configurable ≥ X €)

Revised by Vasil: no longer apricot-specific and folded into the bundle system. A product OR a
bundle can be flagged so it cannot be bought alone; optionally the required companion must be
worth at least a configurable amount.

**Rule (enforced server-side in `OrdersService.reserveCartItems` for EVERY delivery method —
the storefront check below is UX only; the server is the backstop):**
> If any cart line's product has `requiresCompanion === true`, the cart must also contain at
> least one line for a **different** product whose **unit price ≥ `companionMinPriceStotinki`**
> (or any other product when the threshold is `null`). Multiple units of the SAME flagged
> product do NOT satisfy it.

Server rejects with 400 and a Bulgarian message, e.g.
`„Кайсии" не се доставя самостоятелно — добавете поне още един продукт на стойност поне 10,00 €.`

**Storefront work (checkout pre-check + nudge):**
1. Before allowing checkout, for each cart line whose product has `requiresCompanion`:
   - compute whether another distinct cart product meets its `companionMinPriceStotinki`
     (compare against each other line's effective unit price — sale price if present, else
     `priceStotinki`).
   - if not satisfied, block the „Поръчай" button and show an inline message:
     - with threshold: „«{name}» не се продава самостоятелно — добавете още един продукт на
       стойност поне {X,XX €}."
     - without threshold: „«{name}» не се продава самостоятелно — добавете още един продукт по
       избор."
2. Add a nudge/CTA („Разгледай продуктите" / suggest add-ons) so the shopper can satisfy it.
3. Keep the server error handling (a crafted request or a race still gets the 400 → surface it).

---

## Task #11 — Per-product Еконт clarity + red-in-cart outside Варна & Добрич

**Backend:** every public product exposes `courierShippable` (= `!courierDisabled`). The server
already REJECTS any carrier (Econt/Speedy) order containing a non-shippable product — so this is
UX; the backstop is guaranteed.

**Storefront work:**
1. **Per-product badge** (card + product page):
   - `courierShippable === true` → „📦 Може по Еконт/куриер".
   - `courierShippable === false` → „🚫 Само вземане/местна доставка".
2. **Local-zone list** (shared constant): Варна and Добрич regions are the local self-delivery
   zone. Suggested seed (extend as needed): the cities/districts of обл. Варна и обл. Добрич —
   at minimum `['Варна', 'Добрич']` plus their region flag from the address/geocode step. Keep
   it in one shared module so it is easy to extend.
3. **Red highlight + block** at checkout: WHEN the customer's delivery address is **outside**
   the Варна & Добрич local zone **AND** the selected method is Econt (courier) **AND** the cart
   contains ≥1 line with `courierShippable === false`:
   - render those cart lines in RED with a note „Не се изпраща по куриер извън Варна/Добрич".
   - block „Поръчай" until the shopper removes them or switches to pickup / local delivery
     (inside the zone).
   - inside the zone (Варна/Добрич) these products are fine (local delivery / pickup), so no red.
4. This complements the server backstop (a `courierDisabled` product can never actually ship by
   carrier); the red highlight just makes the reason visible before the 400.

**Open question for Vasil (unchanged):** current model is all-couriers-or-none. If you ever need
Econt-OK-but-Speedy-not (or vice-versa) per product, that needs a new per-carrier granularity —
not built (would be a follow-up column). Today „Еконт" = general courier shippability.

---

## Task #12 — карта на производители

No chaika change for now. The producers map is published on the **internal super-admin console**
(`/producers-map`) for logistics, per Vasil („ние тепърва ще я използваме за логистиката"). The
`GET platform/producers/map` response shape is storefront-ready if a public map is wanted later.
