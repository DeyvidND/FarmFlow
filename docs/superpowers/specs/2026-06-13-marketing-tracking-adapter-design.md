# Marketing / Tracking Adapter — Design

**Date:** 2026-06-13
**Status:** Approved design, pending implementation plan
**Author:** DNDonchev (with Claude)

## Problem

Marketers connecting a farm's storefront to ad/analytics platforms today need a
developer to paste vendor-provided tracking snippets into the site by hand
(per the Telegram exchange that triggered this work: "програмистите на сайта
вкарват кода който гугъл даде в сайта"). Every farm, every platform, every
re-issue is manual developer work.

The insight that makes this automatable: the "code Google/Meta gives" is a
fixed template. The only per-farm variable is an **ID** (e.g. GA4 `G-XXXX`,
Google Ads `AW-XXXX`, Meta Pixel numeric id, GTM `GTM-XXXX`, TikTok pixel id).
So we never fetch or store vendor code. We template the loader once, the farmer
pastes only their IDs in the admin panel, and the storefront injects the right
scripts automatically. The developer disappears from the loop.

## Goal

A self-service "Маркетинг / Проследяване" section in the admin panel where a
farmer (or their marketer) pastes tracking IDs. The chaika storefront then:

1. Loads the correct vendor scripts for every non-empty ID.
2. Respects GDPR via a cookie-consent banner (Google Consent Mode v2 +
   Meta consent gating).
3. Fires a purchase conversion on the order-confirmation page.

Out of scope (explicitly deferred — separate tasks if ever needed):

- OAuth auto-connect to Google/Meta (auto-create properties, pull IDs). Heavy
  app-verification cost, and the conversion tag still has to live on-site, so it
  buys little over paste-the-ID.
- GTM dataLayer enhanced-ecommerce (item-level impressions, add-to-cart, etc.).
  We fire a single `purchase` only.
- Per-vendor granular consent toggles. One analytics+marketing consent bucket.

## Architecture

Two repos are touched:

- **FarmFlow** (`server/` backend + `client/` Next admin) — store and edit IDs.
- **fermerski-pazar-chaika** (Astro storefront) — inject scripts, consent, purchase event.

The storefront is **chaika only** (no Next public storefront exists; the Next
app is the admin panel). Confirmed with user.

### 1. Backend — `settings.marketing` jsonb leaf

Mirror the existing `settings.contact` pattern in
[`site-contact.ts`](../../../server/src/modules/tenants/site-contact.ts).

New file `server/src/modules/tenants/site-marketing.ts`:

```ts
export interface PublicMarketing {
  ga4: string | null;        // G-XXXXXXX
  googleAds: string | null;  // AW-XXXXXXXXX
  metaPixel: string | null;  // 15-16 digit numeric
  gtm: string | null;        // GTM-XXXXXXX
  tiktok: string | null;     // alphanumeric pixel id
}

// Per-vendor format validation. A value that fails its regex is dropped to null
// rather than stored — a typo can never emit a broken <script> on the storefront.
const PATTERNS = {
  ga4:       /^G-[A-Z0-9]{6,12}$/i,
  googleAds: /^AW-[0-9]{8,12}$/i,
  metaPixel: /^[0-9]{10,20}$/,
  gtm:       /^GTM-[A-Z0-9]{4,10}$/i,
  tiktok:    /^[A-Z0-9]{15,30}$/i,
};

export function buildPublicMarketing(raw: unknown): PublicMarketing { /* trim + regex-validate each, garbage → nulls */ }
export function normalizeMarketing(dto: SiteMarketingDto): Record<string, unknown> { /* trim + validate, store only valid */ }
```

- `server/src/modules/tenants/dto/site-marketing.dto.ts` — 5 optional string
  fields, `@IsString` + `@MaxLength`. Whitelist-validated like other tenant DTOs.
- **Controller** ([`tenants.controller.ts`](../../../server/src/modules/tenants/tenants.controller.ts)):
  `@Get('me/site-marketing')` + `@Patch('me/site-marketing')` mirroring the
  `me/site-contact` pair (lines 80–90).
- **Service** ([`tenants.service.ts`](../../../server/src/modules/tenants/tenants.service.ts)):
  `getMarketing(tenantId)` and `updateMarketing(tenantId, dto)`, using
  `jsonb_set(coalesce(settings,'{}'), array['marketing'], …)` exactly like
  `updateContact`/`updateLanding`. Full-replace semantics.
- **Public projection:** add `marketing: buildPublicMarketing(settings.marketing)`
  to the `PublicStorefront` shape (next to `contact`, `faviconUrl`, `themeColor`)
  so it ships on `GET /public/:slug` and in `/bootstrap`.
- **Cache:** bust the tenant public cache on PATCH, the same way `updateContact`
  does (the storefront public cache is keyed per resource).

### 2. Admin — "Маркетинг / Проследяване" card

- New route `client/src/app/(admin)/marketing-tracking/page.tsx` (or fold into an
  existing Marketing-group screen — decide in plan), with a card holding 5 labeled
  inputs (GA4, Google Ads, Meta Pixel, GTM, TikTok), each with a short helper line
  telling the user where to find that ID. "Готово" → PATCH `/me/site-marketing`.
- Wire into the Marketing nav group in
  [`sidebar.tsx`](../../../client/src/components/layout/sidebar.tsx) +
  [`topbar.tsx`](../../../client/src/components/layout/topbar.tsx) PAGE_TITLES + the
  panel H1. **Gotcha (from memory):** the screen name lives in 3 drifting sites —
  NAV_GROUPS, topbar PAGE_TITLES, panel H1 — plus `/help` + `help-content.ts` +
  `admin-panel-guide.md`. Sync all.
- Client-side mirror of the per-vendor format hint (soft warning on malformed
  paste), but the backend is the source of truth on validation.

### 3. chaika — script injection + consent

- **Types:** `Storefront` in
  [`types.ts`](../../../../fermerski-pazar-chaika/src/lib/types.ts) gains
  `marketing?: { ga4: string|null; googleAds: string|null; metaPixel: string|null; gtm: string|null; tiktok: string|null }`.
  `FALLBACK_STOREFRONT` in
  [`api.ts`](../../../../fermerski-pazar-chaika/src/lib/api.ts) gains an all-null
  `marketing`.
- **`src/components/TrackingScripts.astro`** — given `storefront.marketing`,
  emits loader `<script>`s only for non-empty IDs:
  - GA4 + Google Ads share one `gtag.js` load (single config block per id).
  - Meta Pixel standard `fbq` init snippet.
  - GTM container snippet.
  - TikTok pixel snippet.
  - **Consent Mode v2:** before any gtag config, emit the default-denied consent
    block (`ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`
    = `denied`). For Meta, call `fbq('consent', 'revoke')` until granted.
  Rendered in [`Layout.astro`](../../../../fermerski-pazar-chaika/src/components/Layout.astro)
  `<head>` (the single site-wide layout). All IDs pass through `safeHref`-style
  validation already enforced server-side; double-check no raw interpolation
  enables script breakout (IDs are alphanumeric-only after backend regex).
- **`src/components/ConsentBanner.astro`** + small inline script:
  - Buttons "Приемам" / "Отказвам". Choice persisted in `localStorage`
    (`ff_consent` = `granted` | `denied`).
  - On load: if no stored choice, show banner. If `granted`, fire
    `gtag('consent','update', {all granted})` + `fbq('consent','grant')`.
  - On "Приемам": store `granted`, update consent, hide banner.
  - On "Отказвам": store `denied`, hide banner (tags stay in denied/modeling mode).
  - Necessary cookies (cart/session) are never gated.

### 4. Purchase conversion — `confirmation-page.ts`

[`confirmation-page.ts`](../../../../fermerski-pazar-chaika/src/scripts/confirmation-page.ts)
already reads `ff_last_order` from sessionStorage (`{ orderId, items[], total, method, slot }`).
After the existing recap render, fire a purchase conversion **only when consent is
granted and the relevant ID exists**:

- GA4: `gtag('event','purchase', { transaction_id, value, currency:'EUR', items })`
  (storefront prices are euro — see the лв→€ switch; `total` is already euro.)
- Google Ads: `gtag('event','conversion', { send_to: 'AW-XXX/label', value, transaction_id })`
  — note the conversion **label** is part of the snippet Google gives; if we want
  Ads purchase conversions we must also store a `googleAdsConversionLabel` field
  (decide in plan: add a 6th field, or keep base-tag-only for Ads and rely on GA4
  import). **Open implementation detail flagged for the plan.**
- Meta: `fbq('track','Purchase', { value, currency:'EUR' })`

Guard against double-fire on reload (clear `ff_last_order` or set a fired flag),
since the cart is already cleared here.

### 5. Testing

- **Backend (jest):** `site-marketing.spec.ts` mirroring `site-contact.spec.ts` —
  `buildPublicMarketing` with null/garbage/valid/malformed inputs (regex drop),
  `normalizeMarketing` trim + drop. Controller/service covered by existing e2e
  pattern if present.
- **chaika:** manual / E2E — (a) malformed-but-stored ID never reaches head
  (backend guarantees), (b) empty marketing → zero tracking scripts emitted,
  (c) consent denied → no cookies set / consent signals denied, (d) accept →
  consent granted + tags active, (e) purchase event fires once on confirmation
  with correct value.

## Data flow

```
Admin paste ID → PATCH /me/site-marketing → normalizeMarketing (validate)
  → jsonb_set settings.marketing → cache bust
GET /public/:slug (or /bootstrap) → buildPublicMarketing → Storefront.marketing
  → chaika Layout <head> TrackingScripts (consent-default-denied)
  → ConsentBanner (accept → consent granted)
  → confirmation-page.ts (purchase event, if granted + id)
```

## Files touched (summary)

**FarmFlow:**
- `server/src/modules/tenants/site-marketing.ts` (new)
- `server/src/modules/tenants/site-marketing.spec.ts` (new)
- `server/src/modules/tenants/dto/site-marketing.dto.ts` (new)
- `server/src/modules/tenants/tenants.controller.ts` (edit)
- `server/src/modules/tenants/tenants.service.ts` (edit: get/update/projection/cache-bust)
- `client/src/app/(admin)/marketing-tracking/page.tsx` (new)
- `client/src/components/layout/sidebar.tsx`, `topbar.tsx` (edit)
- `client/src/...help-content.ts`, `docs/.../admin-panel-guide.md`, `/help` (sync)

**fermerski-pazar-chaika:**
- `src/lib/types.ts`, `src/lib/api.ts` (edit: type + fallback)
- `src/components/TrackingScripts.astro` (new)
- `src/components/ConsentBanner.astro` (new)
- `src/components/Layout.astro` (edit: render both in head/body)
- `src/scripts/confirmation-page.ts` (edit: purchase event)

## Open detail for the plan

Google Ads purchase conversion needs a conversion **label** (`AW-XXX/abc123`),
not just the `AW-XXX` id. Decide: add a `googleAdsConversionLabel` field (6th
input), or ship base Ads tag only and route purchase conversions via GA4→Ads
import. Recommendation: add the label field — it's the same paste-once cost and
makes Ads conversions work end-to-end.
