# Stock field in the product dialog

**Date:** 2026-06-18
**Status:** Approved (design), pending implementation

## Problem

Adding a product and setting its stock are two separate screens. The product
dialog has **no** quantity field — instead an info-note tells the farmer stock
lives in „Задай наличност". A new farmer adds „Ягоди", expects to type „имам 20"
right there, can't, and has to leave for another nav item. The two-place model
hits the single most-common daily task.

## Goal

Let the farmer set stock directly in the product dialog. „Задай наличност"
becomes optional/bulk, not a mandatory detour. **Empty = unlimited** (a product
with no number is simply always available — current behaviour).

## Core principle — no new stock system

The dialog field writes to the **same** availability window the „Задай наличност"
screen already uses: one open-ended window per product, sentinel range
`2000-01-01`→`9999-12-31`, edited by `quantity`. Both screens edit the same
field, so they never desync. The 2026-06-16 "stock unified on availability
windows" decision is preserved; the dead `stockQuantity` column is **not**
revived.

## Behaviour

| Dialog „Наличност" | Existing window | Result |
|--------------------|-----------------|--------|
| number             | none            | insert window, `quantity = remaining = N` |
| number             | exists          | update `quantity = N`, `remaining = applyQuantityDelta` (preserve already-sold) |
| empty (`null`)     | exists          | delete window → unlimited |
| empty (`null`)     | none            | no-op |
| absent (`undefined`) | —             | untouched (toggle/reorder paths never wipe stock) |

## Server (NestJS)

1. **`AvailabilityService.setProductStock(tenantId, productId, quantity: number | null)`**
   — upsert-or-delete the open window in the one place that owns window logic.
   Reuses `OPEN_START/OPEN_END`, `applyQuantityDelta`, `rangesOverlap`, `bust()`.
   Ownership is already proven by the caller (ProductsService owns the product it
   just created/updated); every query is still tenant-scoped (defence in depth).

2. **`CreateProductDto`** — add virtual `stock?: number | null`
   (`@IsOptional`, `@IsInt`, `@Min(0)`, `@Max(1_000_000)`, allow `null`). Declared
   so the global `forbidNonWhitelisted` pipe keeps it. Not a products column.
   `UpdateProductDto` inherits it via `PartialType`.

3. **`ProductsService.create`** — destructure `stock` out before the products
   insert; after insert, if `typeof stock === 'number'` call `setProductStock`.

4. **`ProductsService.update`** — destructure `stock` out before the products
   update; if `stock !== undefined` call `setProductStock` (number sets, `null`
   clears). Guard the products `.set()` so a stock-only edit doesn't run an empty
   update.

5. **`ProductsModule`** imports `AvailabilityModule` (already exports
   `AvailabilityService`). No circular dep — availability uses the `products`
   table directly, never `ProductsService`. Inject `AvailabilityService` into
   `ProductsService`.

## Client (Next)

6. **`ProductDialog`** — replace the „Наличността се задава от…" info-note with a
   real field:
   - „Наличност" number input, placeholder „напр. 20", helper „остави празно =
     неограничено · винаги налично". Always shown, empty by default.
   - Edit-open: fetch `listAvailabilityWindows(product.id)` → seed the window
     `quantity` (not the `remaining` badge value, so the two screens stay in sync).
   - Keep a small link „Управлявай наличността на всички →" `/availability`.
   - Send `stock` (number or `null`) in the submit payload.

7. **`createProduct` / `updateProduct`** (api-client) — widen the payload to
   `Partial<Product> & { stock?: number | null }`.

8. **`products-client.tsx`** — thread `stock` through `onCreate` / `onFullUpdate`;
   refresh the card stock badge after save. Retire the now-misleading
   `ff:hint:stock-moved` banner.

## Tests

- `availability.service.spec` — `setProductStock`: insert / update-preserves-sold
  / delete-on-null / null-no-window no-op.
- `products.service.spec` — create + update with stock call through to
  availability; absent stock leaves windows untouched.
- `create-product.dto.spec` — `stock` accepts number ≥ 0 and `null`, rejects
  negative / non-int.
- Existing availability + product suites stay green.

## Out of scope

The „Задай наличност" screen, the storefront stock badge, `decideDecrement`
checkout logic, and the dead `stockQuantity` column. No DB migration (the window
table already exists).

## Blast radius

~6 server files, ~3 client files, + tests. No migration.
