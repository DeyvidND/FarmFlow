# Кошници (multi-farmer baskets) — design

**Date:** 2026-07-21
**Branch:** `koshnitsi-baskets` (off `origin/main` @ `d65c9c4b`)
**Repos touched:** `FarmFlow` (server, client, packages/db, packages/types) and
`fermerski-pazar-chaika` (storefront).

## Problem

An operator wants to sell a **кошница** — a fixed-price package combining products
from several farmers ("Седмична кошница", promo packages). Today there is no way to
create one from the panel, and the order pipeline is completely blind to package
contents.

## What already exists (do not rebuild)

Migration `0100_bundle_products.sql` shipped a real bundle model. `git log` also shows
`230056c2 fix(bundles): atomic circularity+farmer-scope check on bundle members`.

| Piece | Location |
|---|---|
| Membership table `productBundleItems(id, tenantId, bundleId, productId, quantity, position)`, unique `(bundle_id, product_id)` | `packages/db/src/schema.ts:333-345` |
| `listBundleItems` / `setBundleItems` — transactional, `.for('update')` row locks, rejects self-reference, nested bundles, cross-tenant and deleted members | `server/src/modules/products/products.service.ts:516-613` |
| `GET` / `PUT /products/:id/bundle-items` | `server/src/modules/products/products.controller.ts:200-224` |
| `BundleItemDto` (quantity 1–999), `SetBundleItemsDto` (`ArrayMaxSize(50)`) | `server/src/modules/products/dto/bundle-items.dto.ts` |
| Public member resolution onto the **whole catalog** (not just detail) | `products.service.ts:985-1015` |
| `PublicBundleItem { productId, name, slug, image, quantity, priceStotinki }` | `packages/types/src/index.ts:153-160` |
| Panel editor „Съдържание на пакета" (add/remove member with qty, full-replace persist) | `client/src/components/products/product-dialog.tsx:709-796` |
| `getBundleItems` / `setBundleItems` client helpers | `client/src/lib/api-client.ts:149-163` |
| Storefront already special-cases `category === 'bundle'` (label „Сезонни пакети", 🧺 pill) | chaika `src/lib/catalog.ts:19-20,51-62`, `src/components/ProductCard.astro:52,76` |
| Tests | `server/src/modules/products/products.bundle.spec.ts` |

Two rules that already work in our favour and need **no change**:

1. `setBundleItems` requires a member to share the bundle's `farmerId` *only if that
   `farmerId` is set*. A bundle with `farmerId = null` therefore already accepts
   products from every farmer — exactly the cross-farmer case we want.
2. `bundleProducts[]` is attached in `findPublicBySlug`, which builds the entire
   cached catalog. So `/bootstrap` and the `/shop` listing already carry the member
   images needed for the 2×2 tile grid. No new endpoint.

## Decisions

| Question | Decision |
|---|---|
| Which farms can a basket combine? | Any — created by the account owner/admin, `farmerId = null`. |
| What does the order look like inside? | Explodes into member lines (see Order model). |
| Price | Fixed, entered manually. „Стойност поотделно / спестявате X" computed for display only. |
| Basket images | Auto 2×2 from the first four members; an uploaded `imageUrl` overrides the grid. |
| Where the 2×2 grid appears | Catalog card **and** product detail page. |
| Component sold out | Basket becomes sold out. Availability = `min` over members. |
| Category | Reuse `category = 'bundle'`; relabel the storefront to „Кошници". No new value, no migration, existing packages carry over. |
| Courier shipping | Baskets are **pickup / local delivery only**. `createCourierOrders` splits a cart into one order per farmer and rejects any line without a `farmerId`; a basket is `farmerId = null` and its members span farms, so one parcel cannot originate from three yards. Today this already fails, with a confusing message — we make it explicit. |
| Members with variants | Rejected at `setBundleItems`. A member line carries no `variantId`, so a varianted member would hit `requiresVariantSelection` at checkout with no way to answer it. |
| Who sees „Създай кошница" | Account owner/admin only. Producer sub-accounts (`role === 'farmer'`) do not. |

## Non-goals

- Subscriptions / recurring delivery. "Седмична" is a name, not a schedule.
- Nested baskets (already rejected by `setBundleItems`).
- Auto-priced baskets (sum minus %).
- Per-farmer revenue attribution for basket sales — see Known limitation.

---

## 1. Order model — explode at checkout

### The gap

`grep -n bundle server/src/modules/orders/orders.service.ts` returns **one hit, a
comment at L2360**. The order path has no bundle awareness at all. Today, ordering a
basket:

- decrements only the basket product's own availability window; member `remaining`
  is untouched → **oversell of members**;
- a basket with no window of its own is effectively unlimited;
- writes one opaque `order_items` row, so `harvest-summary.ts` prep lists, per-product
  stats and recommendation co-occurrence never see the real products;
- skips the `courierDisabled` check for members (`orders.service.ts:2341-2351` tests
  only the ordered product) → a pickup-only member can reach a courier waybill;
- counts the basket as one product for the companion rule
  (`orders.service.ts:2364-2394`).

### Chosen shape: parent line + zero-priced child lines

```
Седмична кошница        ×1   39.90   bundleParentId = null
  Домати 2кг            ×2    0.00   bundleParentId = <parent order_item id>
  Сирене краве          ×1    0.00   bundleParentId = <parent order_item id>
  Мед акациев           ×1    0.00   bundleParentId = <parent order_item id>
```

Order total is unchanged (money lives on the parent). Prep, stock and routing see the
real products. The customer's order still shows the basket they bought, so
cancellation, refunds and email copy keep working.

Rejected alternatives:

- **Proportional allocation, no parent line** — per-farmer revenue would be exact
  immediately, but the basket disappears as an entity from the order; cancellation and
  customer email lose the thing that was actually purchased, plus rounding drift.
- **Parent + per-child allocated share** — most accurate, most code, two places for
  the sums to disagree.

### Migration `0111_order_item_bundle_parent.sql`

Hand-written (see `packages/CLAUDE.md`). Journal `idx: 109` — the pre-existing
filename/idx offset of 2 must be continued, and a gap silently breaks the migrator.

```sql
ALTER TABLE order_items
  ADD COLUMN bundle_parent_id uuid REFERENCES order_items(id) ON DELETE CASCADE;
CREATE INDEX order_items_bundle_parent_idx ON order_items (bundle_parent_id)
  WHERE bundle_parent_id IS NOT NULL;
```

`ON DELETE CASCADE` so removing a basket line removes its children. Column is nullable;
every existing row stays valid.

Schema addition in `packages/db/src/schema.ts` next to `orderItems` (L532-554), and
`bundleParentId?: string | null` on the order-item type in `packages/types`.

### Checkout changes — `server/src/modules/orders/orders.service.ts`

The existing stock block at L2409-2488 already does the right thing (ordered
`SELECT … FOR UPDATE`, pooled `decideDecrementPooled` across windows, one set-based
`UPDATE … CASE` via `intCaseById` in `order-stock.util.ts`). We feed it an **expanded
item list** instead of changing it.

New step, before stock enforcement:

1. Load `productBundleItems` for every ordered product whose `category === 'bundle'`
   (one `inArray` query — no per-row lookup, per the N+1 rules in
   `docs`/memory).
2. Build the effective stock list: replace each basket line with its members at
   `member.quantity × line.quantity`. **The basket's own window is not enforced** — a
   basket carries no stock of its own (the panel hides the stock field in basket mode),
   so `min` over members is the only source of truth and the two can never disagree.
3. Merge duplicates: if the customer ordered tomatoes *and* a basket containing
   tomatoes, the two quantities sum into one entry before `FOR UPDATE`, so the pooled
   check sees the true demand. This also preserves the deadlock-free
   `ORDER BY product_id` lock ordering.
4. Run the existing enforcement over the expanded list unchanged.

`courierDisabled` (L2341-2351) and the companion rule (L2364-2394) evaluate over the
same expanded list, so a pickup-only member blocks a courier basket. `listBundleItems`
already selects `courierDisabled`; nothing consumed it before.

Order-item writing: the basket row is inserted first, then member rows with
`bundleParentId` set, `priceStotinki = 0`, and the usual `productName` snapshot.

Cancel/restore (L2193-2261) mirrors the same expansion so a cancelled basket returns
member stock. Because member rows are persisted with their quantities, the restore path
can read the child rows directly rather than re-resolving membership — membership may
have changed since the order was placed, and the order must restore what it actually
consumed.

### Public availability — `availability.service.ts:412-437`

`findPublicActiveBySlug` returns raw windows; chaika pools them per `productId`. For
baskets we emit **one synthetic window** per basket and drop any real window rows for
that basket product, so pooling can't double-count:

```
remaining = min over members of floor(member.remaining / member.quantity)
```

- A member with no window is unlimited and does not constrain the `min`.
- No live members → `remaining = 0`.
- `startsAt` / `endsAt` use the open range (`OPEN_START` / `OPEN_END`,
  `availability.service.ts:24-25`).

Implemented as one extra query for basket membership on the same call. Cached under the
existing `bootstrap:{slug}` TTL of 15s — a basket can read as available for up to 15s
after its last member sells out; the checkout enforcement above is the real gate.

### Tests (server)

- Ordering a basket writes a parent line plus member lines; order total equals the
  basket price.
- Member `remaining` decrements by `member.quantity × line.quantity`.
- Ordering the same product both loose and inside a basket pools into one check.
- A sold-out member rejects the order (422); the basket's own stock is irrelevant.
- A `courierDisabled` member blocks a courier delivery type.
- Cancelling the order restores member stock, using the persisted child rows.
- `min`-over-members availability, including the no-window (unlimited) member and the
  zero-live-members case.

Follow the testing lessons in memory: assert against real filtering behaviour, not a
mock that ignores `WHERE`; the suite runs UTC via `set-tz.ts`.

---

## 2. Panel (client)

### Entry point

`client/src/components/products/products-client.tsx:325-378` — add **„Създай кошница"**
to the toolbar beside „Добави продукт". Rendered only when the signed-in user is not a
producer sub-account (`role !== 'farmer'`).

### Basket mode in `ProductDialog`

`client/src/components/products/product-dialog.tsx`. Two concrete bugs block creation
today:

1. the submit payload (L312-328) **never sends `category`**, so no panel path can
   produce a `category = 'bundle'` product — even though `ProductWrite = Partial<Product>`
   (`api-client.ts:129`) permits it and `CreateProductDto.category` is validated
   (`create-product.dto.ts:47`);
2. the contents editor is gated on `isEdit && product?.category === 'bundle'`
   (L86), so it is invisible while creating.

Basket mode:

- forces `category: 'bundle'` and `farmerId: null` into the create payload;
- enables the contents editor at create time;
- the member picker searches across **all** farmers and shows whose product each is;
- price is manual, with a live line beneath it:
  „Стойност поотделно 47.20 лв · спестявате 7.30 (15%)". If the basket costs more than
  the sum, show a quiet warning — do not block;
- the stock field is hidden (availability is derived from members — see above);
- image upload is optional. Empty → chaika composes the 2×2 grid. Uploaded → that image
  wins.

Header copy, plain language, no jargon:

> **Кошница** — няколко продукта от различни фермери, продавани заедно на една цена.
> Клиентът вижда една снимка от четири парчета и плаща общата цена. Ти получаваш
> поръчка с разписаните продукти вътре, готова за подготовка.

### Product list

Baskets render with a 🧺 badge and a subtitle line „3 продукта от 2 фермери". Otherwise
they behave as normal products — activation, ordering and promotions are unchanged.

### Order detail

Where order items are listed, child rows (`bundleParentId != null`) render indented
under their parent, without a price. Prep views already group by product and need no
change because member rows are real `order_items`.

---

## 3. Storefront (chaika)

Repo: `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika` — Astro 5 SSR on Cloudflare
Workers, dev port 3003.

| Change | File |
|---|---|
| `BUNDLE_LABEL` → „Кошници"; rewrite the category description | `src/lib/catalog.ts:19-20`, `51-62` |
| 🧺 glyph in `ICONS` + a `кошниц` arm in `iconForCategory` | `src/lib/icons.ts:4-36`, `41-49` |
| 2×2 tile grid inside the existing `.ph` box (4/3, `src/styles/main.css:361`) when the product is a basket, has no own `imageUrl`, and has ≥2 members. 2 members → 2 cells, 3 → 3. Promo tag, 🧺 pill, photo count and stock badge stay layered on top | `src/components/ProductCard.astro:74-98` |
| New `tiles` prop; when passed, the 1:1 main image becomes a 2×2 grid of member images instead of a single `<img>` | `src/components/Gallery.astro:17-46` |
| Pass `tiles` for baskets; keep the „Какво има вътре" list below (name, quantity, farmer) | `src/pages/product/[slug].astro:109` |

Images continue to go through `cfImage` / `cfSrcset` (`src/lib/img.ts:35,44`) at tile
width, not full width.

Cart and checkout are untouched: a basket posts as an ordinary `productId` +
`quantity` (`src/scripts/checkout-page.ts:618-628`). Explosion is entirely server-side.

chaika has no test framework — verify in the browser at 375px and desktop.

## Deploy order

Backend first (root `CLAUDE.md` gotcha #10). Push to `main` auto-deploys to Hetzner and
runs the migrator before the app images; chaika is a separate Cloudflare Workers deploy
and must land after the API exposes the new shape.

## Known limitation

Basket revenue sits on the basket product (`farmerId = null`), so per-farmer attribution
does not split it. Vendor finance is currently dormant (rate 0), so nothing is misreported
today. When it activates, add an allocated-share column to the child rows rather than
reshaping the order.
