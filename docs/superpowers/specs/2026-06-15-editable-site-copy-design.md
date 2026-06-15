# Editable Site Copy — „Промени сайта" with Снимки + Текстове tabs

**Date:** 2026-06-15
**Status:** Design — approved pending user spec review

## Goal

Make the storefront more self-service. Rename the admin „Снимки на сайта" screen to
**„Промени сайта"** and split it into two top tabs:

1. **Снимки** — the existing editable photo grid, unchanged.
2. **Текстове** — new. Edit the body copy of the storefront (everything between the
   header and the footer) without touching code.

Header and footer are explicitly out of scope.

## Scope (v1)

- **Curated text blocks** (not literally every word) — modeled exactly on the existing
  media-slot system. Each meaningful piece of copy (eyebrow, heading, lead paragraph,
  value-card title/body, CTA label) is a named slot.
- Pages covered: **Начало (index), За нас (about), Поръчки (orders), Контакти (contact),
  FAQ (faq)**.
- **FAQ Q&A** is a repeating list (add / remove / reorder / edit each `{q, a}`), edited in
  its own block inside the Текстове tab.
- One **„Запази промените"** button in the Текстове tab → a single atomic write.
- **Not duplicated** (already editable elsewhere, left as-is): contact address / hours /
  tagline / socials / map pin (`settings.contact`), website icon + theme color
  (`settings.brand`), landing block toggles (`settings.landing`), product/farmer/subcat
  content. Header/footer text untouched.

## Approach

Chosen mechanism: **text slots = mirror of the existing media-slot system** (generic
`settings.<map>[key]` + a catalog contract + drop-in storefront wrapper). Same proven,
low-risk pattern as „Снимки на сайта"; consistent code and mental model.

Rejected: one freeform JSON blob per page (no labels → bad UX, easy to break layout);
full rich-text CMS (overkill — articles already cover rich text; YAGNI).

## Data model

`tenants.settings` jsonb gains two leaves (no migration — jsonb):

- `settings.copy` — `Record<string, string>` — slot key → override text. A missing key
  means "use the storefront's built-in default". Empty string = treated as missing
  (cleared / reset to default).
- `settings.faq` — `Array<{ q: string; a: string }>` — full replacement of the FAQ list.
  Missing / empty array → storefront falls back to its built-in `DEFAULT_FAQ`.

## Server

**Catalog** — `server/src/modules/tenants/copy-slots.catalog.ts` (mirrors
`media-slots.catalog.ts`):

```ts
export interface CopySlotDef {
  key: string;        // e.g. "home.hero.title". Stable; also the storefront lookup key.
  label: string;      // Bulgarian admin label.
  page: string;       // Group heading: "Начало" | "За нас" | "Поръчки" | "Контакти" | "FAQ".
  default: string;    // Current storefront text — admin placeholder + reference.
  multiline?: boolean; // true → textarea + pre-line rendering; default false → single line.
}
```

- One catalog per `settings.siteTheme` (`pazar` is the only theme today; unknown →
  default), reusing `getMediaCatalog`'s resolution shape.
- `CopySlotDef.default` values are extracted verbatim from the current chaika markup during
  implementation so the admin shows the live text as placeholder. The storefront keeps its
  own inline fallback too (see below) — defaults are duplicated intentionally so each side
  is safe alone.
- Slot inventory (built during implementation by reading each page): roughly per-page
  section-head pairs (eyebrow + heading + optional lead) plus value-card title/body pairs.
  Approx counts — Начало ~25, За нас ~12, Поръчки ~14, Контакти ~6, FAQ heading ~3. Exact
  list finalized against the source files.
- `isValidCopySlot(theme, key)` guard (mirrors `isValidSlot`).

**Service** — in `tenants.service.ts`:

- `getSiteCopy(tenantId)` → `{ catalog: CopySlotDef[]; copy: Record<string,string>; faq: {q,a}[] }`.
- `setSiteCopy(tenantId, dto)` — accepts `{ copy, faq }`:
  - `copy`: drop keys not in the catalog, trim values, delete empty → store the cleaned map.
  - `faq`: trim each `{q,a}`, drop entries where both are empty, cap count/length.
  - Single atomic `jsonb_set` write of both leaves (race-safe vs sibling settings writes,
    same pattern as `updateSiteContact` building one `settings` SQL expression).
  - Bust public cache after write (same call as media writes).

**Controller** — in `tenants.controller.ts` (`@Roles('admin')`, owner-only like media):

- `GET tenants/me/site-copy` → `getSiteCopy`.
- `PATCH tenants/me/site-copy` (body `SiteCopyDto`) → `setSiteCopy`.

**DTO** — `dto/site-copy.dto.ts`:

```ts
class FaqItemDto { @IsString() @MaxLength(200) q: string; @IsString() @MaxLength(2000) a: string; }
class SiteCopyDto {
  @IsObject() copy: Record<string, string>;            // validated against catalog server-side
  @ValidateNested({ each: true }) @Type(() => FaqItemDto) @ArrayMaxSize(50) faq: FaqItemDto[];
}
```

(Note the global `forbidNonWhitelisted` + `@ValidateNested` gotcha from the newsletter work —
nested array DTOs must declare `@Type`.)

**Public projection** — `public-cache.service.ts` (and the parallel `getMe`/storefront
profile derivation): add `copy: Record<string,string>` and `faq: {q,a}[]` to the storefront
profile, derived from `settings.copy` / `settings.faq`, so a warm storefront render needs no
extra read. Empty/missing → `{}` / `[]`.

## Storefront (chaika)

**`CopySlot.astro`** — new component (mirrors `MediaSlot.astro`):

```astro
interface Props { slot: string; copy?: Record<string,string> | null; fallback: string; multiline?: boolean; as?: string; }
// renders override `copy[slot]` if non-empty, else `fallback`; multiline → white-space:pre-line
```

Usage replaces hardcoded body strings on the 4+1 pages, e.g.:

```astro
<h1><CopySlot slot="home.hero.title" copy={sf.copy} fallback="Свежа храна директно от фермерите" /></h1>
```

The `fallback` is the current literal text → **zero visual change before any edit**, and
safe on an older backend that doesn't send `copy` yet.

**FAQ** — `faq.astro`: keep the current array as `DEFAULT_FAQ`; use
`const FAQ = sf.faq?.length ? sf.faq : DEFAULT_FAQ;`. No other markup change.

Header/footer components are not touched.

## Admin client

- Rename screen: **route stays `/site-media`** (no folder rename — avoids breaking any
  bookmarks/links and keeps the diff small). Only the *display* changes: sidebar label,
  topbar `PAGE_TITLES`, and H1 all become **„Промени сайта"** (the 3-site naming-sync
  gotcha — also update `/help` + `help-content.ts` + `admin-panel-guide.md`).
- The page renders a **tab switcher** at the top: `Снимки` | `Текстове`.
  - `Снимки` tab: the current `SlotCard` grid, extracted into a `MediaTab` component
    (behavior unchanged).
  - `Текстове` tab: new `CopyTab` component.
- `CopyTab`:
  - `GET /me/site-copy` on load. Local form state for `copy` map + `faq` array.
  - Grouped by `page` (catalog order). Each slot → labeled input (single-line) or textarea
    (`multiline`), placeholder = catalog `default`. „Върни оригинала" link per field clears
    it (→ empty → default shows live).
  - FAQ page-group renders a list editor: each item = q input + a textarea, add / remove /
    move up-down buttons.
  - One „Запази промените" button → single `PATCH /me/site-copy` with `{ copy, faq }`;
    toast on success/failure; dirty-tracking so the button is disabled when unchanged.
- `api-client.ts`: `getSiteCopy`, `updateSiteCopy`, types `SiteCopySlotDef`, `SiteCopyData`.

## Error handling

- Server validation drops unknown copy keys and oversized/empty entries silently (cleaned,
  not 400) except DTO-level type/length violations which 400.
- Storefront always has an inline fallback → never renders blank; old backend (no `copy`
  field) → all fallbacks, no errors.
- Atomic single-write avoids partial save (copy saved but faq lost, or vice-versa).

## Testing

- **Server unit:** `getSiteCopy` returns catalog+values; `setSiteCopy` drops unknown keys,
  trims, deletes empty, caps faq; cache bust called; cross-tenant isolation (a tenant can't
  write another's copy). Public projection includes `copy`/`faq`.
- **Builds:** db/types dist, server build, client tsc + prod build, chaika `astro build`.
- **Live E2E:** edit a slot + add an FAQ item in admin → save → confirm storefront renders
  the override and the new FAQ entry; clear a slot → confirm fallback returns.

## Out of scope / follow-ups

- Editing header/footer text.
- Rich text / formatting in body slots (plain text + line breaks only).
- Per-locale copy (single language today).
- Reordering the catalog slots from the UI (catalog order is code-defined).
