# Cover image reposition (pan + zoom) — design

Date: 2026-06-09
Status: approved, implementing

## Problem

Farmer and category (subcategory) **cover** images render with hard-coded
`object-fit: cover` and default center crop. Some photos show the wrong part
(faces/products cut off — "изрязани"). Admins need Discord-style control over
how the cover is framed.

## Decisions (from brainstorming)

- **Interaction:** pan + zoom (drag to move, slider/wheel to zoom). Like Discord.
- **Scope:** the **cover** image only. Galleries untouched.
- **Storefronts:** both the in-repo Next.js `storefront/` AND the separate Astro
  repo `fermerski-pazar-chaika` (chaika done as a second step).
- **No image re-processing.** Original R2 file untouched; framing is pure CSS.
  Backward-compatible — existing rows render exactly as today until adjusted.

## Data model

Add nullable jsonb `cover_crop` to `farmers` and `subcategories`:

```ts
type CoverCrop = { x: number; y: number; zoom: number };
// x, y normalized 0..1 (focal point), zoom 1..3. null = center, no zoom.
```

Stored on the record (not per media row) — describes how the *current* cover is
framed. Swapping the cover image keeps the saved framing; admin re-adjusts if
needed (same as Discord per-avatar behavior). Works for both legacy `imageUrl`
and `farmerMedia[0]` cover paths with no per-row complexity.

Migration: add two columns, default null. No data backfill.

## API

`PublicFarmer` and `PublicSubcategory` expose `coverCrop: CoverCrop | null`.
Base `Farmer` / `Subcategory` types gain the field too (admin reads it back).

## Admin editor (client)

One shared `<CoverCropEditor>`:
- Shows the cover image in a frame at the **storefront card aspect ratio**
  (3:2 farmers; category section frame).
- Drag = pan, slider + wheel = zoom (1x–3x).
- Live preview == exactly what the storefront card will show (shared math).
- Save → `PATCH /farmers/:id` / `PATCH /subcategories/:id` body `{ coverCrop }`.

Mounted in `farmer-panel.tsx` and `subcategory-panel.tsx`, next to the cover.
Disabled / hidden when no cover image exists.

## Storefront render (in-repo Next.js)

Shared helper `coverStyle(coverCrop)` → `{ objectPosition, transform }`:
- `objectPosition: '${x*100}% ${y*100}%'` (default `50% 50%`).
- `transform: 'scale(${zoom})'` (default none), container already clips.

Applied at every place the **cover** renders:
- `farmer-card.tsx`
- category cover in `storefront-catalog.tsx`
- farmer detail hero `farmers/[id]/page.tsx` (same image — keep consistent)

## Chaika (Astro, separate repo) — step 2

After API exposes `coverCrop`, mirror the same CSS in the Astro farmer/category
card. Separate commit in `fermerski-pazar-chaika`.

## Tests

- Server: serializer returns `coverCrop`; PATCH persists + validates range
  (clamp/reject out-of-range x/y/zoom).
- Shared `coverStyle` / clamp helper: unit tested (in/out CSS).

## Out of scope

- Per-gallery-photo framing.
- Server-side cropped derivatives.
- Product / blog images.
