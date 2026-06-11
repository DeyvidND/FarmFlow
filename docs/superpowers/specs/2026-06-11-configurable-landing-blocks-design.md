# Configurable Landing Blocks

- **Date:** 2026-06-11
- **Branch:** `feat/cod-payment-method`
- **Status:** Approved design → ready for plan

## Summary

Let each tenant control which of the three *dynamic* blocks on the storefront
home page appear, and how many items each shows. The three blocks are:

1. **Categories** ("Какво ще намериш")
2. **Farmers** ("Запознай се с фермерите")
3. **Latest offers** ("Най-актуални предложения")

Config is stored per-tenant in `tenants.settings.landing` (jsonb — no
migration), surfaced through the existing cached public profile, edited from a
new Settings card in the admin panel, and consumed by the chaika (Astro)
storefront home.

## Scope

**In scope**

- Show/hide toggle per block (fixed top-to-bottom order — no reordering).
- Per-block item count.
- New admin Settings section „Начална страница" with a `LandingCard`.
- Backend storage + public-profile surfacing + cache busting.
- chaika `index.astro` consumption.

**Out of scope** (confirmed with user)

- Reordering blocks.
- Toggling the static blocks (hero, two-ways-to-shop pillars, how-it-works,
  map/location, trust, newsletter) — they stay fixed.
- Product-of-week — keeps its own existing toggle on the Products page
  (`product-of-week-panel.tsx`). Not folded into this card.
- Any Next.js storefront — none exists; `client/` is admin-only. chaika is the
  only render target.

## Data model

New jsonb block under `tenants.settings`:

```jsonc
{
  "landing": {
    "categories": { "show": true, "count": 0 },  // count 0 = Всички (all)
    "farmers":    { "show": true, "count": 3 },
    "latest":     { "show": true, "count": 4 }
  }
}
```

### Resolution + defaults (back-compat)

`settings.landing` is resolved with per-block defaults that **equal today's
hardcoded behavior**, so an existing tenant with no saved config renders
identically until they edit the card:

| Block      | default `show` | default `count` | count meaning            |
|------------|----------------|-----------------|--------------------------|
| categories | `true`         | `0`             | `0` = all; else first N  |
| farmers    | `true`         | `3`             | first N                  |
| latest     | `true`         | `4`             | first N                  |

### Clamping (server-side, defensive)

- `show` → coerced boolean (default per table on missing/invalid).
- `categories.count` → integer clamped to `0..12` (`0` = all).
- `farmers.count` / `latest.count` → integer clamped to `1..12`. (Hiding is the
  toggle's job, so the minimum is 1, not 0.)
- Non-integer / `NaN` / missing → block default.
- Partial config (e.g. only `categories` saved) → other blocks fall back to
  their defaults per-block.

## Backend changes

### Public profile surfacing

`server/src/common/cache/public-cache.service.ts`

- Add to `TenantMeta`:
  ```ts
  interface LandingBlock { show: boolean; count: number }
  interface PublicLanding {
    categories: LandingBlock;
    farmers: LandingBlock;
    latest: LandingBlock;
  }
  // …
  landing: PublicLanding;
  ```
- In `resolveTenant`, read `settingsObj.landing`, apply the defaults + clamp
  rules above into `meta.landing`. Rides the existing Redis cache (already keyed
  by slug, already busted on tenant writes).

`server/src/modules/tenants/tenants.service.ts`

- Add `landing: PublicLanding` to the `PublicStorefront` interface (it spreads
  the resolved meta, so the value flows through automatically once the meta
  carries it).

### Read + write endpoints

Mirror the existing `site-contact` endpoint pair
(`tenants.controller.ts:79`, `tenants.service.ts` `getSiteContact` /
`updateSiteContact`).

- `GET /tenants/me/landing` → `{ landing: PublicLanding }` (resolved + clamped,
  for the admin editor to hydrate).
- `PATCH /tenants/me/landing` → body `LandingDto`, returns saved `PublicLanding`.
  - Atomic write: `jsonb_set(coalesce(settings,'{}'::jsonb), array['landing'],
    $json::jsonb, true)` so it never clobbers sibling settings (delivery, media,
    contact, brand).
  - Re-clamp the incoming DTO before persisting.
  - Bust `publicCacheKeys.tenant(slug)` after the write (need the tenant's slug
    — select it or use `returning`).

`server/src/modules/tenants/dto/landing.dto.ts` (new)

- Nested DTO: three optional block objects, each with optional `show`
  (`@IsBoolean`) and `count` (`@IsInt @Min(0) @Max(12)`), `@ValidateNested` +
  `@Type`. Service-side clamp is the authority; DTO just rejects gross abuse.

## Admin changes

`client/src/app/(admin)/settings/page.tsx`

- Add a third section to `SECTIONS`: `{ id: 'landing', label: 'Начална страница' }`
  and render `<LandingCard />` when selected.

`client/src/components/settings/landing-card.tsx` (new)

- Mirrors `nav-visibility-card` structure (load → local state → dirty tracking →
  Save with saving/saved feedback).
- Loads current config via `GET /tenants/me/landing`.
- Three rows — Категории / Фермери / Най-актуални — each with:
  - an on/off toggle (`show`),
  - a number stepper for `count` (Категории offers „Всички" = 0 plus 1–12;
    Фермери / Най-актуални offer 1–12).
- Farmers row: when the tenant is **not** in multi-farmer mode, disable the row
  and show a hint „Само при мулти-фермер режим" (read `multiFarmer` from the
  admin profile, same source the panel already uses).
- Save → `PATCH /tenants/me/landing`.

## Storefront (chaika) changes

`src/lib/api.ts`

- Add `landing: PublicLanding` to the `Storefront` type and to the
  `DEMO_STOREFRONT` fallback object (defaults matching the table above) so demo
  mode and older-backend fallback stay safe.

`src/pages/index.astro`

Replace the three existing conditionals (currently `index.astro:133` categories,
`:151` farmers, `:171` featured) with config-gated versions:

```astro
const L = sf.landing;
const catList   = L.categories.count > 0 ? cats.slice(0, L.categories.count) : cats;
const farmerList = farmers.slice(0, L.farmers.count);
const featList   = featured(products, L.latest.count);
```

| Block      | render gate                                          | items        |
|------------|------------------------------------------------------|--------------|
| categories | `L.categories.show && cats.length > 0`               | `catList`    |
| farmers    | `L.farmers.show && showFarmers && farmers.length > 0` | `farmerList` |
| latest     | `L.latest.show && seeded`                            | `featList`   |

`showFarmers` (= `sf.multiFarmer`) stays ANDed into the farmers gate — multi-farmer
mode is still a hard prerequisite, matching the admin card's hint.

## Testing

- **Backend unit:**
  - `resolveTenant` returns the default landing block when `settings.landing` is
    absent (asserts back-compat: all cats / 3 farmers / 4 latest).
  - clamp: out-of-range counts (`-1`, `99`, `3.5`, `"x"`) → clamped/defaulted.
  - partial config merges per-block defaults.
  - `PATCH /tenants/me/landing` persists and busts the tenant cache key.
  - `LandingDto` rejects `count > 12`.
- **Regression:** full server suite stays green (currently 236).
- **Live E2E (manual):** in admin, toggle each block off/on and change each
  count; confirm chaika home reflects (block hidden / item count changes) after
  cache bust.

## Edge cases

- `farmers.show = true` but `multiFarmer = false` → block stays hidden (gate
  ANDs `multiFarmer`); admin card disables the row so the state can't be set
  misleadingly.
- `categories.count = 0` → all categories (preserves current live behavior).
- `farmers.count` / `latest.count` requested as `0` → clamped to `1` (use the
  toggle to hide).
- Empty data (no products / no farmers) → block hidden regardless of `show`
  (existing `cats.length` / `farmers.length` / `seeded` guards remain).

## Files touched

**Backend**
- `server/src/common/cache/public-cache.service.ts` — `TenantMeta` + resolve/clamp
- `server/src/modules/tenants/tenants.service.ts` — `PublicStorefront` type, `get/updateLanding`
- `server/src/modules/tenants/tenants.controller.ts` — `GET`/`PATCH /me/landing`
- `server/src/modules/tenants/dto/landing.dto.ts` — new

**Admin**
- `client/src/app/(admin)/settings/page.tsx` — section entry
- `client/src/components/settings/landing-card.tsx` — new
- admin API client — `getLanding` / `updateLanding` helpers (match existing style)

**Chaika** (`fermerski-pazar-chaika`)
- `src/lib/api.ts` — `Storefront` type + `DEMO_STOREFRONT`
- `src/pages/index.astro` — three gated blocks
