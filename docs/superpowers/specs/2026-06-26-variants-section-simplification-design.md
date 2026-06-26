# Variants Section Simplification — Design

**Date:** 2026-06-26
**Status:** Approved (brainstorm), pending implementation plan
**Repos affected:** FarmFlow (panel + a small server read). chaika: none.

## Goal

Simplify how a farmer enters price, stock, and variants in the product dialog, and
make variant stock integrate correctly with the existing „Задай наличност"
(availability windows) mechanism so there is one source of truth for stock.

Three changes:
1. Remove the „Този продукт има варианти" checkbox. One always-visible
   „Цена и наличност" section of priced rows. **One row = a simple product; two or
   more rows = variants.**
2. Add a short hint under each input.
3. Stock entered here must not desync with the „Задай наличност" screen.

## Decisions (from brainstorm)

- **No checkbox.** „has variants" is *derived*: a product with exactly one priced
  row is a plain product; two or more rows make it varianted.
- **One unified section** „Цена и наличност" replaces both the old top-level
  `Цена`/`Наличност` fields and the old „Варианти" collapsible. It always shows at
  least one row, starting with one empty row.
- **The single row's label is optional** — a plain product needs no „вид/грамаж".
- **Promo:** with one row, only the product-level % promo applies. With two or more
  rows, the existing toggle „Процент за всички | Фиксирана цена по вариант" appears.
- **Stock has one source of truth:**
  - 1 row (simple) → the product availability window (`setProductStock`), exactly as
    today; the „Задай наличност" screen edits the same number.
  - 2+ rows (varianted) → per-variant `stockQuantity`; the product window is
    **cleared** (`setProductStock(null)`), so nothing competes.
- **„Задай наличност" screen shows varianted products with an explanation, not a
  stock control** — directing the farmer to manage stock in the product itself.
- **No migration, no chaika change, no change to the server pricing/variant model.**

## 1. Product dialog — `client/src/components/products/product-dialog.tsx`

### Remove
- The `hasVariants` checkbox + `hasVariants` state.
- The three `{!hasVariants && …}` top-level blocks: `Цена (€)`, `Наличност`, and the
  „Задай наличност на много продукти наведнъж →" link.
- The standalone `price` / `stock` states are folded into the rows (see below).

### „Цена и наличност" section (replaces the „Варианти" collapsible, moved up to where
price used to be; not collapsible — always visible)
- Row shape `VRow = { id?, label, price, stock, salePrice }`. Always ≥1 row.
- Each row, one line: `Вид / грамаж (по избор)` (flex-2, min-w-0) · `Цена` (flex-1,
  min-w-0) · `Наличност` (w-18) · 🗑 (the trash is disabled/hidden when only one row
  remains — a product can't have zero rows).
- A hint under each input (small, `text-ff-muted`):
  - label: „Празно = един вид"
  - price: „напр. 6,50 €"
  - stock: „празно = неограничено"
- `+ Добави вид / грамаж` adds an empty row.
- When `promoMode === 'fixed'` AND there are 2+ rows, each row shows a second line:
  `Промо цена` + input, hint „празно = без промо".
- Section helper line: „Един ред = един продукт. Добави още за разфасовки/видове.
  Наличност празна = неограничено."

### Promotion section
- Compute `filledCount` = rows with a parseable price > 0.
- `filledCount < 2`: show only `Намаление (%)` + `Край (по избор)` (+ live preview).
  Force `promoMode = 'percent'`.
- `filledCount >= 2`: show the radio toggle „Процент за всички | Фиксирана цена по
  вариант" exactly as it works today; in fixed mode show the per-row „Промо цена".

### Submit logic
```
filled = rows.filter(r => priceStotinki(r) > 0)        // label optional
if filled.length === 0 → error „Въведи цена"
if filled.length >= 2 && filled.some(no label) → error „Всеки вариант се нуждае от име"

const varianted = filled.length >= 2
const fixedMode = varianted && promoMode === 'fixed'

ProductWrite = {
  …other fields,
  priceStotinki: varianted ? min(filled prices) : filled[0].price,
  stock: varianted ? null : filled[0].stock,        // null clears the product window
  variants: varianted ? filled.map(toVariantWrite) : [],   // [] = plain product
  salePercent: fixedMode ? null : pct,
  saleEndsAt: fixedMode ? null : promoEnd,
}
```
- `toVariantWrite` carries `{id?, label, priceStotinki, salePriceStotinki, stockQuantity}`
  (fixed promo only in fixed mode; else `salePriceStotinki: null`). Validate
  `salePriceStotinki < priceStotinki` (existing rule).
- The server's `setProductStock` already turns `stock: null` into „clear the window"
  and `stock: <n>` into „upsert the window" — no server change for stock routing.

### Edit prefill
- Load variants (`listProductVariants`).
  - If rows exist → fill `VRow[]` (incl. `salePrice` from `salePriceStotinki`); set
    `promoMode = 'fixed'` if any row has a fixed promo price.
  - If no variants → seed exactly one row: `{ label:'', price: product price,
    stock: <loaded availability quantity or ''>, salePrice:'' }`, `promoMode='percent'`.
- This reuses the existing availability-window prefill (`listAvailabilityWindows`) to
  fill the single row's stock.

### Mode transitions (handled automatically by the submit logic)
- simple → varianted: server clears the old window (`stock:null`), writes variant rows.
- varianted → simple (farmer deletes down to one row): `variants:[]` soft-deletes the
  variant rows, `stock:<n>` recreates the window from that row.

## 2. Server — `availability.service.ts` `listPickerProducts`

Add `hasVariants: boolean` to each returned product: true when the product has ≥1
non-deleted `product_variants` row. A correlated `EXISTS` (or left join + group)
keeps it a single query. Keep returning *all* products (varianted ones are shown with
an explanation, not excluded). Update the `listPickerProducts` return type and the
`PickerProduct` type in `client/src/app/(admin)/availability/page.tsx`.

No other server change. No migration.

## 3. „Задай наличност" screen — `client/src/components/availability/availability-client.tsx`

For a product where `p.hasVariants`:
- Replace the „+ Задай наличност" button, the window rows, and the „Няма зададена
  наличност." line with a note block:
  - Title: „Управлява се чрез варианти"
  - Body: „Този продукт има няколко вида/грамажа. Наличността се задава за всеки от тях
    в самия продукт."
  - Link: „Отвори продукта →" → `/products` (the farmer opens the product there; its
    „Цена и наличност" section holds the per-variant stock).
- `BulkWindowEditor` receives only non-varianted products:
  `products={visibleProducts.filter(p => !p.hasVariants)}` — a bulk window can't apply
  to per-variant stock.

## 4. Out of scope / explicitly unchanged

- chaika storefront: variant `soldOut` already drives its display; because the product
  window is cleared for varianted products, no stale „N в наличност" badge can appear.
  No chaika change.
- Server pricing/variant model, order intake, `product_variants` schema, all promo
  logic: unchanged. No migration.
- The availability window mechanism for plain products: unchanged.

## Touched files

- `client/src/components/products/product-dialog.tsx` — remove checkbox + top
  price/stock; unified rows section; per-input hints; submit + prefill rewrite.
- `server/src/modules/availability/availability.service.ts` — `listPickerProducts`
  gains `hasVariants`.
- `client/src/app/(admin)/availability/page.tsx` — `PickerProduct` gains `hasVariants`.
- `client/src/components/availability/availability-client.tsx` — varianted-product
  note + bulk filter.
- `server/src/modules/availability/availability.service.spec.ts` — `hasVariants` flag.

## Risks / notes

- **Stock desync** — prevented by clearing the product window when a product becomes
  varianted, and by the screen showing varianted products read-only.
- **Empty product (zero rows)** — impossible: the section always keeps ≥1 row, trash is
  disabled at one row, and submit rejects zero priced rows.
- **No unit-test runner on the client** — verify the dialog via tsc + `next build` +
  manual; the server `hasVariants` flag gets a jest test.
