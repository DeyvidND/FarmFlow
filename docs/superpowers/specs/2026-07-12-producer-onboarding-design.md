# Producer onboarding engine — photo AI import · operator batch onboard · image-sanity worker

**Date:** 2026-07-12 · **Status:** draft for owner review.

## Problem

Onboarding a producer today = the operator (Васил) manually keys in the catalog.
Evidence: several farmmarket producers sit at „0 продукта"; the only low-friction
import (AI extract: paste/file → GPT → preview → import) is **super-admin-only**
(`POST /platform/tenants/:id/products/extract`) and **text-only**. The farmer
panel has **no product bulk import at all** — the tenant `import/` module is the
Econt *shipment* bulk import, not products. Summer + the Добрич push (Васил's
producer contacts) need producers onboarded **without the operator in the loop**.
The business metric this serves: *producers onboarded without operator help*.

## Goals

1. A producer can publish their catalog from **one photo** of a price list
   (or pasted text) — self-serve, phone-first.
2. The operator can onboard a producer in **one action**: create producer +
   AI-import catalog + hand over a **magic link** (shareable over Viber).
3. Bad producer photos (sideways / dark / half-a-table) get **auto-fixed in the
   background** so the operator never touches images by hand.

## Non-goals (now)

Self-signup of new tenants; order-split / payout; a Viber intake bot (future);
per-brand organizer accounts (separate track).

---

## Phase 1 — Photo/AI product import in the farmer panel

### Server
- **Move** `ProductExtractService` out of `platform/` into a new shared
  `ai-import/` module (exported); platform controller keeps using it unchanged.
- **Extend it with image input**: jpg/png/webp accepted; sharp-downscale to
  ≤1600px + JPEG re-encode BEFORE sending (token/cost control) → gpt-4o-mini
  vision (`image_url` data-URI) with the SAME Bulgarian prompt + `coerce()`
  validation. Text path unchanged. Reject >10MB with a clear BG message.
- **New tenant-scoped endpoints** (`JwtAuthGuard`):
  - `POST /products/ai-import/extract` — `@Roles('admin','farmer')`, multipart
    `file` (image/.txt/.csv/.xlsx) or `text` → `{ products: ExtractedProduct[] }`.
    Throttled (it's an OpenAI call).
  - `POST /products/ai-import/commit` — takes the reviewed rows; creates products
    via the existing products-create path (same one platform import uses).
    **Farmer role is forced to its own `farmerId`** (same IDOR scope as /stats);
    owner may pass a `farmerId`.
- Extract is sync/foreground (human waits on preview) — mirrors the existing
  platform extract's 30s-timeout choice. No queue here.

### Client (farmer panel)
- On `/products`: button **„Добави от снимка или списък"** → dialog:
  photo upload (`accept="image/*" capture="environment"` — phone camera first),
  or paste text → editable preview table (име/цена/единица/тегло/категория/активен)
  → „Публикувай" → toast + list refresh.
- Preview/edit gate is MANDATORY — vision misreads handwriting; a human confirms
  before anything goes live.

## Phase 2 — Operator batch onboard + magic link (super-admin)

### Server
- `POST /platform/tenants/:id/producers/onboard` (PlatformAdminGuard), multipart:
  `{ name, phone?, email?, pricelistText? , file? }`:
  1. `FarmersService.create` → producer under the brand tenant;
  2. if price list given → ai-import extract → import products attached to the
     new `farmerId` (reuses the Phase-1 service);
  3. if email given → `grantAccess` (existing invite machinery: scoped login +
     set-password email);
  4. mint a **magic link** and return it: reuse the reset-token machinery
     (separate secret, single-use, TTL ~7 days) — the link lands on set-password
     → auto-login → redirect straight to `/products` (their new catalog).
     Platform already generates invite links for delivery accounts — same pattern.
- Response: `{ farmerId, productsCreated, inviteLink }`.

### Admin UI
- On the brand's tenant-detail (and producers screen): **„Onboard производител"**
  → form (име, телефон, имейл, ценоразпис: paste или снимка) → result card:
  N продукта created + magic link + Copy button (operator shares over Viber).
- Batch = repeat the form; no CSV-of-producers UI yet (YAGNI at ~15 producers).

## Phase 3 — Image-sanity worker (product photos)

- **Inline (upload request, milliseconds, no network):** sharp checks — EXIF
  orientation mismatch, resolution below floor, extreme aspect ratio, blur
  (Laplacian variance). ~90% of images pass → nothing else happens.
- **Anomaly → enqueue** on the existing `IMAGE_QUEUE` (new named job
  `image-sanity`, gated by `RUN_WORKERS` like the other processors):
  1. fetch original from R2, sharp-downscale → data-URI;
  2. gpt-4o-mini vision returns a **decision**, not pixels:
     `{ rotate: 0|90|180|270, cropBox?, verdict: 'ok'|'unusable', reason }`;
  3. sharp applies rotate/crop → derived image uploaded to R2 → product points at
     the derived; **original always kept**; `autoFixed: true` recorded.
- **Guards:** skip when the farmer set a manual crop (their tool wins);
  `verdict:'unusable'` → change nothing, flag „лоша снимка" in the panel;
  every failure swallowed — an image never breaks an upload (the commission
  fire-and-forget pattern); queue retries/backoff come free.
- **UI:** „оправена автоматично" badge + „върни оригинала" revert.
- **Data:** original key + autoFixed flag on the product-media record —
  hand-written migration (project rule), exact column vs jsonb decided at build
  after reading the media schema.

---

## Testing

- ai-import: unit tests for the image path with a mocked OpenAI client (data-URI
  built, prompt fed, coerce applied); existing text-path tests keep passing.
- onboard endpoint: spec with mocked FarmersService/extract/invite — one call
  creates producer + products + link; farmer-role IDOR scope on commit covered.
- sanity checks: sharp unit tests on small fixtures (rotated / low-res / blurred).
- `tsc --noEmit` on server + client + admin; affected jest suites.

## Rollout

Phase 1 → 2 → 3, each independently shippable. 1+2 are the lever (Добрич now);
3 is polish that prevents the operator sneaking back in through photo cleanup.

## Risks

- **Handwriting OCR errors** → mandatory human preview before publish (both flows).
- **HEIC (iPhone)** — sharp needs libheif; verify at build, else reject with a
  clear „снимай/прати като JPEG" message.
- **Magic-link leakage** — single-use + TTL + separate secret (reset-token
  machinery); sharing over Viber is the operator's explicit act.
- **Cost** — extract ≈1 vision call per onboard; sanity vision only fires on the
  anomalous minority.
