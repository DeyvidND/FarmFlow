# Editable Site Photos — reusable "media slots"

**Date:** 2026-06-07
**Status:** Approved design, pending implementation
**Scope:** Backend (FarmFlow/server + packages) → tenant admin panel (FarmFlow/client) → storefront rendering (fermerski-pazar-chaika, Astro). The Next.js monorepo storefront (FarmFlow/storefront) is out of scope for now.

## Problem

Storefront landing/marketing pages render decorative graphics as static CSS placeholders (`.ph` boxes: radial-dot pattern + a centered text label like "Пазар на Чайка · щандове · 16:10"). These are NOT data-driven (products/farmers/categories/articles already have real images). Market owners cannot replace these decorative placeholders with their own photos.

Goal: let a tenant upload a photo for each static decorative spot from the admin panel, preview it, and have the storefront render the photo (falling back to the existing `.ph` mock when empty). The mechanism must be reusable across multiple storefront sites.

## Core concept — "media slot"

A **media slot** is a fixed decorative image position on a storefront, identified by a stable string key. Each slot has metadata: a Bulgarian label (where it appears), an aspect ratio, a page, and a group. A tenant uploads at most one image per slot. Empty slot → storefront shows the existing `.ph` mock.

Three reusable pieces:
1. **Backend media map** — a generic `slotKey → image` store on the tenant. Knows nothing about specific slots. Works for any site.
2. **Slot catalog** — the contract describing which slots exist (keys/labels/ratios/grouping), stored per site-theme on the backend and served via API. Admin renders its editor dynamically from the catalog → no admin code change per new site.
3. **Storefront wrapper** — a ~20-line component that renders the uploaded image or the `.ph` mock. Copied into any storefront.

## Decisions (confirmed)

- **Catalog location:** backend, theme-keyed constant, served via API (most reusable).
- **Pillar images** ("Пазар на място" / "Доставка до дома") are **shared** across home + orders (one upload fills both).
- **Storefront target:** Пазар Чайка (Astro) only, for now.
- **Preview:** per-slot aspect-ratio thumbnails in the admin + a "Виж сайта" live link.
- **Maps** (Google Maps placeholders), **skeleton/ghost** cards, **review avatars**, and the **404 emoji** are NOT slots.

## Data model

Tenant `settings` jsonb already exists (holds `delivery`, `routing`). Add:

```ts
settings.media = { [slotKey: string]: { url: string; key: string } }  // R2 url + object key
settings.siteTheme?: string  // default "pazar"; selects which catalog applies
```

No DB migration required (jsonb).

## Slot catalog (theme "pazar")

Stored as a backend constant. Each entry: `{ key, label, ratio, page, group?, rounded?, klass? }`.

| key | label (BG) | ratio | page |
|---|---|---|---|
| `site.pillar_market` | „Пазар на място“ · щандове | 16:10 | shared (home+orders) |
| `site.pillar_delivery` | „Доставка до дома“ · кашон | 16:10 | shared (home+orders) |
| `home.hero` | Hero · щандове на пазара | 4:5 | Начало |
| `orders.box` | Кашон с поръчка | 4:3 | Поръчки |
| `about.portrait` | Пазарът на Чайка | 4:5 | За нас |
| `about.gallery_stalls` | Щандовете на пазара | 2:1 | За нас |
| `about.gallery_basket` | Кошница с плодове | 1:1 | За нас |
| `about.gallery_honey` | Буркани с мед | 1:2 | За нас |
| `about.gallery_dairy` | Сирене и мляко | 1:1 | За нас |
| `about.gallery_farmer` | Фермер на щанда | 1:1 | За нас |
| `about.gallery_sweets` | Домашни сладка | 1:1 | За нас |
| `about.gallery_customers` | Клиенти на пазара | 1:1 | За нас |

Pages grouped for the admin editor: **Начало**, **Поръчки**, **За нас** (shared pillars listed under Начало with a note they also appear on Поръчки).

## Backend — endpoints

Reuse the existing R2 storage service + file validation (jpeg/png/webp, 5 MB) used by products/farmers media.

- `GET /tenants/me/media` → `{ catalog: SlotDef[], values: Record<slotKey,{url}> }` — drives the admin editor.
- `POST /tenants/me/media/:slotKey` (multipart field `image`):
  - Validate `slotKey` exists in the tenant's catalog (reject unknown → 400).
  - Upload to R2 key `tenants/{tenantId}/site/{slotKey}/{uuid}.{ext}`.
  - If a previous object exists for the slot, delete it from R2.
  - Set `settings.media[slotKey] = { url, key }`, persist, invalidate cache.
  - Return `{ slotKey, url }`.
- `DELETE /tenants/me/media/:slotKey`:
  - Delete the R2 object, remove the key from `settings.media`, persist, invalidate cache.
  - Return `{ ok: true }`.

Slot-key writes must be merge-safe (read-modify-write the `media` sub-object, do not clobber sibling settings keys).

## Backend — public exposure + cache

- Add `media: { [slotKey]: { url } }` to `PublicStorefront` / the bootstrap `storefront` payload.
- **Cache caveat:** `public-cache.service` `resolveTenant()` strips raw `settings` and caches a derived `TenantMeta`. Add `media` to that derived/cached shape (same treatment as `delivery`).
- Invalidate `tenant:{slug}` on every media upload/delete (the same invalidation path `PATCH /tenants/me` uses).

## Admin panel — new tab

- **Nav:** add an item to `client/src/components/layout/sidebar.tsx` under the **Маркетинг** group: label "Снимки на сайта", route `/site-media`.
- **Route:** `client/src/app/(admin)/site-media/page.tsx` + a client component.
- **Data:** `GET /bff/tenants/me/media` → `{ catalog, values }`.
- **UI:** slots grouped by page (Начало / Поръчки / За нас). Each slot = a card showing:
  - the Bulgarian label,
  - an aspect-ratio thumbnail: the uploaded `<img>` if set, else a `.ph`-style mock preview (mirror the storefront look),
  - upload button (reuse the `product-thumb.tsx` file-input UX: `accept="image/jpeg,image/png,image/webp"`),
  - remove button (when an image is set).
- **Live link:** none. A "Виж сайта" button was considered (per-tenant `settings.siteUrl`) but dropped — the platform provisions each storefront (slug in super-admin + `PAZAR_TENANT_SLUG` GitHub var) and owns its public URL; the owner doesn't need it in-panel. The admin needs no storefront URL.
- **API client:** add helpers in `client/src/lib/api-client.ts`:
  - `getSiteMedia()` → `GET tenants/me/media`
  - `uploadSiteMedia(slotKey, file)` → `POST tenants/me/media/:slotKey` (FormData `image`)
  - `deleteSiteMedia(slotKey)` → `DELETE tenants/me/media/:slotKey`
- Requests go through the existing `/bff/[...path]` proxy (cookie → Bearer). No client-side token handling.

## Storefront (Пазар Чайка, Astro) — reusable wrapper

New `src/components/MediaSlot.astro`:

```astro
---
interface Props {
  slot: string;
  media?: Record<string, { url?: string }>;
  ratio: string;          // e.g. "16/10"
  label: string;
  rounded?: boolean;
  klass?: string;         // extra classes e.g. "wide", "tall"
}
const { slot, media, ratio, label, rounded = false, klass = '' } = Astro.props;
const url = media?.[slot]?.url;
const cls = `ph ${rounded ? 'ph--rounded' : ''} ${klass}`.trim();
---
<div class={cls} style={`aspect-ratio:${ratio}`}>
  {url
    ? <img src={url} alt={label} loading="lazy"
        style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" />
    : <span class="ph__label">{label}</span>}
</div>
```

Replace each **static** `.ph` placeholder with `<MediaSlot slot=… media={boot.media} ratio=… label=… />`:
- `src/pages/index.astro`: line 50 (`home.hero` 4/5 rounded), line 66 (`site.pillar_market` 16/10), line 79 (`site.pillar_delivery` 16/10). Leave line 187 (Google Maps) untouched.
- `src/pages/orders.astro`: line 27 (`site.pillar_market`), line 41 (`site.pillar_delivery`), line 89 (`orders.box` 4/3 rounded).
- `src/pages/about.astro`: line 24 (`about.portrait` 4/5 rounded), lines 58–64 (`about.gallery_*`, preserving `wide`/`tall` classes).

`boot.media` flows from the bootstrap `storefront.media` field via `src/lib/api.ts`. Untouched: ProductCard, FarmerCard, Gallery, Ghost cards, review avatars, contact map, 404 emoji.

## Files touched (summary)

**Backend**
- `packages/types/src/index.ts` — `PublicStorefront.media`, slot/catalog types.
- `server/src/modules/tenants/tenants.controller.ts` — media GET/POST/DELETE routes.
- `server/src/modules/tenants/tenants.service.ts` — media read/write, catalog resolve, cache invalidation; surface `media` on `getMe`/public.
- `server/src/modules/tenants/media-slots.catalog.ts` (new) — theme-keyed catalog constant + lookup.
- `server/src/common/cache/public-cache.service.ts` — add `media` to cached `TenantMeta`.
- (bootstrap builder already composes `storefront` from tenant — verify `media` propagates.)

**Admin (client)**
- `client/src/components/layout/sidebar.tsx` — nav item.
- `client/src/app/(admin)/site-media/page.tsx` + client component (new).
- `client/src/lib/api-client.ts` — three helpers.

**Storefront (fermerski-pazar-chaika)**
- `src/components/MediaSlot.astro` (new).
- `src/pages/index.astro`, `src/pages/orders.astro`, `src/pages/about.astro` — swap static `.ph` for `<MediaSlot>`.
- `src/lib/api.ts` — ensure `media` is read from bootstrap onto `boot.media`.

## Error handling

- Unknown slot key → 400.
- File type/size → existing `ParseFilePipe` validators (jpeg/png/webp, 5 MB).
- R2 stub mode (dev, no R2 config) → upload returns fake URL; behavior matches existing media uploads.
- Delete of a non-existent slot → idempotent `{ ok: true }`.
- Storefront: any missing/empty slot → `.ph` mock (graceful, never broken image).

## Reusability for future sites

A new storefront site adopts the feature by:
1. Adding a catalog entry `catalog[<theme>] = SlotDef[]` on the backend and setting the tenant's `settings.siteTheme`.
2. Dropping the `MediaSlot` component (Astro or a React port) into the site and swapping its static placeholders.
The admin panel and backend endpoints require no per-site changes.

## Out of scope

- Next.js storefront (FarmFlow/storefront) wiring.
- Cropping/resizing/optimization beyond what R2 + `object-fit:cover` provide.
- Reordering or adding/removing slots from the admin (catalog is code-defined).
- Per-slot alt-text editing (label used as alt).
