# Farmer Profile v1 Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four sections to the per-producer farmer drawer — internal notes (private), completeness meter (UI), „За фермата" long public story, and IBAN payout (private) — with the correct public/private exposure boundary.

**Architecture:** Three additive nullable columns on `farmers` (`internal_notes text`, `story text`, `payout jsonb`). Fields ride the existing `CreateFarmerDto` → `PartialType(Update)` → `farmers.service` `{ ...dto }` spread, so no per-field service wiring. `story` is added to the explicit public projection in `findPublicBySlug`; `internal_notes`/`payout` are kept out of it and belt-and-suspenders stripped. Client drawer gains four sections; the completeness meter is a pure-function component.

**Tech Stack:** NestJS + class-validator + Drizzle (Postgres) on the server, Next.js + React + Tailwind on the client, Jest on both.

## Global Constraints

- **Migrations are hand-written** in `packages/db/drizzle/` (NOT `migrations/`). Next file `0105_farmer_profile_extras.sql`; next journal entry `idx: 103`, `tag` = filename without `.sql`, `version: "7"`, `when` epoch-ms `> 1784100000000`, `breakpoints: true`. **No `idx` gaps** or the migrator silently breaks.
- **Public/private contract:** `story` is PUBLIC (storefront farmer subpage). `internal_notes` and `payout` are OPERATOR-ONLY — never in the public projection, never reachable by the `farmer` sub-account role.
- **DTO gotcha:** `@IsOptional()` does NOT turn `''` into `undefined`. Optional string fields the client may send empty must be guarded (client sends `undefined` for blanks via the `*Parts` pattern; `payout.iban` also gets `@Transform('' → undefined)`).
- **Client talks to the backend through the BFF** (`/bff/...`), never the API origin.
- **Bulgarian UI copy is verbatim** — copy the exact strings in this plan; don't paraphrase.
- **Mobile matters** (panel used at 375px). Preview screenshots can time out — measure the DOM if so.
- **Tenant-scope every query** — no change here touches the scoping, keep it that way.

---

### Task 1: DB columns + migration

**Files:**
- Modify: `packages/db/src/schema.ts` (the `farmers` table, ~lines 1095-1183 — add 3 columns after the `legal` jsonb)
- Create: `packages/db/drizzle/0105_farmer_profile_extras.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (append idx 103)

**Interfaces:**
- Produces: three nullable columns on `farmers` — `internalNotes: text`, `story: text`, `payout: jsonb<{ iban?: string; holder?: string; bic?: string }>`. Because `Farmer = InferSelectModel<typeof farmers>` in `@fermeribg/types`, the server `Farmer` type gains these automatically.

- [ ] **Step 1: Add the columns to the schema**

In `packages/db/src/schema.ts`, inside the `farmers` `pgTable`, immediately after the `legal: jsonb('legal')...` column, add:

```ts
  // Farmer profile v1 (migration 0105). internalNotes + payout are OPERATOR-ONLY
  // (never in the public projection); story IS public (added to findPublicBySlug).
  internalNotes: text('internal_notes'),
  story: text('story'),
  payout: jsonb('payout').$type<{ iban?: string; holder?: string; bic?: string }>(),
```

- [ ] **Step 2: Write the migration file**

Create `packages/db/drizzle/0105_farmer_profile_extras.sql`:

```sql
-- Farmer profile v1: operator notes (private), long public story, payout account.
-- Three additive nullable columns on farmers. story is PUBLIC (added to the public
-- projection in findPublicBySlug); internal_notes + payout are operator-only.
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "internal_notes" text;
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "story" text;
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "payout" jsonb;
```

- [ ] **Step 3: Append the journal entry**

In `packages/db/drizzle/meta/_journal.json`, append this object as the LAST element of the `entries` array (add a comma after the current last entry, the one with `"tag": "0104_sms_reminder"`):

```json
    {
      "idx": 103,
      "version": "7",
      "when": 1784200000000,
      "tag": "0105_farmer_profile_extras",
      "breakpoints": true
    }
```

- [ ] **Step 4: Verify the package type-checks (Farmer type picks up the columns)**

Run: `pnpm --filter @fermeribg/db build`
Expected: PASS (tsc clean). This confirms the schema compiles and `@fermeribg/types` `Farmer` now includes `internalNotes`/`story`/`payout`.

- [ ] **Step 5: Apply the migration to the dev DB**

Prereq: dev Postgres up (`docker compose up -d`, port 5433).
Run: `pnpm db:migrate`
Expected: migration `0105_farmer_profile_extras` applies with no error; re-running is idempotent (`IF NOT EXISTS`). If the migrator throws about a journal gap, re-check Step 3 (idx must be 103, no gaps).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0105_farmer_profile_extras.sql packages/db/drizzle/meta/_journal.json
git commit -m "feat(db): add farmers internal_notes, story, payout columns (0105)"
```

---

### Task 2: Server DTOs — PayoutDto + 3 fields on CreateFarmerDto

**Files:**
- Create: `server/src/modules/farmers/dto/payout.dto.ts`
- Modify: `server/src/modules/farmers/dto/create-farmer.dto.ts`
- Test: `server/src/modules/farmers/dto/create-farmer.dto.spec.ts` (create)

**Interfaces:**
- Consumes: `farmers.payout` jsonb shape from Task 1.
- Produces: `CreateFarmerDto` (and thus `UpdateFarmerDto = PartialType(CreateFarmerDto)`) accept `story?: string | null`, `internalNotes?: string | null`, `payout?: PayoutDto | null`. `PayoutDto` = `{ iban?: string; holder?: string; bic?: string }`.

- [ ] **Step 1: Write the failing DTO validation test**

Create `server/src/modules/farmers/dto/create-farmer.dto.spec.ts`:

```ts
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateFarmerDto } from './create-farmer.dto';

describe('CreateFarmerDto — profile v1 fields', () => {
  it('accepts story, internalNotes and a valid payout', async () => {
    const dto = plainToInstance(CreateFarmerDto, {
      name: 'Петър',
      story: 'Дълъг разказ за фермата…',
      internalNotes: 'обажда се преди доставка',
      payout: { iban: 'BG80BNBG96611020345678', holder: 'Петър Петров' },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a malformed IBAN', async () => {
    const dto = plainToInstance(CreateFarmerDto, {
      name: 'Петър',
      payout: { iban: 'NOT-AN-IBAN' },
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- create-farmer.dto`
Expected: FAIL — `CreateFarmerDto` has no `story`/`internalNotes`/`payout`, so the valid case may pass trivially but the malformed-IBAN case does NOT error (no such field yet) → `errors.length).toBeGreaterThan(0)` fails.

- [ ] **Step 3: Create PayoutDto**

Create `server/src/modules/farmers/dto/payout.dto.ts`:

```ts
import { IsString, IsOptional, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Payout account for marketplace settlement — where the farmer's turnover is
 * transferred. Reaches the row through Create/UpdateFarmerDto → farmers.service
 * `.set({ ...dto })` → the `farmers.payout` jsonb column. OPERATOR-ONLY: never
 * added to the public farmer projection (unlike `legal`). Capture-only for now —
 * no payout execution. Every field is optional so it can be filled gradually.
 */
export class PayoutDto {
  @ApiPropertyOptional({ example: 'BG80BNBG96611020345678', description: 'IBAN за изплащане на оборота.' })
  @IsOptional()
  // Empty string → undefined so a blank field doesn't trip @Matches (the '' gotcha).
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsString()
  @MaxLength(34)
  // Loose BG-IBAN shape (BGkk BANK dddddd cccccccc = 22 chars); still optional so blanks pass.
  @Matches(/^BG\d{2}[A-Z]{4}\d{6}[A-Z0-9]{8}$/i, { message: 'Невалиден IBAN (очаква се български IBAN).' })
  iban?: string;

  @ApiPropertyOptional({ example: 'Петър Петров', description: 'Титуляр на сметката.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  holder?: string;

  @ApiPropertyOptional({ example: 'BNBGBGSF', description: 'BIC/SWIFT (по избор).' })
  @IsOptional()
  @IsString()
  @MaxLength(11)
  bic?: string;
}
```

- [ ] **Step 4: Add the three fields to CreateFarmerDto**

In `server/src/modules/farmers/dto/create-farmer.dto.ts`, add the import at the top (next to the `LegalDto` import):

```ts
import { PayoutDto } from './payout.dto';
```

Then add these three properties at the end of the class (after `subscriptionFeeStotinki`):

```ts
  // Farmer profile v1 (migration 0105).
  // „За фермата" — long PUBLIC story shown on the storefront farmer subpage (bio is
  // the short card one-liner). Added to the public projection in findPublicBySlug.
  @ApiPropertyOptional({ description: 'Дълъг публичен разказ „За фермата".' })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  story?: string | null;

  // OPERATOR-ONLY private notes about this producer — never public.
  @ApiPropertyOptional({ description: 'Вътрешни бележки (само за оператора).' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  internalNotes?: string | null;

  // OPERATOR-ONLY payout account for marketplace settlement — never public.
  @ApiPropertyOptional({ type: PayoutDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PayoutDto)
  payout?: PayoutDto | null;
```

(`ValidateNested` and `Type` are already imported in this file.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- create-farmer.dto`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/farmers/dto/payout.dto.ts server/src/modules/farmers/dto/create-farmer.dto.ts server/src/modules/farmers/dto/create-farmer.dto.spec.ts
git commit -m "feat(farmers): accept story, internalNotes, payout on farmer DTO"
```

---

### Task 3: Public projection — expose story, strip notes/payout, update PublicFarmer + guard spec

**Files:**
- Modify: `packages/types/src/index.ts` (`PublicFarmer` Omit, ~line 205-212)
- Modify: `server/src/modules/farmers/farmers.service.ts` (`findPublicBySlug`, projection ~line 490-513 and strip ~line 529-539)
- Test: `server/src/modules/farmers/farmers.public-fields.spec.ts` (modify)

**Interfaces:**
- Consumes: `farmers.story` / `farmers.internalNotes` / `farmers.payout` from Task 1.
- Produces: `PublicFarmer` includes `story` and excludes `internalNotes`/`payout`; `findPublicBySlug` output contains `story`, never `internalNotes`/`payout`.

- [ ] **Step 1: Extend the guard spec (failing test first)**

In `server/src/modules/farmers/farmers.public-fields.spec.ts`, in the first test (`'strips vendor-finance fields...'`), update the `row` literal to include the three new columns:

```ts
    const row = {
      id: 'f1', tenantId: TENANT, name: 'Васил', role: 'Ягодоплодни', bio: null,
      phone: '0888', email: 'v@x.bg', since: '2023', tint: null, imageUrl: null,
      coverCrop: null, legal, story: 'Дълъг разказ', position: 0, createdAt: new Date(),
      commissionRateBps: 500, subscriptionFeeStotinki: 1200,
      internalNotes: 'таен коментар', payout: { iban: 'BG80BNBG96611020345678', holder: 'Васил' },
    };
```

Then, inside the `for (const f of out)` loop (after the `legal` assertion), add:

```ts
      // „За фермата" public story survives the projection
      expect(f).toHaveProperty('story', 'Дълъг разказ');
      // operator-only fields must be stripped
      expect(f).not.toHaveProperty('internalNotes');
      expect(f).not.toHaveProperty('payout');
```

And inside the cached-shape loop (`for (const f of cached)`), add:

```ts
      expect(f).not.toHaveProperty('internalNotes');
      expect(f).not.toHaveProperty('payout');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- farmers.public-fields`
Expected: FAIL — current code does not strip `internalNotes`/`payout`, so the `not.toHaveProperty` assertions fail (the mock row now carries them through `...rest`).

- [ ] **Step 3: Add `story` to the public projection**

In `farmers.service.ts` `findPublicBySlug`, inside the `.select({ ... })` object, add `story` right after the `legal: farmers.legal,` line:

```ts
        legal: farmers.legal,
        // „За фермата" — long public story. Operator-only notes/payout are NOT selected here.
        story: farmers.story,
```

- [ ] **Step 4: Add `internalNotes`/`payout` to the defensive strip**

In the same method, extend the destructure that strips owner-only fields (the `const { tenantId: _tenantId, ... } = row as typeof row & {...}` block) to also pull off `internalNotes` and `payout`:

```ts
      const {
        tenantId: _tenantId,
        commissionRateBps: _commissionRateBps,
        subscriptionFeeStotinki: _subscriptionFeeStotinki,
        internalNotes: _internalNotes,
        payout: _payout,
        ...rest
      } = row as typeof row & {
        tenantId?: string | null;
        commissionRateBps?: number | null;
        subscriptionFeeStotinki?: number | null;
        internalNotes?: string | null;
        payout?: unknown;
      };
```

- [ ] **Step 5: Update the PublicFarmer type**

In `packages/types/src/index.ts`, extend the `PublicFarmer` Omit list to also exclude the two private fields (leave `story` in — it must remain public):

```ts
export type PublicFarmer = Omit<
  Farmer,
  'tenantId' | 'commissionRateBps' | 'subscriptionFeeStotinki' | 'lat' | 'lng' | 'geocodedAt'
  | 'internalNotes' | 'payout'
> & {
  images: string[];
  /** Phase 2: farmer offers nationwide courier (≥1 carrier connected). */
  courierReady: boolean;
};
```

- [ ] **Step 6: Run the test + typecheck**

Run: `pnpm --filter @fermeribg/api test -- farmers.public-fields`
Expected: PASS.
Run: `pnpm --filter @fermeribg/api build`
Expected: PASS (the projection + strip type-check against the updated `PublicFarmer`).

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/index.ts server/src/modules/farmers/farmers.service.ts server/src/modules/farmers/farmers.public-fields.spec.ts
git commit -m "feat(farmers): expose story publicly, keep notes/payout private"
```

---

### Task 4: Controller — strip notes/payout for the farmer sub-account role

**Files:**
- Modify: `server/src/modules/farmers/farmers.controller.ts` (`findAll`, ~lines 37-47)
- Test: `server/src/modules/farmers/farmers.controller.spec.ts` (create)

**Interfaces:**
- Consumes: `FarmersService.findAll` (returns full rows), `effectiveFarmerId` (already imported in the controller).
- Produces: `FarmersController.findAll` returns rows with `commissionRateBps`/`subscriptionFeeStotinki`/`internalNotes`/`payout` removed when `user.role === 'farmer'`; unchanged for admin.

- [ ] **Step 1: Write the failing controller test**

Create `server/src/modules/farmers/farmers.controller.spec.ts`:

```ts
import { FarmersController } from './farmers.controller';

describe('FarmersController.findAll role strip', () => {
  const row = {
    id: 'f1', tenantId: 't1', name: 'Васил',
    commissionRateBps: 500, subscriptionFeeStotinki: 1200,
    internalNotes: 'таен', payout: { iban: 'BG80', holder: 'Васил' },
  };

  it('strips operator-only fields for the farmer sub-account role', async () => {
    const svc = { findAll: jest.fn().mockResolvedValue([{ ...row }]) } as any;
    const ctrl = new FarmersController(svc);
    const out = await ctrl.findAll('t1', { role: 'farmer', farmerId: 'f1' } as any);
    expect(out[0]).not.toHaveProperty('commissionRateBps');
    expect(out[0]).not.toHaveProperty('subscriptionFeeStotinki');
    expect(out[0]).not.toHaveProperty('internalNotes');
    expect(out[0]).not.toHaveProperty('payout');
    expect(out[0]).toHaveProperty('name', 'Васил');
  });

  it('leaves everything for the admin/owner role', async () => {
    const svc = { findAll: jest.fn().mockResolvedValue([{ ...row }]) } as any;
    const ctrl = new FarmersController(svc);
    const out = await ctrl.findAll('t1', { role: 'admin' } as any);
    expect(out[0]).toHaveProperty('internalNotes', 'таен');
    expect(out[0]).toHaveProperty('payout');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- farmers.controller`
Expected: FAIL — the farmer-role case keeps `internalNotes`/`payout` (current strip only removes the two finance fields).

- [ ] **Step 3: Extend the farmer-role strip**

In `farmers.controller.ts` `findAll`, replace the `if (user.role === 'farmer')` block with:

```ts
    // commissionRateBps / subscriptionFeeStotinki are the operator's commercial terms,
    // and internalNotes / payout are operator-only profile fields — all owner/admin-only.
    // A producer sub-account may read its own row here, so strip them for the farmer role
    // (the panel calls this as admin, unstripped).
    if (user.role === 'farmer') {
      return rows.map(({
        commissionRateBps: _c,
        subscriptionFeeStotinki: _s,
        internalNotes: _n,
        payout: _p,
        ...rest
      }) => rest);
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- farmers.controller`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/farmers/farmers.controller.ts server/src/modules/farmers/farmers.controller.spec.ts
git commit -m "feat(farmers): hide notes/payout from farmer sub-account role"
```

---

### Task 5: Client — story + internal-notes sections (+ client Farmer type)

**Files:**
- Modify: `client/src/lib/types.ts` (`Farmer` interface, ~lines 156-179)
- Modify: `client/src/components/farmers/farmer-panel.tsx`

**Interfaces:**
- Consumes: `Farmer` from `@/lib/types`.
- Produces: the drawer renders + saves `story` and `internalNotes`; the client `Farmer` type carries `story`, `internalNotes`, `payout` (payout is consumed in Task 6).

- [ ] **Step 1: Add the three fields to the client Farmer type**

In `client/src/lib/types.ts`, inside `export interface Farmer`, after the `subscriptionFeeStotinki?` line, add:

```ts
  /** „За фермата" — long public story shown on the storefront farmer subpage. */
  story?: string | null;
  /** Operator-only private notes about this producer — never public. */
  internalNotes?: string | null;
  /** Operator-only payout account for marketplace settlement — never public. */
  payout?: { iban?: string; holder?: string; bic?: string } | null;
```

- [ ] **Step 2: Add the icon import + state in farmer-panel.tsx**

In `client/src/components/farmers/farmer-panel.tsx`, add `StickyNote` to the existing `lucide-react` import:

```ts
import { X, Check, Send, KeyRound, Sparkles, Images, FileText, StickyNote } from 'lucide-react';
```

Then add state alongside the other `useState` hooks (e.g. right after the `const [bio, setBio] = ...` line):

```ts
  const [story, setStory] = useState(farmer.story ?? '');
  const [notes, setNotes] = useState(farmer.internalNotes ?? '');
```

- [ ] **Step 3: Render the „За фермата" section**

Immediately AFTER the „Кратко описание" `<label>` block (the `bio` textarea, ends ~line 323), insert:

```tsx
          <label className={labelCls}>
            За фермата (дълъг разказ)
            <textarea
              value={story}
              onChange={(e) => setStory(e.target.value)}
              rows={6}
              placeholder="Историята, методът, ценностите — показва се на страницата на фермера в магазина…"
              className={`${field} resize-y leading-relaxed`}
            />
            <span className="text-[11px] font-semibold text-ff-muted">
              Дълъг текст за публичната страница на фермера. „Кратко описание" горе е за списъците.
            </span>
          </label>
```

- [ ] **Step 4: Render the „Вътрешни бележки" section**

Immediately BEFORE the panel-access card (the `<div ref={accessRef} ...>` block, ~line 552), insert:

```tsx
          <div className="rounded-xl border border-ff-border-2 bg-ff-surface-2 p-3.5">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted">
              <StickyNote size={14} className="text-ff-amber-600" /> Вътрешни бележки
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="напр. обажда се преди доставка, предпочита Viber…"
              className={`${field} resize-y leading-relaxed`}
            />
            <p className="mt-1.5 text-[11px] font-semibold text-ff-muted">
              Само за теб — не се показва на клиента.
            </p>
          </div>
```

- [ ] **Step 5: Wire both into `save()`**

In the `save()` function, inside the `const data = { ... }` object (e.g. after the `bio: bio.trim(),` line), add:

```ts
        story: story.trim() || null,
        internalNotes: notes.trim() || null,
```

- [ ] **Step 6: Verify build + preview**

Run: `pnpm --filter @fermeribg/web build`
Expected: PASS (typecheck clean).

Then verify in the browser preview:
- Start the dev server (preview_start `{name}` for the client), open `/farmers`, open an existing farmer.
- Confirm „За фермата" (under „Кратко описание") and „Вътрешни бележки" both render. If a screenshot times out, use read_page and confirm the two labels/placeholders appear in the DOM.
- Type into both, click „Запази промените", reopen the farmer → both values persisted.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/types.ts client/src/components/farmers/farmer-panel.tsx
git commit -m "feat(client): farmer story + internal notes sections"
```

---

### Task 6: Client — IBAN payout card (marketplace-gated)

**Files:**
- Modify: `client/src/components/farmers/farmer-panel.tsx`

**Interfaces:**
- Consumes: `farmer.payout` (client `Farmer` type from Task 5), the `multiFarmer` prop (already threaded into the component).
- Produces: the drawer renders + saves `payout` (marketplace tenants only); IBAN is whitespace-stripped and upper-cased before send to satisfy the server `@Matches` regex.

- [ ] **Step 1: Add the icon import + state**

Add `Banknote` to the `lucide-react` import in `farmer-panel.tsx`:

```ts
import { X, Check, Send, KeyRound, Sparkles, Images, FileText, StickyNote, Banknote } from 'lucide-react';
```

Add state (near the commission/fee state, ~line 68-73):

```ts
  const [iban, setIban] = useState(farmer.payout?.iban ?? '');
  const [payoutHolder, setPayoutHolder] = useState(farmer.payout?.holder ?? '');
  const [bic, setBic] = useState(farmer.payout?.bic ?? '');
```

- [ ] **Step 2: Render the card (gated behind `multiFarmer`)**

Immediately AFTER the commission/monthly-fee `{multiFarmer && (...)}` grid block (the one with „Комисиона %" / „Месечна такса €", ~line 407-418), insert:

```tsx
          {multiFarmer && (
            <div className="rounded-xl border border-ff-border-2 bg-ff-surface-2 p-3.5">
              <div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted">
                <Banknote size={14} /> IBAN за изплащане
              </div>
              <p className="mt-1.5 text-[12px] leading-snug text-ff-muted">
                За превод на оборота към фермера. Не се показва публично.
              </p>
              <div className="mt-3 flex flex-col gap-3">
                <label className={labelCls}>
                  IBAN
                  <input
                    value={iban}
                    onChange={(e) => setIban(e.target.value)}
                    placeholder="BG80 BNBG 9661 1020 3456 78"
                    className={field}
                  />
                </label>
                <div className="grid grid-cols-[1fr_120px] gap-3">
                  <label className={labelCls}>
                    Титуляр
                    <input
                      value={payoutHolder}
                      onChange={(e) => setPayoutHolder(e.target.value)}
                      placeholder="напр. Петър Петров"
                      className={field}
                    />
                  </label>
                  <label className={labelCls}>
                    BIC (по избор)
                    <input
                      value={bic}
                      onChange={(e) => setBic(e.target.value)}
                      placeholder="BNBGBGSF"
                      className={field}
                    />
                  </label>
                </div>
              </div>
            </div>
          )}
```

- [ ] **Step 3: Wire into `save()`**

In `save()`, before the `const data = { ... }` object, add (mirrors the existing `legalParts` pattern):

```ts
      // Payout — send the object only when a field is filled; blank form clears it to null.
      // IBAN is stripped of spaces + upper-cased so it matches the server @Matches regex.
      const payoutParts = {
        iban: iban.replace(/\s+/g, '').toUpperCase() || undefined,
        holder: payoutHolder.trim() || undefined,
        bic: bic.trim().toUpperCase() || undefined,
      };
      const hasPayout = Object.values(payoutParts).some(Boolean);
```

Then inside the `data` object (e.g. after the `internalNotes:` line from Task 5), add:

```ts
        payout: hasPayout ? payoutParts : null,
```

- [ ] **Step 4: Verify build + preview**

Run: `pnpm --filter @fermeribg/web build`
Expected: PASS.

Preview verification:
- On a marketplace tenant (`multiFarmer` on — the seeded demo tenant), open a farmer drawer → confirm the „IBAN за изплащане" card appears (below комисиона/такса). Fill IBAN `BG80 BNBG 9661 1020 3456 78` + Титуляр, save, reopen → persisted (stored without spaces, upper-case).
- Confirm the card is ABSENT on a single-farm (non-`multiFarmer`) tenant.
- Negative check: enter an obviously wrong IBAN like `123` and save → the server 400s (toast shows „Невалиден IBAN…" / „Грешка"); a valid one saves cleanly.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/farmers/farmer-panel.tsx
git commit -m "feat(client): farmer payout IBAN card (marketplace only)"
```

---

### Task 7: Client — profile completeness meter

**Files:**
- Create: `client/src/components/farmers/completeness-meter.tsx`
- Test: `client/src/components/farmers/completeness-meter.test.ts` (create)
- Modify: `client/src/components/farmers/farmer-panel.tsx`

**Interfaces:**
- Consumes: boolean flags derived from the drawer's form state.
- Produces: `computeCompleteness(input: CompletenessInput): CompletenessItem[]` and the `<CompletenessMeter items={...} />` component. `CompletenessItem = { key: string; label: string; done: boolean }`.

- [ ] **Step 1: Write the failing unit test**

Create `client/src/components/farmers/completeness-meter.test.ts`:

```ts
import { computeCompleteness } from './completeness-meter';

describe('computeCompleteness', () => {
  const base = {
    hasPhoto: true, hasBio: true, hasStory: false, hasProducts: false,
    hasAccess: false, marketplace: false, hasLegal: false, hasPayout: false,
  };

  it('single-farm tenant has 5 items', () => {
    expect(computeCompleteness(base)).toHaveLength(5);
  });

  it('marketplace tenant adds legal + payout (7 items)', () => {
    expect(computeCompleteness({ ...base, marketplace: true })).toHaveLength(7);
  });

  it('marks done from the input flags', () => {
    const items = computeCompleteness(base);
    expect(items.find((x) => x.key === 'photo')?.done).toBe(true);
    expect(items.find((x) => x.key === 'story')?.done).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fermeribg/web test -- completeness-meter`
Expected: FAIL — module `./completeness-meter` does not exist yet.

- [ ] **Step 3: Create the component + pure function**

Create `client/src/components/farmers/completeness-meter.tsx`:

```tsx
import { Check, Circle } from 'lucide-react';

export type CompletenessInput = {
  hasPhoto: boolean;
  hasBio: boolean;
  hasStory: boolean;
  hasProducts: boolean;
  hasAccess: boolean;
  /** Marketplace tenant — adds the legal + payout items. */
  marketplace: boolean;
  hasLegal: boolean;
  hasPayout: boolean;
};

export type CompletenessItem = { key: string; label: string; done: boolean };

/** Which profile items count toward "complete", and whether each is done. Pure so
 *  it's unit-tested directly. Marketplace tenants get 2 extra items (legal, payout). */
export function computeCompleteness(i: CompletenessInput): CompletenessItem[] {
  const items: CompletenessItem[] = [
    { key: 'photo', label: 'Снимка', done: i.hasPhoto },
    { key: 'bio', label: 'Кратко описание', done: i.hasBio },
    { key: 'story', label: 'За фермата', done: i.hasStory },
    { key: 'products', label: 'Свързани продукти', done: i.hasProducts },
    { key: 'access', label: 'Достъп до панела', done: i.hasAccess },
  ];
  if (i.marketplace) {
    items.push({ key: 'legal', label: 'Легални данни', done: i.hasLegal });
    items.push({ key: 'payout', label: 'IBAN за изплащане', done: i.hasPayout });
  }
  return items;
}

export function CompletenessMeter({ items }: { items: CompletenessItem[] }) {
  const done = items.filter((i) => i.done).length;
  const pct = Math.round((done / items.length) * 100);
  return (
    <div className="rounded-xl border border-ff-border-2 bg-ff-surface-2 p-3.5">
      <div className="mb-2 flex items-center justify-between text-[12.5px] font-extrabold text-ff-ink-2">
        <span>Попълненост на профила</span>
        <span>{pct}%</span>
      </div>
      <div className="mb-3 h-2 overflow-hidden rounded-full bg-ff-border">
        <div className="h-full rounded-full bg-ff-green-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1.5">
        {items.map((i) => (
          <li
            key={i.key}
            className={`flex items-center gap-1 text-[12px] font-semibold ${
              i.done ? 'text-ff-green-700' : 'text-ff-muted'
            }`}
          >
            {i.done ? <Check size={13} /> : <Circle size={13} />} {i.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @fermeribg/web test -- completeness-meter`
Expected: PASS.

- [ ] **Step 5: Wire the meter into the drawer**

In `farmer-panel.tsx`, add the import:

```ts
import { CompletenessMeter, computeCompleteness } from './completeness-meter';
```

Then, immediately AFTER the avatar-preview card (the `<div className="flex items-center gap-3.5 rounded-xl ...">` block that shows the Avatar + name/role, ends ~line 294), insert:

```tsx
          {!isNew && (
            <CompletenessMeter
              items={computeCompleteness({
                hasPhoto: !!imageUrl,
                hasBio: !!bio.trim(),
                hasStory: !!story.trim(),
                hasProducts: checked.size > 0,
                hasAccess: !!acc,
                marketplace: multiFarmer,
                hasLegal: !!(legalKind || legalName.trim() || eik.trim() || regNo.trim() || legalAddress.trim()),
                hasPayout: !!(iban.trim() || payoutHolder.trim()),
              })}
            />
          )}
```

- [ ] **Step 6: Verify build + preview**

Run: `pnpm --filter @fermeribg/web build`
Expected: PASS.

Preview: open an existing farmer → the meter shows under the avatar with a % and the checklist. Toggle a field (type into „За фермата") → the „За фермата" item flips to done and the % rises live. Confirm the meter is hidden when adding a NEW farmer (`isNew`).

- [ ] **Step 7: Commit**

```bash
git add client/src/components/farmers/completeness-meter.tsx client/src/components/farmers/completeness-meter.test.ts client/src/components/farmers/farmer-panel.tsx
git commit -m "feat(client): farmer profile completeness meter"
```

---

## Non-goals / follow-ups (not in this plan)

- **chaika render of `story`** — the API now exposes it; showing it on the storefront farmer subpage is a separate change in the chaika Cloudflare Workers repo.
- Payout execution / settlement UI (this plan is capture-only).
- Tags, per-producer stats snapshot, document vault, per-farmer socials/video/certifications/map/seasonality, and farmer self-service editing — later slices, each its own spec.

## Self-Review notes

- **Spec coverage:** Section 1 (notes) → Tasks 2,3,4,5. Section 2 (meter) → Task 7. Section 3 (story) → Tasks 2,3,5. Section 4 (payout) → Tasks 2,3,4,6. Migration + schema → Task 1. Public/private guard → Tasks 3,4. All spec sections have tasks.
- **Type consistency:** `CompletenessInput`/`CompletenessItem`/`computeCompleteness` names match between Task 7's test, component, and drawer wiring. `PayoutDto` shape `{ iban?; holder?; bic? }` matches the schema `$type`, the client `Farmer.payout`, and the `payoutParts` builder. `internalNotes`/`story` names consistent across schema, DTO, service, types, and client.
- **Private-field defense:** `internalNotes`/`payout` are (a) never selected in the projection, (b) stripped in `findPublicBySlug`, (c) stripped in the controller for the farmer role, (d) excluded from `PublicFarmer`. Story is public in exactly one place (projection) and asserted present by the guard spec.
