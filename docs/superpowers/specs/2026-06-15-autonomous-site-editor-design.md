# Autonomous Unified Site Editor (v2) — manifest-driven „Промени сайта" with live preview

**Date:** 2026-06-15
**Status:** Design — approved pending user spec review
**Supersedes:** the v1 editable-site-copy work (hardcoded server catalogs + Снимки/Текстове tab split, shipped 2026-06-15 `b01e27c`). Slot **keys are preserved**, so existing tenant `settings.copy` / `settings.media` overrides keep working — no data migration.

## Goal

Make the storefront fully self-service and **autonomous**: a single „Промени сайта" editor where the farmer edits all body text **and** photos against a **live preview of their own site**, and where adding a new editable text, photo, or whole page to the storefront **automatically appears** in the panel — with no hand-maintained catalog.

Two driving requirements from the user:
1. **Unify** text + photos into one section-structured editor (drop the two tabs).
2. **Autonomous / extendable**: new text / photo / page in the storefront → reflected in the panel automatically. The hardcoded server catalogs must go; the storefront declares what is editable.

Plus a bug fix: the „Запази промените" sticky bar is translucent (`bg-ff-bg/80 backdrop-blur`) and shows content through it — make it opaque.

## Architecture shift

**Source of truth for *what is editable* moves from the server to the storefront.** The storefront declares a registry of editable slots (text + image), grouped by page → section, and serves it as a JSON manifest. The admin reads the manifest and renders the editor from it; the server only **stores** the per-tenant overrides and is otherwise slot-agnostic.

```
chaika registry (editable-manifest.ts)  ──build/serve──>  GET {siteUrl}/editable-manifest.json
        │ (CopySlot/MediaSlot read defaults+labels from it)                    │ (CORS: admin origin)
        ▼                                                                       ▼
   storefront renders                                              admin fetches manifest
   (override-or-default)                                           renders unified editor + drives iframe
                                                                              │
                                          PATCH/upload overrides ──> FarmFlow API ──> settings.{copy,media,faq,siteUrl}
                                                                    (key-pattern validated, slot-agnostic)
```

Net: the storefront is the single source of truth for slot definitions; the API is a dumb key→value store for overrides; the admin is a thin renderer of the manifest + a preview driver.

## Components

### A. chaika — slot registry (single source of truth)

`src/lib/editable-manifest.ts`:

```ts
export interface TextSlot  { kind: 'text';  key: string; label: string; default: string; multiline?: boolean }
export interface ImageSlot { kind: 'image'; key: string; label: string; ratio: string; rounded?: boolean; note?: string }
export type Slot = TextSlot | ImageSlot;
export interface Section { id: string; label: string; slots: Slot[] }   // id e.g. "home.hero"
export interface Page    { route: string; label: string; sections: Section[]; faq?: boolean }  // route "/","/about",…
export interface EditableManifest { theme: string; pages: Page[] }
export const MANIFEST: EditableManifest = { theme: 'pazar', pages: [ /* … */ ] };

/** Flat lookup for the components. */
export const SLOTS: Record<string, Slot> = /* derived from MANIFEST at module load */;
```

- The registry is **relocated** from the existing server catalogs: every `default` (82 copy slots) + every media def (12 image slots) moves here, reshaped into the page→section tree, **keeping the exact same `key`s** and the same Bulgarian defaults/labels.
- Section ids = the slot-key prefix already in use (`home.hero`, `home.location`, `orders.steps`, `about.values`, …). Routes: `/`,`/about`,`/orders`,`/contact`,`/faq`. The `/faq` page sets `faq: true` (it has the special FAQ-list editor; the FAQ list itself is `settings.faq`, not a slot).

### B. chaika — registry-driven components + anchors

- `CopySlot.astro`: prop becomes just `slot` + `copy`. Looks up `SLOTS[slot]` for `default`/`multiline`. Renders `data-editable-slot={slot}`. (No inline `fallback`/`multiline` props.) When the key is missing from the registry it renders nothing + a dev `console.warn` (defensive).
- `MediaSlot.astro`: prop becomes just `slot` + `media` (+ `priority`/`klass` for layout that the registry can't know). Looks up `SLOTS[slot]` for `label`/`ratio`/`rounded`. Renders `data-editable-slot={slot}`.
- Each section's container element gets `data-copy-section="<section.id>"` so the preview can scroll/outline it. (Extends the v1 work, which only added these implicitly for copy.)
- The 82 copy usages drop their `fallback=` (now in registry); the 12 media usages drop `label`/`ratio` (now in registry). `{sf.name}` interpolations stay outside the components (as in v1).

### C. chaika — manifest endpoint + preview mode

- `src/pages/editable-manifest.json.ts` (Astro endpoint): `import { MANIFEST }` → `return new Response(JSON.stringify(MANIFEST), { headers: { 'content-type':'application/json', 'access-control-allow-origin': <PUBLIC_ADMIN_URL>, 'cache-control':'public, max-age=60' } })`. Public (labels/defaults only, no secrets). CORS limited to the configured admin origin.
- `src/middleware.ts`: when `?preview=1` **and** the configured `PUBLIC_ADMIN_URL` is set → set `Content-Security-Policy: frame-ancestors <admin-origin>`, **omit** `X-Frame-Options`, add `Cache-Control: no-store`. **All other requests keep `X-Frame-Options: DENY` + `frame-ancestors 'none'`.** Clickjacking surface limited to preview + admin origin.
- Preview listener (loaded only when `?preview=1`, e.g. a small inline script in `Layout.astro` gated by the flag): listens for `message`; **validates `event.origin === PUBLIC_ADMIN_URL`**; on `{type:'ff-preview-scroll', section}` → `document.querySelector('[data-copy-section="'+section+'"]')?.scrollIntoView({behavior:'smooth',block:'center'})` + a temporary outline class (~1.2s). Ignores all other origins/messages.

### D. FarmFlow server — slot-agnostic store

- **Delete** `copy-slots.catalog.ts` (+ spec) and `media-slots.catalog.ts` (+ spec). Remove `getCopyCatalog`/`copySlotKeys`/`getMediaCatalog`/`isValidSlot` usages.
- `site-copy.ts` `cleanCopy(raw)` — drop the theme/catalog arg; keep only keys matching `^[a-z0-9._-]{1,80}$`, trim, drop empty. `normalizeFaq` unchanged.
- New `settings.siteUrl` (string). `sanitizeSiteUrl(v)` — accept only `http://`/`https://` URLs (reject `javascript:`/`data:`/other schemes), trim, cap length; invalid/empty → `''`.
- `getSiteCopy(tenantId)` → `{ copy, media, faq, siteUrl }` (no `catalog`). `media` projected as the existing public `{key:{url}}` map.
- `setSiteCopy(tenantId, dto)` — dto `{ copy, faq, siteUrl }`; `cleanCopy` + `normalizeFaq` + `sanitizeSiteUrl`; atomic single `jsonb_set` of `copy`,`faq`,`siteUrl`; bust tenant cache.
- `setSiteMedia` / `deleteSiteMedia` — replace `isValidSlot` check with the key-pattern check (`^[a-z0-9._-]{1,80}$`). Upload/delete + R2 path logic unchanged. The **`GET me/media`** endpoint (catalog + values) is **retired** — its values now come from `getSiteCopy().media`; the `POST`/`DELETE me/media/:slotKey` (multipart upload / remove) **stay** (the unified editor's photo cards use them).
- `PublicStorefront` / `TenantMeta` keep `copy`/`faq`/`media`; add `siteUrl` is **not** needed publicly (admin-only) — keep `siteUrl` out of the public storefront projection (the storefront doesn't need its own URL). It lives in `settings.siteUrl`, surfaced only via `getSiteCopy`.
- `SiteCopyDto`: `{ @IsObject copy; @ValidateNested…@Type FaqItemDto faq; @IsOptional @IsString @MaxLength(300) siteUrl }`.

### E. admin — unified manifest-driven editor

- Screen stays at route `/site-media`, title „Промени сайта". **Tabs removed.**
- On load: `getSiteCopy()` → `{copy, media, faq, siteUrl}`; then fetch `${siteUrl}/editable-manifest.json` (client-side). Cache the manifest in `localStorage` keyed by siteUrl as a fallback when the storefront is unreachable. If `siteUrl` empty → render only the „Адрес на сайта" input + a hint; if manifest fetch fails → show error + „Опитай пак" + use cached manifest if present.
- Layout: **left** = editor tree (page → section; each section renders its slots in registry order — text → input/textarea (`multiline`), image → upload card like the current `SlotCard`; the `/faq` page also renders the FAQ list editor); **right** = sticky `<iframe src={siteUrl + '?preview=1'}>`. Responsive: on narrow screens the preview collapses behind a „Преглед" toggle.
- Preview driving: track the iframe's current route in React state. On text-field focus / image-card select: derive `route` = `{home:'/',about:'/about',orders:'/orders',contact:'/contact',faq:'/faq'}[key.split('.')[0]]` and `section` = `key.split('.').slice(0,2).join('.')`. If `route !== current` → set `iframe.src = siteUrl+route+'?preview=1'`, update state, and on its `load` postMessage the scroll; else postMessage `{type:'ff-preview-scroll', section}` immediately. `postMessage` target origin = the origin of `siteUrl` (validated; never `'*'`).
- Save: „Запази промените" → `updateSiteCopy({copy, faq, siteUrl})` (one PATCH). Photo upload/delete use the existing `uploadSiteMedia`/`deleteSiteMedia` immediately, then reload the iframe. After a text save, reload the iframe so the preview reflects saved copy.
- The „Адрес на сайта" input lives in the preview-pane header; saved with the main PATCH.
- Fix the sticky save bar: `bg-ff-bg/80 backdrop-blur` → opaque `bg-ff-surface` + top border + small shadow.
- `api-client.ts`: `getSiteCopy` return type → `{copy, media, faq, siteUrl}`; `updateSiteCopy({copy, faq, siteUrl})`; add a `getEditableManifest(siteUrl)` fetch helper + manifest TS types mirroring chaika's.

## Data flow (per edit)

1. Admin loads → `getSiteCopy` (overrides + siteUrl) + manifest (structure).
2. Farmer edits text / uploads photo; focusing a field scrolls the live preview to that section.
3. Save → API stores key→value (pattern-validated) → busts cache.
4. Preview reloads (`?preview=1`, `no-store`) → storefront SSR fetches fresh overrides → renders override-or-registry-default.

## Error handling

- `siteUrl` empty / invalid → editor shows the URL input + guidance; no iframe.
- Manifest unreachable → cached-manifest fallback or a retry prompt; never a blank screen with no explanation.
- Unknown slot keys in stored overrides → harmless (storefront renders only registry keys); the editor renders only manifest slots, so orphaned overrides are simply not shown (and can be ignored).
- postMessage from unexpected origin → ignored on both sides.
- Storefront down → preview shows the browser's normal failed-iframe; editor still usable for text/faq (save works without preview).

## Testing

- **Server unit:** `cleanCopy` pattern-keeps/drops (no catalog); `sanitizeSiteUrl` rejects non-http(s); `setSiteCopy` persists copy/faq/siteUrl atomically + busts cache; `setSiteMedia` accepts pattern-valid keys, rejects bad keys; `getSiteCopy` returns `{copy,media,faq,siteUrl}`; catalog files are gone (no dangling imports — build proves it).
- **chaika:** `astro build` green; manifest endpoint returns valid JSON with all pages/sections/slots; CopySlot/MediaSlot render override-or-registry-default (a quick unit/string check if feasible, else build + manual).
- **Admin:** `tsc` + `next build` green.
- **Live E2E:** set „Адрес на сайта" → editor renders sections from the live manifest → focus a text field → preview scrolls to + outlines the section → edit + save → preview reflects → upload a photo → preview reflects → add an FAQ item → save → `/faq` shows it. Set an invalid siteUrl → guarded. Confirm normal storefront traffic still `X-Frame-Options: DENY`.

## Migration / deploy

- **No DB migration** (`settings.siteUrl` is a new jsonb leaf; copy/media/faq already exist).
- **Slot keys unchanged** → existing tenant overrides remain valid.
- chaika auto-deploys (manifest endpoint, preview middleware, CORS, registry-driven components). FarmFlow needs a redeploy (catalog removal, `getSiteCopy` reshape, validation relax, `siteUrl`). Set `PUBLIC_ADMIN_URL` on chaika (used for CORS + preview framing + postMessage origin check) if not already.

## Out of scope (v1)

- Live-while-typing WYSIWYG (preview reflects saved state only).
- Farmer creating brand-new slots/pages from the panel (adding a slot is still a dev act in the chaika registry — that is the "autonomous" boundary: storefront-declared, not farmer-declared).
- Multiple themes' content (only `pazar` exists; the manifest is per-deploy, so a different template just ships its own registry).
- Reordering slots from the UI (registry order is authoritative).
