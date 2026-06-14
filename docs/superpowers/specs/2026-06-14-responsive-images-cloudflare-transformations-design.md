# Responsive images via Cloudflare Transformations — design spec

**Date:** 2026-06-14
**Status:** infra live (custom domain + Transformations enabled & verified); code pending
**Scope:** FarmFlow backend (`server/`) + both storefront repos (Next storefront, chaika Astro). Admin (`client/`) is low-traffic — out of scope.

## Goal

Serve right-sized, modern-format catalog images so listing/grid pages on the
storefronts ship a fraction of the bytes they do today, without per-image
backend plumbing or a DB migration. R2 stays the origin (free egress);
Cloudflare resizes + re-encodes at the edge on demand.

## Why this and not the alternatives

- **Keep single stored object + edge resize (chosen).** No schema change, no
  variant matrix. Cost is ~flat regardless of traffic: R2 egress is free and
  Transformations bills by *unique* (image × params), not per delivery —
  5,000 unique/month free, then $0.50/1,000. ~800 images × 4 widths ≈ 3,200
  unique ⇒ effectively $0.
- **Cloudflare Images (managed storage) — rejected.** Same delivery
  performance, but bills **per image delivered** ($1/100k) ⇒ cost grows
  linearly with traffic (e.g. ~$240/mo at 24M deliveries). Also requires
  migrating every object off R2 and rewriting upload in 6 modules. We lose R2's
  free egress for no perf gain.
- **Pre-generate variants into R2 — rejected.** Also ~free at scale, but needs
  up-front width choices, an AVIF+WebP object matrix, upload-time compute, and
  the same cross-repo plumbing. Transformations gives the same result on demand
  with `format=auto` and zero plumbing.

## Infra (done — 2026-06-14)

- R2 bucket: `farmflow-product-images` (EEUR).
- Custom domain bound to the bucket: **`cdn.farmsteadflow.com`** (proxied CNAME
  on the `farmsteadflow.com` zone, auto-created; status Active).
- Transformations: **enabled for the zone**, Sources = **"This zone only"**
  (allows `*.farmsteadflow.com`, which covers `cdn.`). Do **not** switch to
  "Any origin" (lets third parties spend our transform quota).
- Public Development URL (`pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev`) left
  **enabled** for now — legacy image URLs in the DB embed this host.

### Verified

- `https://cdn.farmsteadflow.com/<key>` → serves the object (custom domain OK).
- `https://cdn.farmsteadflow.com/cdn-cgi/image/width=400,format=auto/https://cdn.farmsteadflow.com/<webp-key>`
  → returns a resized image (transform OK).
- A legacy **PNG** original returned `ERROR 9516: error during decoding`. The
  browser renders it but Cloudflare's stricter decoder rejects the odd PNG
  (likely 16-bit / interlaced / unusual profile). WebP objects transform fine.
  ⇒ drives the "always re-encode to WebP" change below.

## URL shape

Transformation URL (relative source form — preferred, single host):

```
https://cdn.farmsteadflow.com/cdn-cgi/image/<opts>/<key>
```

`<key>` is the stored object key (e.g.
`tenants/{tid}/products/{pid}/{uuid}.webp`). `<opts>` is comma-separated, e.g.
`width=400,format=auto` or `fit=cover,gravity=0.42x0.30,width=400,height=300,format=auto`.

## Backend changes (`server/`, this repo)

### 1. `R2_PUBLIC_URL` env → `https://cdn.farmsteadflow.com`

New uploads then return `cdn.` URLs. `getPublicUrl()` in
`storage/providers/r2.provider.ts` already builds `${R2_PUBLIC_URL}/${key}` — no
code change, env only.

Legacy rows keep the `pub-*.r2.dev` base in `imageUrl` etc.; the storefront
helper normalises the host (below), so legacy images transform too. No data
migration required.

### 2. `optimizeImage` — make every stored object a transform-safe master

`server/src/modules/storage/image.util.ts`. The stored object's job flips from
"the delivered file" to "the master the edge derives every delivery from".
Re-tune accordingly:

- **Always re-encode raster → WebP.** Drop the "keep original if not smaller"
  branch for raster input. Guarantees no odd-PNG `9516` and a consistent master
  format. (Keep the non-raster passthrough for SVG/GIF; keep fallback-to-original
  only on a sharp *throw*.)
- **Raise the size cap 1600 → 2560px.** Edge needs headroom to deliver retina +
  cover-crop zoom (display × DPR × zoom) sharply; it only ever downscales from
  the master. Storage is ~free ($0.015/GB).
- **Raise quality 82 → 90.** The master is re-encoded again at the edge
  (WebP→AVIF); a higher-quality master avoids compounded generation loss.
- Keep `effort: 6` + `smartSubsample` (already on `main` @ `a742f2d`), keep
  `.rotate()` (EXIF) + metadata strip.

> The `effort=6, q82, 1600` values currently on `main` are correct for the
> *pre-transform* world (object == delivered file). This change supersedes them
> and must land **together with** the storefront helper + `R2_PUBLIC_URL` flip,
> not before.

`smartFocal` / `smart-crop.util.ts` is unchanged — it returns 0..1 fractions,
resolution-independent, and feeds `gravity` directly (below).

## Storefront changes (separate repos)

Both storefronts keep their own copy of the cover-crop math
(`coverCropStyle`). Add an image-URL helper next to it.

### Helper: `cfImage(url, { width, height?, focal?, zoom? , dpr? })`

1. **Normalise host.** Strip the origin from `url`, keep the key; always prefix
   `https://cdn.farmsteadflow.com`. This makes legacy `pub-*.r2.dev` URLs
   transform too.
2. **Build opts:**
   - `zoom <= 1` (default; `smartFocal` always sets `zoom:1`, so the vast
     majority): **edge-crop to the box** —
     `fit=cover,gravity={x}x{y},width=W,height=H,format=auto`. Ships only the
     visible window (no hidden cropped-out pixels) and is sharper. The box no
     longer needs `object-position`/`object-fit: cover` in CSS for these.
   - `zoom > 1` (manual, rare): keep the current CSS path
     (`object-fit: cover` + `objectPosition` + `transform: scale`) and request
     `width = ceil(displayWidth × dpr × zoom)` so the magnified crop stays crisp.
3. **`srcset`.** Emit 1x/2x (or a width set) per box so DPR is handled by the
   browser. Cap requested width at the master (2560) — never request larger.

### Box aspects unchanged

The fixed-aspect boxes (4:3 cards, `aspect-square` galleries, fixed-height
hero) stay CSS-defined. With edge-crop we pass each box's `W×H` to CF, so one
stored focal point frames correctly into every box shape.

### `.ph` placeholders

Unaffected — empty slots render the storefront mock, no image URL, no transform.

## Rollout

1. **Infra** — done.
2. **Storefront helper** — ship `cfImage` + wire `<img>`/`srcset` in each
   storefront repo. Safe to ship first: it just rewrites already-working image
   URLs through `cdn.` + transforms; legacy and new keys both resolve.
3. **Backend** — flip `R2_PUBLIC_URL` to `cdn.` + land the `optimizeImage`
   master re-tune together. New uploads become 2560/q90 WebP masters.
4. **Backfill (optional, later)** — re-run `optimizeImage` over legacy odd PNGs
   if any are catalog-visible and 9516 in the field. Most are fine; storefront
   can also fall back to the raw `cdn.` URL (no `/cdn-cgi/image/`) on transform
   error.
5. **Cleanup (later)** — once all live URLs are `cdn.`, disable the R2 public
   dev URL.

## Gotchas

- Transforms only work for sources **on the zone** — hence the `cdn.` custom
  domain + "This zone only". The `pub-*.r2.dev` host cannot be transformed; the
  helper must rewrite the host.
- `9516` decode error = odd source format (legacy PNG). Fixed going forward by
  always re-encoding to WebP; handled for legacy by host-fallback to the raw
  object.
- Never request a width above the 2560 master — CF won't enlarge by default
  (`fit=scale-down`), so it silently returns the master size; with `fit=cover`
  it would upscale and soften.
- `gravity` takes fractional `XxY` (0..1) — exactly `smartFocal`'s output.
- This is **not** a DB migration and **not** a switch off R2.

## Cost / limits

- 5,000 unique transforms/month free, then $0.50/1,000. Catalog-bound, not
  traffic-bound. R2 egress free. Expected bill at our scale: ~$0.
- CF input limits apply (≤100 MP, ≤70 MB source) — the 2560 master is well
  inside them.
