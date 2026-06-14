# Implementation plan — responsive images via Cloudflare Transformations

Spec: `../specs/2026-06-14-responsive-images-cloudflare-transformations-design.md`

Two repos: **FarmFlow** (`server/`) and **fermerski-pazar-chaika** (Astro storefront).
Infra already live & verified (`cdn.farmsteadflow.com` + zone Transformations).

## Approach (final)

Width-resize + `format=auto` + `srcset`, **keeping the existing CSS cover-crop
unchanged** (`object-fit:cover` + `coverCropStyle`). This is the safe, high-value
path for a live storefront: the byte win comes from 2560 master → ~400–1200px
display + AVIF, and the framing math is untouched so nothing visually shifts.
Edge-crop with `gravity` (ship only the visible window) is a documented v2.

`.png` is **skipped** by the helper (served raw): legacy odd PNGs can return CF
`ERROR 9516`; serving raw keeps them working. New uploads are always WebP (master
re-tune), so this only affects pre-existing PNGs until a backfill.

## Go-live sequencing (must be coordinated)

Landing the master re-tune (2560/q90) *before* transforms front the images would
briefly ship bigger raw masters. So:

1. Merge chaika storefront changes (helper + wiring). Safe alone — only rewrites
   already-working URLs through `cdn.` + transforms; no CDN env yet ⇒ no-op.
2. Set `PUBLIC_IMG_CDN=https://cdn.farmsteadflow.com` on the chaika deploy →
   transforms go live against current 1600/q82 masters. Verify.
3. Flip backend `R2_PUBLIC_URL=https://cdn.farmsteadflow.com` **and** merge the
   `image.util` master re-tune together → new uploads become 2560/q90 WebP,
   always fronted by resize.
4. (later) Backfill legacy PNGs → WebP; then drop the `.png` skip.
5. (later) Disable the R2 public dev URL.

## FarmFlow (`server/`) — branch off `main`

- `R2_PUBLIC_URL` → `https://cdn.farmsteadflow.com` (deploy env; `getPublicUrl`
  already composes `${base}/${key}`). No data migration.
- `storage/image.util.ts` master re-tune:
  - always re-encode raster → WebP (drop the "only if smaller" branch; keep
    SVG/GIF passthrough + fallback-to-original on a sharp throw).
  - `MAX_EDGE` 1600 → 2560; `QUALITY` 82 → 90; keep `effort:6`, `smartSubsample`,
    `.rotate()`, metadata strip.
- Update `image.util` doc comment; adjust any test expectation.

## chaika — branch `feat/cf-image-transforms`

- `src/lib/config.ts`: add `CDN_BASE` from `PUBLIC_IMG_CDN` (default `''` = off).
- `src/lib/img.ts` (new): `cfImage(url, width)`, `cfSrcset(url, widths[])`,
  `IMG_ORIGIN`. Host-normalise (key-only → `cdn.` prefix) so legacy `pub-*.r2.dev`
  URLs transform too; skip `.png`; cap widths at 2560; fallback to raw when no CDN.
- Wire `<img>` (src + srcset + sizes), keep `coverCropStyle`:
  - `components/ProductCard.astro` — grid card
  - `components/FarmerCard.astro` — farmer card
  - `components/CategoryCard.astro` — category card
  - `components/ProductOfWeek.astro` — POTW media
  - `components/Gallery.astro` — main + thumbs + `data-src` swap target
  - `components/MediaSlot.astro` — decorative site slots
  - `pages/articles/[slug].astro` — cover + inline + related
  - `pages/articles.astro` — featured + list covers
  - `scripts/cart-page.ts` — cart line-item thumb
- Preconnect: prefer `IMG_ORIGIN` (CDN) when set — `Layout.astro` / pages.
- Deploy env: `PUBLIC_IMG_CDN` in `docker-compose.yml` + `SECRETS.md`.

## Verify

- chaika `npm run build` green; spot-check generated `srcset`/`/cdn-cgi/image/`.
- FarmFlow `tsc` + jest (storage/articles) green.
- Manual: a card image returns AVIF/WebP smaller than the master; framing
  unchanged; a legacy `.png` still loads (raw).
