# Product Variants + Promotional Pricing — Design

**Date:** 2026-06-26
**Status:** Approved (brainstorm), pending implementation plan
**Repos affected:** FarmFlow (panel + API + DB), chaika storefront (separate repo)

## Goal

Two related farmer-facing features, coupled through product pricing:

1. **Variants (вид/грамаж)** — one product carries several priced options instead of
   forcing the farmer to create duplicate products. Examples:
   - Honey: "Кристализиран" vs "Течен" — same product, one ingredient difference, different price.
   - Milk: three package sizes (500 г / 1 л / 2 л), one photo, three prices.
   - A product may combine both axes; the farmer expresses each combination as one flat variant row.
2. **Promotion (промоция)** — a time-boxed discount on a product ("намалено от X").
   Optional end date that auto-expires the promo; empty date means the farmer removes it
   manually. Tooltip explains both this and the variants feature.

## Decisions (from brainstorm)

- **Variant structure:** flat list (chosen over a two-axis matrix). Each variant = free-text
  label + price + stock. The farmer combines "вид" and "грамаж" into the label themselves
  (e.g. "Кристализиран 500 г"). One photo for the whole product.
- **Variant stock:** per-variant. Each variant tracks its own `stockQuantity`
  (e.g. liquid honey sold out while crystallized still in stock). Cart decrements the chosen
  variant. (The existing product-level "Задай наличност" availability windows stay for
  products WITHOUT variants.)
- **Promo expression:** product-level **discount percentage** + optional end date.
  Applied **proportionally** to the base price and every variant.
- **Where pricing is computed:** the **server** (public product API) is the single source of
  truth. chaika and any other storefront only display server-computed numbers — no price
  math in the browser. Keeps cart totals, all storefronts, and the panel consistent.
- **Modal layout:** two collapsible sections at the **bottom** of the product dialog
  ("Варианти" and "Промоция"), each gated by a checkbox so a simple product stays simple.
  ⓘ tooltips on both.
- **When variants are ON:** the single top-level price field and "Задай наличност" are
  hidden — price and stock come from the variant rows. (Confirmed by user.)

## 1. Data model — `packages/db/src/schema.ts` + new migration

### New table `product_variants`
| column         | type      | notes                                            |
|----------------|-----------|--------------------------------------------------|
| `id`           | uuid PK   | `uuid_generate_v4()`                              |
| `productId`    | uuid FK   | → products.id                                    |
| `label`        | text      | e.g. "Кристализиран 500 г" (required)            |
| `priceStotinki`| integer   | required, ≥0                                      |
| `stockQuantity`| integer   | nullable: null = unlimited, 0 = out of stock     |
| `position`     | integer   | sort order                                       |
| `deletedAt`    | timestamp | soft-delete (mirror products pattern)            |
| `createdAt`    | timestamp | defaultNow                                        |

Index on `(productId)` (and `(productId, position)` for ordered fetch).

### `products` — promotion columns (additive)
- `salePercent` integer, nullable — 1..99 (validated in DTO).
- `saleEndsAt` timestamp, nullable.
- Existing `compareAtPriceStotinki` (bundles) is left untouched.

### `order_items` — variant snapshot (additive)
- `variantId` uuid, nullable (FK → product_variants.id, no cascade — mirror productId).
- `variantLabel` text, nullable — snapshot of the label at purchase time
  (mirror existing `productName` snapshot).
- `priceStotinki` already stores the unit price actually paid (= variant price when set).

## 2. Server — products module

### DTOs
- `CreateProductDto` / `UpdateProductDto` gain:
  - `salePercent?: number | null` (int 1–99), `saleEndsAt?: string | null` (ISO date).
  - `variants?: VariantDto[]` where `VariantDto = { id?, label, priceStotinki, stockQuantity?, position? }`.
- Validation: when `variants` non-empty, each needs label + priceStotinki ≥ 0.

### `products.service`
- **Variant persistence:** on create/update, upsert variant rows (insert new, update existing
  by id, soft-delete removed). Scoped by tenant (IDOR-safe, same pattern as media/products).
- **priceStotinki sync:** when variants exist, set `products.priceStotinki` to the cheapest
  variant price on each save (drives storefront sort + "от X" card label). Keeps the column
  NOT NULL and meaningful.
- **`toPublicProduct` promo computation** (single source of truth):
  - `promoActive = salePercent != null && (saleEndsAt == null || saleEndsAt > now)`.
  - If active: `discountedStotinki = round(price * (1 - salePercent/100))` for the base price
    and for each variant.
  - Public shape returns originals + computed sale prices + variants.
- **`PublicProduct`** (`packages/types`) gains:
  - `variants: { id, label, priceStotinki, salePriceStotinki?, soldOut: boolean }[]`.
    Mirror today's privacy stance (product `stockQuantity` is stripped from PublicProduct):
    do NOT expose raw per-variant counts publicly — expose only `soldOut` (`stockQuantity === 0`)
    so the storefront can disable a variant and block at 0 without leaking inventory levels.
  - `salePercent?`, `saleEndsAt?`, and base `salePriceStotinki?` for the headline price.
- Private/admin reads return full variant rows (with stock) so the modal can edit them.

### Expiry
- Correctness comes from the date check in `toPublicProduct` (no row mutation needed → robust
  even if the cron never runs).
- **Tidiness cron** (worker, daily — reuse existing BullMQ repeatable pattern): null out
  `salePercent` + `saleEndsAt` for rows where `saleEndsAt < now`, so expired promos also vanish
  from the admin UI.

## 3. Orders module — variant capture + stock

- Add-to-cart / order creation accepts `variantId` per line.
- Order line persists `variantId` + `variantLabel` snapshot; `priceStotinki` = server-resolved
  variant price (with promo applied — server recomputes, never trusts client price).
- **Atomic stock decrement** for variant lines:
  `UPDATE product_variants SET stockQuantity = stockQuantity - :qty WHERE id = :id AND (stockQuantity IS NULL OR stockQuantity >= :qty)`
  — block / reject when insufficient (mirror existing availability-window decrement & guard).

## 4. Panel — `client/src/components/products/product-dialog.tsx`

- Two collapsible sections at the bottom, each checkbox-gated:
  - **Варианти** — when on: list of `{label, price, stock}` rows with add / remove / reorder;
    hide the single top-level price field and the "Задай наличност" control. ⓘ tooltip.
  - **Промоция** — `%` input + optional end-date picker + live preview
    ("6,50 € → 5,20 €", recomputed client-side for display only). ⓘ tooltip text:
    "Със срок — промоцията пада автоматично на тази дата. Без срок — маха се ръчно."
- Submit maps comma-decimal prices → stotinki (existing helper), sends `variants[]`,
  `salePercent`, `saleEndsAt`.

## 5. chaika storefront (separate repo — tracked as a follow-up task)

- **Product card:** show "от {cheapest}" when the product has variants; struck regular +
  sale price when a promo is active.
- **Product detail:** variant picker (buttons/segmented control); selecting a variant updates
  the displayed price (and sale price); show "изчерпан" per variant.
- **Cart:** each line carries `variantId` + label; add-to-cart sends `variantId`.
- **No price math in the browser** — render server-provided originals + sale prices only.

## Out of scope (YAGNI)

- Two-axis variant matrix (auto-generated combinations).
- Per-variant promo overrides (promo is product-level, applied proportionally).
- Per-variant images.
- Reworking `compareAtPriceStotinki` / bundles.

## Touched files (FarmFlow)

- `packages/db/src/schema.ts` (+`product_variants`, +`products.salePercent/saleEndsAt`,
  +`order_items.variantId/variantLabel`) + new migration `00NN_*`.
- `packages/types/src/index.ts` (PublicProduct + variant/promo types).
- `server/src/modules/products/*` (dto, service: variants CRUD, promo calc, price sync, public shape).
- `server/src/modules/orders/*` (variant capture + atomic stock decrement).
- `server/src/.../worker` cron (expire-promo cleanup, reuse BullMQ repeatable).
- `client/src/components/products/product-dialog.tsx` (+ variants & promo sections, tooltips).

## Risks / notes

- **Overselling concurrency** — guarded by the conditional atomic decrement.
- **NOT NULL `priceStotinki`** — kept valid via cheapest-variant sync.
- **chaika is a separate deploy** — storefront changes ship independently; API must stay
  backward-compatible (new fields are additive, variants optional).
