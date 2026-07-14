# Farmer profile — v1 new sections

**Date:** 2026-07-14
**Area:** `client` (`@fermeribg/web`) per-producer drawer `/farmers` + `server` (`@fermeribg/api`) farmers module + `packages/db`
**Status:** design approved, ready for implementation plan

## Goal

Add useful sections to the per-producer "farmer profile" drawer
(`client/src/components/farmers/farmer-panel.tsx`). The drawer currently holds:
identity (name/role/city/bio/phone/since), photos, marketplace legal + finance
overrides, Tier-2 branding, email, panel access, product picker.

This v1 slice adds four sections spanning three goals the operator wants
(operator tooling, richer public page, groundwork for farmer self-service):

1. **Вътрешни бележки** — private operator notes (operator-only).
2. **Попълненост на профила** — completeness meter (pure UI).
3. **„За фермата"** — long public story (richer storefront page).
4. **IBAN за изплащане** — payout account for marketplace settlement (operator-only).

Follow-up slices (separate specs, out of scope here): tags, per-producer stats
snapshot, document vault, per-farmer socials/video/certifications/map/seasonality,
and full farmer self-service editing with operator approval.

## Key constraints (verified against code)

- **New fields flow through one DTO.** `UpdateFarmerDto = PartialType(CreateFarmerDto)`
  and both `FarmersService.create`/`update` persist via `{ ...dto }` spread onto the
  `farmers` table. Adding a field to `CreateFarmerDto` + a matching schema column is
  sufficient for read + write; no per-field service wiring.
- **Public exposure is an explicit allow-list.** `FarmersService.findPublicBySlug`
  (`server/src/modules/farmers/farmers.service.ts`) uses an explicit `.select({ ... })`
  projection, **not** a row spread. A new column is invisible publicly until added to
  that projection. Precedent: `legal` is in the projection (public seller disclosure);
  `commissionRateBps`/`subscriptionFeeStotinki` are omitted **and** defensively stripped
  before the cache write.
- **Guard test exists.** `server/src/modules/farmers/farmers.public-fields.spec.ts`
  locks the public/private contract (finance stripped before cache; phone/email/legal
  survive). New fields get assertions here.
- **Farmer sub-account strip.** The controller strips finance fields for the `farmer`
  sub-account role in `findAll`. New operator-only fields get the same treatment so a
  future self-service login can't read them.
- **Migrations are hand-written** in `packages/db/drizzle/`. Next file `0105_...`,
  next journal `idx: 103`, tag = filename without `.sql`, `when` epoch-ms >
  `1784100000000`, `breakpoints: true`, **no idx gaps** (a gap silently breaks the
  migrator).

## Data model — separate columns (not one blob)

Three new nullable columns on `farmers`:

| Column | Type | Visibility | Backs |
|---|---|---|---|
| `internal_notes` | `text` | operator-only | Section 1 |
| `story` | `text` | **public** | Section 3 |
| `payout` | `jsonb .$type<{ iban?: string; holder?: string; bic?: string }>()` | operator-only | Section 4 |

Rejected alternative: one `profileExtras` jsonb blob. Mixing public `story` with
private `notes`/`payout` in one object fights the allow-list projection and risks a
leak. Separate columns keep the public/private boundary clean and cheap to reason about.

### Migration `0105_farmer_profile_extras.sql`

```sql
-- Farmer profile v1: operator notes (private), long public story, payout account.
-- Three additive nullable columns on farmers. story is PUBLIC (added to the public
-- projection in findPublicBySlug); internal_notes + payout are operator-only.
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "internal_notes" text;
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "story" text;
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "payout" jsonb;
```

Journal entry appended to `packages/db/drizzle/meta/_journal.json`:
`{ "idx": 103, "version": "7", "when": <epoch-ms > 1784100000000>, "tag": "0105_farmer_profile_extras", "breakpoints": true }`.

## Section 1 — Вътрешни бележки (operator-only, always shown)

- **Schema:** `internal_notes text`.
- **DTO:** `internalNotes?: string | null` — `@IsOptional() @IsString() @MaxLength(5000)`.
- **Client type:** `Farmer.internalNotes?: string | null`.
- **UI:** textarea card near the drawer bottom with private styling (distinct from the
  public fields). Label „Вътрешни бележки"; helper „Само за теб — не се показва на
  клиента." Shown for all tenants (single-farm and marketplace).
- **Save wiring:** include `internalNotes: notes.trim() || null` in the `save()` `data`.
- **Privacy (belt-and-suspenders):**
  - NOT added to the `findPublicBySlug` projection.
  - Added to the defensive destructure-strip before the public cache write.
  - Stripped for the `farmer` sub-account role in the controller (matching finance).
  - Guard spec asserts `internalNotes` is absent from public output.

## Section 2 — Попълненост на профила (pure UI, no backend)

- No schema, no DTO, no endpoint. New small client component (e.g.
  `client/src/components/farmers/completeness-meter.tsx`) rendered inside the drawer.
- **Computed from current form state** (so it updates live as the operator edits):
  - Always: снимка (`imageUrl`), описание (`bio`), „За фермата" (`story`),
    продукти (`checked.size > 0`), достъп до панела (`acc` defined).
  - Marketplace only (`multiFarmer`): легални данни (`legal` has a filled field),
    IBAN (`payout` has a filled field).
- **Render:** a progress bar (`filled / total` %) plus a ✓/○ checklist of the items.
  Marketplace tenants see 7 items, single-farm 5. Clicking a missing item scrolls to
  its section (small bonus; via refs already used for the invite deep-link).
- **Placement:** under the avatar preview card. Shown only for existing farmers
  (`!isNew`) — several inputs (photo, products, access) need a saved id first.

## Section 3 — „За фермата" (public long story)

- **Schema:** `story text`.
- **DTO:** `story?: string | null` — `@IsOptional() @IsString() @MaxLength(8000)`.
- **Client type:** `Farmer.story?: string | null`; add `story` to `PublicFarmer`.
- **UI:** textarea (~6 rows) placed right under „Кратко описание". Label „За фермата
  (дълъг разказ)"; helper „Показва се на страницата на фермера в магазина — историята,
  методът, ценностите." (bio stays the short one-liner shown in cards.)
- **Save wiring:** include `story: story.trim() || null` in `save()` `data`.
- **Public exposure:** ADD `story: farmers.story` to the `.select({ ... })` projection
  in `findPublicBySlug` (model on `legal`). Guard spec asserts `story` is present.
- **⚠️ chaika follow-up (separate repo, out of scope for this build):** the API now
  exposes `story`, but rendering it on the storefront farmer subpage is a change in the
  **chaika** Cloudflare Workers repo. Tracked as a follow-up task; the panel + API work
  here is what makes it possible.

## Section 4 — IBAN за изплащане (operator-only, marketplace-gated)

- **Schema:** `payout jsonb .$type<{ iban?: string; holder?: string; bic?: string }>()`.
- **DTO:** nested `PayoutDto` (new file `dto/payout.dto.ts`) wired like `LegalDto`:
  `@IsOptional() @ValidateNested() @Type(() => PayoutDto) payout?: PayoutDto | null`.
  - `iban?` — `@IsOptional() @IsString() @MaxLength(34)` + loose BG-IBAN format check
    (`@Matches(/^BG\d{2}[A-Z]{4}\d{6}[A-Z0-9]{8}$/i)`, still optional so blanks pass).
  - `holder?` — `@IsOptional() @IsString() @MaxLength(200)`.
  - `bic?` — `@IsOptional() @IsString() @MaxLength(11)`.
- **Client type:** `Farmer.payout?: { iban?: string; holder?: string; bic?: string } | null`.
- **UI:** card gated behind `multiFarmer` (like commission/legal — payout only matters
  on marketplace tenants). Fields: IBAN, Титуляр, BIC (по избор). Label „IBAN за
  изплащане"; helper „За превод на оборота към фермера. Не се показва публично."
- **Save wiring:** build `payoutParts` from trimmed fields; send the object only if at
  least one field is non-empty, else `null` (identical shape to the existing
  `legalParts` logic in `save()`).
- **Privacy:** same as Section 1 — omitted from the projection, added to the defensive
  strip, stripped for the `farmer` sub-account role, guard spec asserts absent.
- **Scope:** capture-only. No payout *execution* — this feeds future settlement/payout
  reporting (parallels the dormant vendor-finance ledger).

## Files touched

- `packages/db/src/schema.ts` — +3 columns on `farmers`.
- `packages/db/drizzle/0105_farmer_profile_extras.sql` — new migration.
- `packages/db/drizzle/meta/_journal.json` — append idx 103.
- `server/src/modules/farmers/dto/create-farmer.dto.ts` — +`internalNotes`, +`story`,
  +`payout` (with new `PayoutDto`).
- `server/src/modules/farmers/dto/payout.dto.ts` — new nested DTO.
- `server/src/modules/farmers/farmers.service.ts` — add `story` to the public
  projection; add `internalNotes`/`payout` to the defensive strip.
- `server/src/modules/farmers/farmers.controller.ts` — strip `internalNotes`/`payout`
  for the `farmer` sub-account role (where finance fields are already stripped).
- `server/src/modules/farmers/farmers.public-fields.spec.ts` — assert `story` present,
  `internalNotes`/`payout` absent (and stripped before cache write).
- `client/src/lib/types.ts` — `Farmer` (+3 fields) and `PublicFarmer` (+`story`).
- `client/src/components/farmers/farmer-panel.tsx` — 4 UI sections + state + save wiring.
- `client/src/components/farmers/completeness-meter.tsx` — new small component.

## Non-goals / follow-ups

- chaika render of `story` (separate repo).
- Payout execution / settlement UI (capture-only for now).
- Tags, stats snapshot, document vault, socials/video/certifications/map/seasonality.
- Farmer self-service editing + operator approval.
