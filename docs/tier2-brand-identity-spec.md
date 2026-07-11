# Tier 2 — Бранд идентичност (implementation spec)

Maps the published Claude Design mockup (`Фермерски пазари` project → `Бранд идентичност (Tier 2).dc.html`)
to FarmFlow's real data model. Written 2026-07-11.

Paid, super-admin-managed per-farmer feature: an unlocked farmer gets a **big portrait + photo
gallery (choosable layout) + own brand color/logo/story/badges** on their marketplace subpage,
while staying "part of Фермерски пазари". Tiers: 1 = listing, **2 = brand identity**, 3 = own site.

## What already exists (reuse — do NOT rebuild)

Per-farmer columns (`packages/db/src/schema.ts` → `farmers`):
- `tint` text — **the brand primary color**. Already public.
- `imageUrl` text — portrait / cover. Already public + upload path in farmer panel.
- `coverCrop` jsonb — focal/zoom framing.
- `bio` (story), `role`, `since`, `city`, `name`, `phone`, `email` — all public.
- `farmer_media` table — **the gallery**: N images per farmer, positioned, with upload +
  reorder + delete already implemented (`farmers.service.ts` media methods).

Public projection `findPublicBySlug()` already returns `{ tint, imageUrl, coverCrop, images[],
bio, role, since, city, ... }`. The marketplace already fetches all of this via `/public/:slug/bootstrap`.

So the rendering data is ~90% already on the wire. Only the Tier-2 *control layer* is missing.

## New = one jsonb column + gate

### 1. Schema — `farmers.branding` jsonb (migration 0087)
```ts
// farmers table, after coverCrop
branding: jsonb('branding').$type<{
  enabled: boolean;            // the paid gate — false = render default compact card
  plan?: 'tier2';
  accent?: string;             // secondary color (hex). primary stays `tint`.
  headingFont?: 'lora' | 'manrope' | 'playfair' | string;
  gallery?: 'wide' | 'mosaic' | 'row' | 'grid';  // layout variant picker; default 'mosaic'
  badges?: string[];           // ['verified','bio','awarded'] → chips
  unlockedAt?: string;         // ISO — when operator turned it on
  unlockedBy?: string;         // admin user id (attribution, matches audit pattern)
}>(),
```
Migration: `ALTER TABLE farmers ADD COLUMN IF NOT EXISTS branding jsonb;`
NULL/`enabled:false` = today's behavior (safe default, zero blast radius).

### 2. Public projection — one line
`farmers.service.ts findPublicBySlug()` select: add `branding: farmers.branding`.
Presentational only (no finance) → whole object is safe to expose. Add `branding` to
`PublicFarmer` type + `@fermeribg/types`. Rebuild db/types dist.

### 3. Super-admin control (the "директен достъп" ask)
Gate + editor live in the **admin Фермери editor** (super-admin only):
- Toggle **Бранд идентичност: активна** → sets `branding.enabled` + stamps `unlockedAt`/`unlockedBy`.
- Controls: accent color + preset swatches, gallery-layout picker (4 variants: Едра / Мозайка /
  Три в ред / Решетка), heading font, badges. Primary color reuses existing `tint` field.
- Portrait + gallery reuse the **existing** farmer-panel upload/reorder components (no new upload code).
- "Запази и приложи" → PATCH farmer → bust public cache (`publicCacheKeys.farmers(tenantId)`).

Because super-admin can already impersonate into the real farmer panel (Operator Command Center),
the same branding section can render inside `farmer-panel.tsx` gated on `branding.enabled` — so a
paying farmer self-edits too. Operator owns the gate; farmer tweaks within it. Matches design's
"somewhat custom, easy to apply".

### 4. Marketplace render (repo: farmflow-marketplace-next)
`src/app/farmer/[slug]/page.tsx` — branch on `farmer.branding?.enabled`:
- **enabled** → Tier-2 layout: big cover (`imageUrl`/`images[0]`) + 112px overlapping portrait,
  brand `tint` tints chrome/buttons/prices, accent as secondary, gallery rendered in
  `branding.gallery` layout (mosaic = 1 big + 2 small, etc.), badges as chips, story in serif.
- **disabled** → current compact card (unchanged).
Pure client rendering; all data already arrives in bootstrap. This is the mockup made real.

## Blast radius / risk
- Additive only: 1 nullable jsonb column, 1 projection line, 1 type field, 1 admin section,
  1 conditional in the marketplace. No change to non-Tier-2 farmers.
- No money movement — gating is a boolean the operator flips (billing/collection out of scope here,
  same as vendor-finance "dormant" pattern: the switch exists, charging is a separate seam).
- Cache: branding change must bust `farmers(tenantId)` public cache (existing helper).

## Build order
1. schema + migration 0087 + dist rebuild
2. projection + PublicFarmer type
3. admin editor section (gate + controls) + cache bust
4. marketplace-next conditional Tier-2 layout
5. verify: unlock Васил-style test farmer → marketplace shows branded page; locked farmer unchanged

## Open decision for operator
Where the rich controls primarily live: **admin Фермери editor** (recommended — operator builds it),
with an optional mirror into the farmer's own panel when unlocked. Billing/collection deferred
(gate is manual, like vendor-finance dormant).
