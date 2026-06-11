# Curated Home Reviews Block

- **Date:** 2026-06-11
- **Branch:** `feat/cod-payment-method` (chaika: `feat/cod-payment-choice`)
- **Status:** Approved design → ready for plan

## Summary

Add a fourth, curated block to the storefront-home landing builder: **reviews**.
The farmer turns the block on and hand-picks specific reviews (from their own
farm's *published* reviews) to showcase on the home page. The picked reviews
render on the chaika home in the order they were picked.

Builds directly on the landing-blocks feature
(`docs/.../2026-06-11-configurable-landing-blocks-design.md`): same
`settings.landing` jsonb, same admin „Начална страница" card, same chaika home.

## Scope

**In scope**
- New `settings.landing.reviews` block: `{ show: boolean, ids: string[] }`.
- Picker in the admin „Начална страница" card (a 4th row): toggle + checkbox
  list of the farm's published reviews.
- Bootstrap delivers the resolved picked reviews (`homeReviews`).
- chaika home renders a reviews block from `homeReviews`.

**Out of scope**
- Cross-tenant / shared review library (reviews stay tenant-scoped).
- Reordering picks via drag (order = pick order; YAGNI).
- Touching the `/reviews` page (still shows all published + average).
- A rating average on the home block.
- The unrelated reviews WIP already in the tree (`reviews.controller.ts`,
  `review-list-query.dto.ts`) — left untouched.

## Locked decisions

1. Picker lists **published reviews only** → a pick always renders publicly (no
   leaking `pending`/`hidden`). The home block also re-filters to `published`
   server-side as a guard.
2. Block default **OFF** (`show:false`, `ids:[]`) → existing home unchanged
   until the farmer opts in.
3. Max **12** picks.
4. Home renders picks **in pick order**; no average on the home block.

## Data model

Extend `settings.landing` (jsonb, no migration). The three existing blocks keep
`{show, count}`; the new block uses explicit ids instead of a count:

```jsonc
{
  "landing": {
    "categories": { "show": true,  "count": 0 },
    "farmers":    { "show": true,  "count": 3 },
    "latest":     { "show": true,  "count": 4 },
    "reviews":    { "show": false, "ids": [] }
  }
}
```

### Resolution + clamp (in `resolveLanding`)

- `reviews.show` → coerced boolean, default `false`.
- `reviews.ids` → array of strings only; drop non-strings; dedupe (keep first
  occurrence order); cap to first **12**. Default `[]`.
- Missing/garbage `reviews` → `{ show:false, ids:[] }`.

`PublicLanding` gains `reviews: { show: boolean; ids: string[] }`;
`DEFAULT_LANDING.reviews = { show:false, ids:[] }`.

## Backend changes

### `landing.ts`
- Add `reviews` to `PublicLanding`, `DEFAULT_LANDING`, and `resolveLanding`
  (a dedicated `resolveReviewsBlock(raw)` since the shape differs from
  `resolveBlock`).

### `landing.dto.ts`
- Add to `LandingDto`:
  ```ts
  @IsOptional() @ValidateNested() @Type(() => LandingReviewsDto)
  reviews?: LandingReviewsDto;
  ```
  with `LandingReviewsDto { show?: boolean; ids?: string[] }` —
  `@IsArray @ArrayMaxSize(12) @IsUUID('all', { each: true })` on `ids`.

### Reviews service — picked-reviews resolution
- `server/src/modules/reviews/home-reviews.ts` (new, pure): `orderReviewsByIds(ids, rows)`
  → returns `rows` filtered to those whose id is in `ids`, ordered by `ids`
  index. Unit-testable (mirrors `product-of-week.ts`).
- `ReviewsService.findHomeReviews(slug): Promise<PublicReview[]>`:
  1. `resolveTenant(slug)` → `meta.landing.reviews`.
  2. If `!show` or `ids.length === 0` → return `[]`.
  3. Query reviews `WHERE tenantId = meta.id AND status='published' AND
     id = ANY(ids)` (drizzle `inArray`), select the `PublicReview` columns.
  4. Return `orderReviewsByIds(ids, rows)` mapped to `PublicReview`
     (`createdAt` → ISO string), reusing the existing `PublicReview` shape.
  - No dedicated Redis cache (≤12 rows by PK; landing PATCH already busts the
    tenant meta the ids come from).

### Bootstrap
- `public-bootstrap.controller.ts`: add `this.reviews.findHomeReviews(slug)` to
  the `Promise.all`, return `homeReviews` in the payload.
- `public-bootstrap.module.ts`: import `ReviewsModule`; inject `ReviewsService`.
- `ReviewsModule` must export `ReviewsService` (verify; add `exports` if absent).

## Admin changes

`client/src/components/settings/landing-card.tsx`
- Extend `LandingConfig` (api-client) with `reviews: { show: boolean; ids: string[] }`.
- Add a 4th row **„Отзиви"** below the existing three:
  - a show `ToggleSwitch` (`reviews.show`),
  - when on, a scrollable list of the farm's published reviews — each row a
    checkbox + `★ rating` + author + a one-line body snippet. Checking adds the
    id to `reviews.ids` (append → preserves pick order); unchecking removes it.
    Disable further checks at 12 (show a hint).
  - empty state when the farm has no published reviews: a note „Няма публикувани
    отзиви за избор." (link/hint to the Reviews page to publish some).
- Load the published reviews via the existing `listReviews('published')`
  (`api-client.ts`) alongside `getLanding`/`getTenant` in the card's effect.
- Save unchanged: `updateLanding(cfg)` (now carrying `reviews`).

## chaika changes

`src/lib/types.ts`
- `Bootstrap.homeReviews?: Review[]` (reuse the existing `Review` type).
- `Storefront.landing.reviews?: { show: boolean; ids: string[] }` (for type
  completeness; the home reads `homeReviews`, not ids).

`src/lib/api.ts`
- `getCatalog`: seed/pass `homeReviews` through; default `[]` on the
  older-backend fallback path.

`src/pages/index.astro`
- `const homeReviews = boot.homeReviews ?? [];`
- Insert a reviews `<section>` (after the FEATURED block, before HOW-IT-WORKS),
  gated `L.reviews.show && homeReviews.length > 0`, rendering the existing
  `review-card` grid (`grid grid--3`): stars + `„{body}”` + `.who` author block.

## Testing

- **Backend unit:**
  - `resolveLanding`: reviews default `{show:false,ids:[]}`; dedupe; cap 12;
    drop non-strings; garbage → default. (extend `landing.spec.ts`)
  - `orderReviewsByIds`: filters to ids, preserves pick order, drops unknown ids,
    ignores rows not in ids. (new `home-reviews.spec.ts`)
  - `LandingDto`: rejects `ids` with >12 entries / non-uuid.
- **Regression:** full server suite green (currently 240 + new).
- **Live E2E (real stack):** pick 2 reviews + enable block in admin → bootstrap
  `homeReviews` returns them in order → chaika home renders 2 review cards;
  toggle off → block gone; verify published-only (a pending review id isn't
  rendered even if forced into ids).

## Edge cases

- `show:true` but `ids:[]` → block hidden (`homeReviews` empty).
- A picked review later hidden/deleted → drops from `homeReviews` (status/PK
  filter); pick id may linger in config harmlessly until next save.
- Stale/non-owned id in `ids` → filtered out by the tenant+status+id query.
- Farm has 0 published reviews → picker shows the empty state; block can be
  toggled on but renders nothing until reviews exist.

## Files touched

**Backend**
- `server/src/modules/tenants/landing.ts` — reviews block in resolver
- `server/src/modules/tenants/landing.spec.ts` — reviews cases
- `server/src/modules/tenants/dto/landing.dto.ts` — `LandingReviewsDto`
- `server/src/modules/reviews/home-reviews.ts` + `.spec.ts` — pure ordering
- `server/src/modules/reviews/reviews.service.ts` — `findHomeReviews`
- `server/src/modules/reviews/reviews.module.ts` — export `ReviewsService` (if needed)
- `server/src/modules/public-bootstrap/public-bootstrap.controller.ts` — `homeReviews`
- `server/src/modules/public-bootstrap/public-bootstrap.module.ts` — import `ReviewsModule`

**Admin**
- `client/src/lib/api-client.ts` — `LandingConfig.reviews`
- `client/src/components/settings/landing-card.tsx` — „Отзиви" row + picker

**chaika**
- `src/lib/types.ts` — `Bootstrap.homeReviews`, `Storefront.landing.reviews`
- `src/lib/api.ts` — pass `homeReviews`
- `src/pages/index.astro` — reviews block
