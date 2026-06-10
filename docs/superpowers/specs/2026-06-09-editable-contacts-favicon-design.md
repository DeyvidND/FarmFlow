# Editable Contacts + Website Icon (per-tenant)

**Date:** 2026-06-09
**Branch:** feat/cod-payment-method (continue) — or a new branch off it
**Status:** Approved design, pending implementation plan

## Goal

Let each tenant (farmer) edit their storefront contact details and website icon
from the admin, instead of those values being hardcoded in the chaika "Пазар"
storefront. Mirrors the existing **site-photos / `settings.media`** feature
end-to-end (admin page → tenant settings jsonb → public API + cache → chaika
consumer).

Currently hardcoded in `fermerski-pazar-chaika/src/lib/site.ts` and component
markup: market address, market/working hours, footer brand tagline, social
links (FB/IG/TikTok placeholders), contact-page Google-Map coordinates, the
static `/favicon.svg`, and the static `theme-color` meta.

## Non-goals

- Next.js storefront (`storefront/`) does **not** consume these fields. Same
  scope decision as site-media: chaika only.
- No DB migration. `tenants.settings` is untyped jsonb; we add sub-keys.
- Phone and email stay live tenant columns (already surfaced on the public API);
  not duplicated into `settings.contact`.

## Data model — `tenants.settings` jsonb (no migration)

Two new sub-keys. Split so favicon writes never clobber the text form.

```ts
settings.contact = {
  address?: string;          // market / pickup location text
  hours?: string;            // working hours text, e.g. "Всеки петък · 11:00–18:00"
  tagline?: string;          // footer brand paragraph
  social?: Array<{ label: string; url: string }>;  // arbitrary list, max 8
  mapLat?: string;           // numeric string
  mapLng?: string;           // numeric string
}

settings.brand = {
  faviconUrl?: string;       // R2 public URL
  faviconKey?: string;       // R2 object key (for replace/delete)
  themeColor?: string;       // hex "#RRGGBB"
}
```

All writes use per-path `jsonb_set(coalesce(settings,'{}'), path, value, true)`
(create-missing = true), exactly like `tenants.service.setSiteMedia`, so sibling
keys survive concurrent writes.

## 1. Server — `tenants` module

New endpoints on `tenants.controller.ts`, mirroring the `me/media` trio.
Auth: `@CurrentTenant()` (same guard as media).

| Method & route | Body / params | Action |
|---|---|---|
| `GET tenants/me/site-contact` | — | Read `settings.contact` + `settings.brand`; return `{ contact, favicon: { url } \| null, themeColor }` |
| `PATCH tenants/me/site-contact` | `SiteContactDto` | Validate, then atomically write `{contact}` (whole object) + `jsonb_set {brand,themeColor}` |
| `POST tenants/me/favicon` | multipart `image` | Validate png/ico, upload R2, set `{brand,faviconUrl}` + `{brand,faviconKey}`, delete old object best-effort |
| `DELETE tenants/me/favicon` | — | Remove R2 object best-effort, clear `{brand,faviconUrl}`+`{brand,faviconKey}` |

Every write → `publicCache.del(publicCacheKeys.tenant(slug))`.

### `SiteContactDto` (class-validator)

- `address?` string, `@MaxLength(200)`
- `hours?` string, `@MaxLength(120)`
- `tagline?` string, `@MaxLength(400)`
- `social?` array, `@ArrayMaxSize(8)`, each item `{ label: string @MaxLength(40),
  url: string @IsUrl({ require_protocol: true }) }` (nested `@ValidateNested` +
  `@Type`)
- `mapLat?`, `mapLng?` string matching a decimal regex (or `@IsLatitude` /
  `@IsLongitude` on the parsed number); empty allowed
- `themeColor?` string matching `^#[0-9a-fA-F]{6}$`

### Favicon upload validation (security)

Favicons are limited to **PNG and ICO** — both byte-verifiable, neither can
execute script. SVG is intentionally rejected: it can embed `<script>`, and
`magic-mime` can't byte-sniff it cleanly. (We surfaced png/ico as the safe
option during design; chosen.)

- New shared regex e.g. `FAVICON_MIME_REGEX = /^image\/(png|x-icon|vnd\.microsoft\.icon)$/`
  and a small size cap (`FAVICON_MAX_BYTES`, ~512 KB) in
  `storage/dto/upload-image.dto.ts` (alongside `PRODUCT_IMAGE_*`).
- Controller uses `ParseFilePipe` with `FileTypeValidator` + `MaxFileSizeValidator`,
  same shape as `uploadMedia`.
- Extend `storage/magic-mime.ts` `sniffMime` to detect **ICO** (`00 00 01 00`)
  and return `image/x-icon`; PNG already detected. Then call
  `assertContentMatchesMime(file.buffer, file.mimetype)` in the service before
  upload, so a spoofed `Content-Type` is rejected.
- R2 key: `tenants/{tenantId}/site/favicon/{uuid}.{ext}` (ext from sniffed mime:
  `png`/`ico`), `cacheControl` like other site uploads.

### Service methods (`tenants.service.ts`)

Mirror the media methods:

- `getSiteContact(tenantId)` → load settings, return
  `{ contact: settings.contact ?? {}, favicon: settings.brand?.faviconUrl ? { url } : null, themeColor: settings.brand?.themeColor ?? null }`.
- `updateSiteContact(tenantId, dto)` → normalize (trim, drop empty social rows),
  write `{contact}` whole-object via `jsonb_set`, write `{brand,themeColor}` via
  `jsonb_set` (or omit when undefined). Bust cache. Return the new
  `{ contact, themeColor }`.
- `setFavicon(tenantId, file)` → `assertContentMatchesMime`, R2 upload, set
  `{brand,faviconUrl}` + `{brand,faviconKey}`, delete previous key best-effort,
  bust cache, return `{ url }`.
- `deleteFavicon(tenantId)` → idempotent; remove R2 object + clear keys, bust
  cache, return `{ ok: true }`.

## 2. Public API + cache

Extend the public storefront shape and the cached `TenantMeta`.

`PublicStorefront` (`tenants.service.ts`) gains:

```ts
contact: {
  address: string | null;
  hours: string | null;
  tagline: string | null;
  social: Array<{ label: string; url: string }>;
  mapLat: string | null;
  mapLng: string | null;
};
faviconUrl: string | null;
themeColor: string | null;
```

`PublicCacheService.resolveTenant` (`common/cache/public-cache.service.ts`)
derives these from `settingsObj.contact` / `settingsObj.brand` and stores them on
`TenantMeta`; the public `/public/:slug` and `/public/:slug/bootstrap` responses
serialize them. Defensive coding: coerce missing/garbage to nulls / `[]`, cap
`social` length, only emit social rows with a non-empty `url`.

Cache invalidation already happens on every write (above).

## 3. Admin UI (`client/`)

New dedicated nav page. Route + folder: `(admin)/contacts/page.tsx`, href
`/contacts`. Title **„Контакти"**.

### Nav registration

Add to `components/layout/sidebar.tsx` `NAV_GROUPS`, in the **„Маркетинг"**
group next to `site-media`:

```ts
{ href: '/contacts', label: 'Контакти', Icon: Contact, // lucide-react
  desc: 'Контактна информация, социални мрежи, локация и иконка на сайта.' }
```

Hideable-nav already keys off `href`, so the new item is automatically
hide/show-able — no extra work.

### API client (`lib/api-client.ts`)

```ts
export interface SiteContact {
  address: string; hours: string; tagline: string;
  social: { label: string; url: string }[];
  mapLat: string; mapLng: string;
}
export interface SiteContactResponse {
  contact: SiteContact;
  favicon: { url: string } | null;
  themeColor: string | null;
}
getSiteContact()            // GET  tenants/me/site-contact
updateSiteContact(payload)  // PATCH tenants/me/site-contact  (json)
uploadFavicon(file)         // POST tenants/me/favicon        (FormData 'image')
deleteFavicon()             // DELETE tenants/me/favicon
```

### Page layout — mirror `site-media/page.tsx` conventions

Container `max-w-[1100px]`, header (title + description), `sonner` toasts,
`Button`/`Card` UI primitives, per-control `busy` state. Cards:

1. **Контакти** — text inputs: address, hours, tagline (textarea).
2. **Социални мрежи** — dynamic rows `{label, url}`, add / remove, capped at 8.
3. **Локация на картата** — `LocationPicker` (below) writing `mapLat`/`mapLng`;
   plain numeric inputs as the no-maps-key fallback.
4. **Иконка на сайта** — favicon upload (preview tile like a `SlotCard`,
   `accept="image/png,image/x-icon"`) + Remove + `<input type="color">` for
   theme color.

One **„Запази"** button → `updateSiteContact` (address/hours/tagline/social/map/
themeColor). Favicon upload + delete call their own endpoints immediately, like
site-media (optimistic local state update + toast).

### `LocationPicker` component (new, small)

`client/src/components/maps/location-picker.tsx`, using the existing
`@vis.gl/react-google-maps` pattern (see `components/route/route-map.tsx`):

```ts
interface LocationPickerProps {
  lat: number | null; lng: number | null;
  onPick: (lat: number, lng: number) => void;
}
```

`APIProvider apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}` → `Map`
(`onClick` → `onPick(detail.latLng)`) with an `AdvancedMarker` at the current
point. Graceful fallback: when the key is empty, render nothing (the numeric
inputs in card 3 still work), matching the project's stub-when-empty maps
convention.

## 4. Chaika storefront (`fermerski-pazar-chaika`)

Consumption only; keep `site.ts` constants as fallbacks when the API value is
empty (preserves reviewable design + offline fallback).

- **`src/lib/types.ts`** — extend `Storefront` with `contact?`, `faviconUrl?`,
  `themeColor?` (mirroring server shape; all optional).
- **`src/components/Footer.astro`** — address/hours/tagline/social from
  `storefront.contact.*` with `?? ADDRESS/MARKET_HOURS/BRAND_TAG/SOCIALS`
  fallbacks. The inline hardcoded footer paragraph becomes `tagline`.
- **`src/pages/contact.astro`** — same contact fields; map uses
  `contact.mapLat/mapLng` when both present, else current hardcoded coords.
- **Social icon resolution** — helper that maps a social row to an existing
  `Icon` name by URL hostname (facebook→fb, instagram→ig, tiktok→tt,
  youtube→yt, viber→phone) and falls back to a generic link/globe icon for
  unknown hosts (since the list is now arbitrary).
- **`src/components/Layout.astro`** — `<link rel="icon" href={storefront.faviconUrl
  ?? '/favicon.svg'}>` (drop `type=image/svg+xml` when a png/ico URL is used; set
  `type` from extension or omit) and `theme-color = storefront.themeColor ?? '#3F7D43'`.

## 5. Testing

Server unit specs mirroring `tenants.service.spec` / site-media tests:

- `updateSiteContact`: whole-object `contact` write, `themeColor` path write,
  social normalization (drops empty rows, enforces cap), DTO validation
  rejections (bad url, oversized list, bad hex), cache busted.
- favicon: `setFavicon` happy path (R2 key shape, brand merge preserves
  themeColor, previous object deleted on replace), `magic-mime` rejects a
  png-mime payload whose bytes are not PNG/ICO, `deleteFavicon` idempotent +
  clears keys, cache busted.
- public exposure: `resolveTenant` / `PublicStorefront` includes `contact`,
  `faviconUrl`, `themeColor`, with garbage-in → safe nulls/`[]`.
- `sniffMime` unit: ICO signature → `image/x-icon`.

Chaika is presentation — no new tests (matches site-media precedent).

## File touch list

**server/**
- `modules/tenants/tenants.controller.ts` (+4 routes)
- `modules/tenants/tenants.service.ts` (+4 methods, PublicStorefront shape)
- `modules/tenants/dto/site-contact.dto.ts` (new)
- `modules/storage/dto/upload-image.dto.ts` (FAVICON_MIME_REGEX, FAVICON_MAX_BYTES)
- `modules/storage/magic-mime.ts` (ICO sniff)
- `common/cache/public-cache.service.ts` (TenantMeta + derivation)
- specs: `tenants.service.spec.ts` (extend), `magic-mime.spec.ts` (extend)

**client/**
- `app/(admin)/contacts/page.tsx` (new)
- `components/maps/location-picker.tsx` (new)
- `lib/api-client.ts` (+4 helpers, types)
- `components/layout/sidebar.tsx` (nav entry)

**fermerski-pazar-chaika/** (separate repo)
- `src/lib/types.ts`, `src/components/Footer.astro`, `src/pages/contact.astro`,
  `src/components/Layout.astro`, social-icon helper (new or in `site.ts`)

## Open confirmations

- Favicon formats locked to **PNG + ICO** (SVG rejected for security).
- Branch: continue on `feat/cod-payment-method` vs a fresh branch — decide at
  plan time.
