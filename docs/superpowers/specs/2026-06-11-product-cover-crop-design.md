# Product cover framing (portrait + landscape photos without breaking the grid)

**Date:** 2026-06-11
**Branch:** feat/cod-payment-method
**Status:** approved (approach A)

## Problem

Product photos come in mixed orientations (portrait, landscape, square). Storefront
product cards use a **fixed-aspect `.ph` box** (`4/3` priroda / base, `1/1` svezho,
`4/5` klasik) with `object-fit: cover`. So a tall portrait photo is center-cropped to
a wide box and a landscape photo is cropped on the sides — the subject is often cut or
looks "shrunk". The farmer has no control over which part survives the crop.

Hard constraint from the user: **the grid must never break** — every card must keep an
identical height so rows stay aligned. That rules out variable-aspect (masonry) and
letterbox-with-dead-space approaches.

## Decision — Approach A: fixed box + reposition crop

Keep the fixed-aspect box and `object-fit: cover` (grid heights stay identical), but let
the farmer **drag to frame** which part of the photo shows, plus zoom. The framing is a
focal point + zoom stored per product. Portrait and landscape photos both work because
the farmer picks the visible region; the bad/auto crop goes away.

This reuses the **existing cover-crop feature** already shipped for farmers and
subcategories (migration 0034): the `cover_crop` jsonb column, the `CoverCrop` type, the
`CoverCropEditor` admin control (drag/zoom/center, WYSIWYG preview), and the
`coverCropStyle()` render helper in both storefronts. Products get the same treatment.

**Tradeoff (accepted):** edges are still cropped to fit the box — but the crop is now
intentional (farmer-chosen), not arbitrary. Grid integrity is preserved 100%.

Rejected: B (true orientation / masonry — breaks row heights), C (contain + blur fill —
boxed-in look, heavier render).

## Data model

Add `cover_crop` jsonb to `products`, identical to `farmers` / `subcategories`:

```ts
// packages/db/src/schema.ts — products
coverCrop: jsonb('cover_crop').$type<{ x: number; y: number; zoom: number }>(),
```

- `x`,`y` = focal point, fractions 0..1 of the source. `zoom` = 1..3.
- `NULL` = legacy behavior (centered, no zoom) — every existing product is unaffected.
- Migration **0040** (drizzle-kit generate): `ALTER TABLE "products" ADD COLUMN "cover_crop" jsonb;`

Type flow is automatic on the public path: `Product = InferSelectModel<products>` gains
`coverCrop`; `PublicProduct` keeps it (its `Omit` only strips tenant/stock/stripe); the
server's `toPublicProduct` spreads `...rest` so it ships without further change. The
local admin mirror (`client/src/lib/types.ts` `Product`) and the chaika mirror
(`fermerski-pazar-chaika/src/lib/types.ts` `Product`) are hand-maintained and each need
the field added.

## Server

- `create-product.dto.ts`: add a nested, optional, nullable `coverCrop` exactly like
  `create-farmer.dto.ts` (`@ValidateNested` + `@Type(() => CoverCropDto)`,
  `nullable: true`). `UpdateProductDto = PartialType(CreateProductDto)` inherits it.
- `products.service` `create`/`update` already spread the DTO into the row, so the column
  follows with no service change. The public catalog query is `select()` (all columns),
  so `coverCrop` is included; no curated-select edit needed.

## Admin (client)

- `ProductDialog` (edit mode only — needs a saved product + cover image):
  - Add `imageUrl` + `coverCrop` state seeded from the product.
  - Render `<CoverCropEditor imageUrl aspect={4/3} value={coverCrop} onChange={setCoverCrop} />`
    below the `MediaManager`, only when an `imageUrl` exists. `4/3` = the default/base
    product-card aspect; the focal point generalizes across the theme aspects (the editor
    preview is representative, not exact-per-theme).
  - Wrap `onCoverChange`: on a new cover photo, reset `coverCrop` to `null` (stale framing
    is invalidated) — same rule as `FarmerPanel`.
  - Include `coverCrop` in the `onSubmit` payload.
- `ProductsClient.onFullUpdate` already does `patchLocal(updated)` from the API response,
  so the new `coverCrop` round-trips into local state.

## Storefront (Next)

One shared component covers every card usage (catalog, related, farmer page, home):

- `storefront/src/components/product-card.tsx`: merge `coverCropStyle(product.coverCrop)`
  into the `<Image>` style (replaces the standalone `objectFit: 'cover'`).
- `storefront/src/components/product-of-week.tsx`: same merge on the featured `<Image>`.
- Product **detail** page / gallery is out of scope — it shows full images, not a card.

## Chaika (Astro storefront)

- `src/lib/types.ts` `Product`: add `coverCrop?: CoverCrop | null;`.
- `src/components/ProductCard.astro`: append `coverCropStyle(p.coverCrop)` to the cover
  `<img>` inline style, exactly like `FarmerCard.astro`. The `.ph` box already has
  `overflow: hidden`, so zoom is safe.

## Build / verify

- `packages/db` + `packages/types` are consumed via `dist` → rebuild both after editing.
- Generate migration 0040, run server/client/storefront typecheck + build, chaika build.
- Run server test suite (currently 227/227).
- Live E2E: upload a portrait + a landscape product photo, frame each in the editor,
  confirm the storefront grid rows stay aligned and the chosen region shows.

## Out of scope

- Variable-aspect / masonry grid (B), blur-fill (C).
- Product detail gallery framing.
- Per-theme exact editor preview aspect (focal point is aspect-tolerant).
