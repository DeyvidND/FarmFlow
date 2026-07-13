# Operator Legal Identity Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin settings surface for `tenants.settings.legal` (operator legal identity) so the handover-protocol feature's `requireLegal` guard can be satisfied.

**Architecture:** A dedicated `GET/PATCH tenants/me/legal` endpoint pair (atomic `jsonb_set`, mirroring the existing `site-contact` sub-resource pattern) backs a new settings card component, wired into the existing inline-config-screen system (`ConfigKey` union + `ConfigSection` switch) — **not a new route/page** (confirmed: `configurations-card.tsx`'s tiles open inline inside `/settings` via `onOpen`/`ConfigKey`, there is no per-tile Next.js route).

**Tech Stack:** NestJS + Drizzle (`jsonb_set` SQL), Next.js client component (`sonner` toasts, existing `SaveBar`/`ToggleSwitch`-style local state), Jest for server specs.

## Global Constraints

- Money/other conventions: N/A (no money fields in this feature).
- DTO field set (verbatim, mirrors `farmers/dto/legal.dto.ts`): `kind?: 'individual'|'sole_trader'|'company'`, `name?: string` (max 200), `eik?: string` (max 20), `vatNumber?: string` (max 20), `address?: string` (max 300), `regNo?: string` (max 40). `confirmedAt` is **server-stamped on every save**, never accepted from the client.
- Backend write must be an atomic single-statement `jsonb_set` (no read-modify-write) — mirrors `updateSiteContact` in `tenants.service.ts`.
- No `@Roles` decorator on the new routes (matches `site-contact`'s convention — defaults to admin-only via the global `TenantRolesGuard`).
- Out of scope (explicitly deferred by user): a shortcut link from the handover-protocol "Липсват легални данни" error to this settings screen.
- No dedicated client test framework covers settings-card runtime interaction in this codebase (confirmed via `merchandising-card.tsx`'s precedent, which has no spec file) — `pnpm --filter @fermeribg/web build` is this task's frontend covering check.

---

## File Structure

- `server/src/modules/tenants/dto/legal.dto.ts` — new DTO (copy of `farmers/dto/legal.dto.ts`'s fields, own class — not shared).
- `server/src/modules/tenants/tenants.service.ts` — add `getLegal`/`updateLegal`.
- `server/src/modules/tenants/tenants.service.spec.ts` — new tests for both methods (create the file if it doesn't exist; check first).
- `server/src/modules/tenants/tenants.controller.ts` — add `GET/PATCH tenants/me/legal`.
- `client/src/lib/api-client.ts` — add `getTenantLegal`/`updateTenantLegal`.
- `client/src/components/settings/legal-card.tsx` — new standalone card component (mirrors `merchandising-card.tsx`'s structure: load/dirty/save/toast).
- `client/src/components/settings/configurations-card.tsx` — add `'legal'` to `ConfigKey` + a tile.
- `client/src/app/(admin)/settings/page.tsx` — add `'legal'` to `CONFIG_KEYS` + the `ConfigSection` switch.

---

## Task 1: Backend — DTO + pure helper + service methods (TDD)

**Confirmed convention (checked `server/src/modules/tenants/site-contact.spec.ts`,
`merchandising.spec.ts`, `landing.spec.ts`):** this module's sub-resource specs test only
the **pure normalize/build helper functions** (e.g. `buildPublicContact`,
`normalizeSiteContact`) — `TenantsService`'s actual DB-touching methods
(`updateSiteContact`, etc.) have **no unit-level DB-mock test** anywhere in this codebase;
they're thin wiring around the pure helper + a `jsonb_set` write. Match that exact
precedent here: extract the one piece of real logic (stamping `confirmedAt`) into a pure
function and test it directly; `getLegal`/`updateLegal` stay untested at the unit level,
consistent with their siblings.

**Files:**
- Create: `server/src/modules/tenants/dto/legal.dto.ts`
- Create: `server/src/modules/tenants/legal.ts` (pure helper, mirrors `site-contact.ts`'s role)
- Create: `server/src/modules/tenants/legal.spec.ts`
- Modify: `server/src/modules/tenants/tenants.service.ts`

**Interfaces:**
- Produces: `normalizeLegal(dto: LegalDto): LegalIdentity` (pure, testable); `TenantsService.getLegal(tenantId: string): Promise<LegalIdentity | null>`, `TenantsService.updateLegal(tenantId: string, dto: LegalDto): Promise<LegalIdentity>` — both used by Task 2's controller.

- [ ] **Step 1: Write `legal.dto.ts`**

```ts
import { IsString, IsOptional, IsIn, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Operator legal identity — the marketplace operator's own registration details,
 * shown as the „Приел"/„Предал" party on приемо-предавателни протоколи and delivery
 * receipts (see handover-protocol feature, `requireLegal`). Mirrors the shape of
 * `farmers/dto/legal.dto.ts` (the seller-side identity) but is a SEPARATE DTO — the
 * two are different bounded resources even though the fields match today.
 */
export class LegalDto {
  @ApiPropertyOptional({ enum: ['individual', 'sole_trader', 'company'] })
  @IsOptional()
  @IsIn(['individual', 'sole_trader', 'company'])
  kind?: 'individual' | 'sole_trader' | 'company';

  @ApiPropertyOptional({ example: 'ЕТ „ФермериБГ"', description: 'Юридическо/фирмено име на оператора.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: '203912345', description: 'ЕИК/БУЛСТАТ (ЕТ/фирма).' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  eik?: string;

  @ApiPropertyOptional({ example: 'BG203912345', description: 'ДДС номер (ако е регистриран по ЗДДС).' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  vatNumber?: string;

  @ApiPropertyOptional({ example: 'гр. Варна, ул. „Приморска" 12', description: 'Адрес на управление/седалище.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ example: '123456789', description: 'Рег. номер (ако операторът е физическо лице).' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  regNo?: string;
}
```

- [ ] **Step 2: Write the failing test** for the pure helper, `server/src/modules/tenants/legal.spec.ts`:

```ts
import { normalizeLegal } from './legal';

describe('normalizeLegal', () => {
  it('stamps confirmedAt and passes through the given fields', () => {
    const out = normalizeLegal({ kind: 'company', name: 'ЕООД Тест', eik: '111' });
    expect(out.confirmedAt).toBeDefined();
    expect(new Date(out.confirmedAt!).toString()).not.toBe('Invalid Date');
    expect(out).toMatchObject({ kind: 'company', name: 'ЕООД Тест', eik: '111' });
  });

  it('drops blank/whitespace-only optional fields to undefined', () => {
    const out = normalizeLegal({ name: '  ', eik: '', address: '  гр. Варна  ' });
    expect(out.name).toBeUndefined();
    expect(out.eik).toBeUndefined();
    expect(out.address).toBe('гр. Варна');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- legal.spec`
Expected: FAIL — `legal.ts`/`normalizeLegal` not found.

- [ ] **Step 4: Implement the pure helper** `server/src/modules/tenants/legal.ts`:

```ts
import type { LegalDto } from './dto/legal.dto';
import type { LegalIdentity } from '@fermeribg/types';

const trim = (s?: string) => {
  const t = s?.trim();
  return t ? t : undefined;
};

/** Normalizes the incoming DTO and stamps confirmedAt server-side (audit trail) —
 *  never taken from the client, even if a future DTO field happened to carry one. */
export function normalizeLegal(dto: LegalDto): LegalIdentity {
  return {
    kind: dto.kind,
    name: trim(dto.name),
    eik: trim(dto.eik),
    vatNumber: trim(dto.vatNumber),
    address: trim(dto.address),
    regNo: trim(dto.regNo),
    confirmedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- legal.spec`
Expected: PASS, 2/2.

- [ ] **Step 6: Implement `getLegal`/`updateLegal` on `TenantsService`** (untested at this level, matching `updateSiteContact`'s own precedent — the real logic already lives in, and is tested via, `normalizeLegal`). Add to `tenants.service.ts` near the other `settings.*` sub-resource methods (e.g. after `updateSiteContact`):

```ts
// ---- Operator legal identity (handover-protocol приел/предал party) ----

/** Current operator legal identity, or null if never set. */
async getLegal(tenantId: string): Promise<LegalIdentity | null> {
  const settings = await this.loadSettings(tenantId);
  return (settings.legal as LegalIdentity | undefined) ?? null;
}

/** Atomic write to settings.legal. */
async updateLegal(tenantId: string, dto: LegalDto): Promise<LegalIdentity> {
  const legal = normalizeLegal(dto);
  await this.db
    .update(tenants)
    .set({
      settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['legal'], ${JSON.stringify(legal)}::jsonb, true)`,
    })
    .where(eq(tenants.id, tenantId));
  return legal;
}
```

Add the import lines near the other DTO/helper imports at the top of `tenants.service.ts`:
```ts
import { LegalDto } from './dto/legal.dto';
import { normalizeLegal } from './legal';
```
(`LegalIdentity` should already be importable from `@fermeribg/types` alongside the existing `PublicTenant, Tenant` import at `tenants.service.ts:12` — extend that import: `import type { PublicTenant, Tenant, LegalIdentity } from '@fermeribg/types';`)

- [ ] **Step 7: Run the tenants test suite**

Run: `pnpm --filter @fermeribg/api test -- tenants`
Expected: all pass (incl. the new `legal.spec.ts`), no regressions.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/tenants/dto/legal.dto.ts server/src/modules/tenants/legal.ts server/src/modules/tenants/legal.spec.ts server/src/modules/tenants/tenants.service.ts
git commit -m "feat(tenants): getLegal/updateLegal + normalizeLegal helper for operator legal identity"
```

---

## Task 2: Backend — controller endpoints

**Files:**
- Modify: `server/src/modules/tenants/tenants.controller.ts`
- Test: `server/src/modules/tenants/tenants.controller.spec.ts` (check if it exists first; if not, a lightweight test is optional here — the controller is a 2-line pass-through per route, matching the untested `site-contact`/`merchandising` routes already in this file. State explicitly in your report whether you added a test or relied on the existing untested-pass-through precedent.)

**Interfaces:**
- Consumes: `TenantsService.getLegal`/`updateLegal` (Task 1).
- Produces: `GET tenants/me/legal` → `LegalIdentity | null`; `PATCH tenants/me/legal` (body: `LegalDto`) → `LegalIdentity`.

- [ ] **Step 1: Add the import** to `tenants.controller.ts`'s import block (near the other DTO imports):

```ts
import { LegalDto } from './dto/legal.dto';
```

- [ ] **Step 2: Add the two routes** (place near the `site-contact` routes for locality):

```ts
@ApiOperation({ summary: 'Operator legal identity (for handover-protocol documents)' })
@Get('me/legal')
getLegal(@CurrentTenant() tenantId: string) {
  return this.tenantsService.getLegal(tenantId);
}

@ApiOperation({ summary: 'Update operator legal identity' })
@Patch('me/legal')
updateLegal(@CurrentTenant() tenantId: string, @Body() dto: LegalDto) {
  return this.tenantsService.updateLegal(tenantId, dto);
}
```

No `@Roles` decorator (matches `site-contact`'s convention — the class-level `@UseGuards(JwtAuthGuard)` plus the global `TenantRolesGuard`'s admin-only default handles authorization).

- [ ] **Step 3: Verify it compiles**

Run: `pnpm --filter @fermeribg/api build`
Expected: clean, no TS errors.

- [ ] **Step 4: Run the full tenants test suite**

Run: `pnpm --filter @fermeribg/api test -- tenants`
Expected: all pass, no regressions.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tenants/tenants.controller.ts
git commit -m "feat(tenants): GET/PATCH tenants/me/legal endpoints"
```

---

## Task 3: Frontend — API client helpers

**Files:**
- Modify: `client/src/lib/api-client.ts`

**Interfaces:**
- Produces: `getTenantLegal(): Promise<LegalIdentity | null>`, `updateTenantLegal(dto: LegalIdentity): Promise<LegalIdentity>` — consumed by Task 4.

- [ ] **Step 1: Add the helpers** (place near `getMerchandising`/`updateMerchandising`, ~line 520; `LegalIdentity` is already imported/exported from this file's types — check the existing import block from the handover-protocol feature, e.g. `import type { ..., LegalIdentity, ... } from './types';` or wherever it currently lives, and reuse it — do NOT redeclare the type):

```ts
export const getTenantLegal = () => apiFetch<LegalIdentity | null>('tenants/me/legal');

export const updateTenantLegal = (legal: LegalIdentity) =>
  apiFetch<LegalIdentity>(
    'tenants/me/legal',
    { method: 'PATCH', ...json(legal) },
    'Неуспешна промяна',
  );
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @fermeribg/web build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/api-client.ts
git commit -m "feat(client): getTenantLegal/updateTenantLegal API helpers"
```

---

## Task 4: Frontend — Legal settings card

**Files:**
- Create: `client/src/components/settings/legal-card.tsx`

**Interfaces:**
- Consumes: `getTenantLegal`, `updateTenantLegal` (Task 3), `LegalIdentity` type.
- Produces: `<LegalCard />` — a self-contained settings card, consumed by Task 5's `ConfigSection` switch.

- [ ] **Step 1: Implement the component**, mirroring `merchandising-card.tsx`'s load/dirty/save/toast structure and `farmer-panel.tsx`'s legal-form fields/classes exactly:

```tsx
'use client';

/**
 * Settings → легални данни на оператора. Shown as the „Приел"/„Предал" party on
 * приемо-предавателни протоколи и разписки (handover-protocol feature). Mirrors the
 * farmer legal-identity card's fields; writes to tenants.settings.legal.
 */
import * as React from 'react';
import { FileText } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { SaveBar } from '@/components/panels/panel-ui';
import { ApiError, getTenantLegal, updateTenantLegal, type LegalIdentity } from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[16px] sm:text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

type Kind = '' | 'individual' | 'sole_trader' | 'company';

const same = (a: LegalIdentity, b: LegalIdentity) => JSON.stringify(a) === JSON.stringify(b);

export function LegalCard() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<LegalIdentity | null>(null);
  const [kind, setKind] = React.useState<Kind>('');
  const [name, setName] = React.useState('');
  const [eik, setEik] = React.useState('');
  const [vatNumber, setVatNumber] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [regNo, setRegNo] = React.useState('');

  React.useEffect(() => {
    let active = true;
    getTenantLegal()
      .then((legal) => {
        if (!active) return;
        setSaved(legal ?? {});
        setKind((legal?.kind as Kind) ?? '');
        setName(legal?.name ?? '');
        setEik(legal?.eik ?? '');
        setVatNumber(legal?.vatNumber ?? '');
        setAddress(legal?.address ?? '');
        setRegNo(legal?.regNo ?? '');
      })
      .catch(() => active && toast.error('Неуспешно зареждане на настройките'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const current: LegalIdentity = {
    kind: kind || undefined,
    name: name.trim() || undefined,
    eik: eik.trim() || undefined,
    vatNumber: vatNumber.trim() || undefined,
    address: address.trim() || undefined,
    regNo: regNo.trim() || undefined,
  };
  const dirty = !!saved && !same(current, { ...saved, confirmedAt: undefined });

  const save = async () => {
    setSaving(true);
    try {
      const legal = await updateTenantLegal(current);
      setSaved(legal);
      toast.success('Данните са обновени');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setKind((saved?.kind as Kind) ?? '');
    setName(saved?.name ?? '');
    setEik(saved?.eik ?? '');
    setVatNumber(saved?.vatNumber ?? '');
    setAddress(saved?.address ?? '');
    setRegNo(saved?.regNo ?? '');
  };

  return (
    <section className={cn('rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm', dirty && 'mb-16')}>
      <div className="flex items-center gap-1.5 text-[16px] font-extrabold">
        <FileText size={17} /> Легални данни
      </div>
      <p className="mt-1 text-[13px] leading-snug text-ff-muted">
        Данни на оператора — показват се като насрещна страна на приемо-предавателните
        протоколи и разписките за доставка.
      </p>

      {loading ? (
        <div className="mt-5 text-[13.5px] text-ff-muted">Зареждане…</div>
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          <label className={labelCls}>
            Вид оператор
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={field}>
              <option value="">— избери —</option>
              <option value="individual">Физическо лице</option>
              <option value="sole_trader">ЕТ (едноличен търговец)</option>
              <option value="company">Фирма (ЕООД / ООД / АД)</option>
            </select>
          </label>
          <label className={labelCls}>
            Юридическо / фирмено име
            <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              {kind === 'individual' ? 'Рег. №' : 'ЕИК / БУЛСТАТ'}
              <input
                value={kind === 'individual' ? regNo : eik}
                onChange={(e) => (kind === 'individual' ? setRegNo(e.target.value) : setEik(e.target.value))}
                inputMode="numeric"
                className={field}
              />
            </label>
            <label className={labelCls}>
              ДДС № (по избор)
              <input value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} className={field} />
            </label>
          </div>
          <label className={labelCls}>
            Адрес на управление / кореспонденция
            <input value={address} onChange={(e) => setAddress(e.target.value)} className={field} />
          </label>
          {saved?.confirmedAt && (
            <p className="text-[11px] font-semibold text-ff-muted">
              Последно потвърдено: {new Date(saved.confirmedAt).toLocaleDateString('bg-BG')}
            </p>
          )}
        </div>
      )}

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={discard} />}
    </section>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @fermeribg/web build`
Expected: clean. (`SaveBar`'s exact prop names — `saving`/`onSave`/`onDiscard` — were confirmed against `merchandising-card.tsx`'s usage; if the build reports a prop mismatch, check `client/src/components/panels/panel-ui.tsx`'s real `SaveBar` signature and adjust.)

- [ ] **Step 3: Commit**

```bash
git add client/src/components/settings/legal-card.tsx
git commit -m "feat(client): operator legal-identity settings card"
```

---

## Task 5: Frontend — wire into the settings hub

**Files:**
- Modify: `client/src/components/settings/configurations-card.tsx`
- Modify: `client/src/app/(admin)/settings/page.tsx`

**Interfaces:**
- Consumes: `<LegalCard />` (Task 4).

- [ ] **Step 1: Add `'legal'` to `ConfigKey`** in `configurations-card.tsx:13-20`:

```ts
export type ConfigKey =
  | 'setup'
  | 'delivery'
  | 'slots'
  | 'features'
  | 'merchandising'
  | 'landing'
  | 'marketing'
  | 'legal';
```

- [ ] **Step 2: Add a new group + tile** in `configurations-card.tsx`'s `GROUPS` array (append a new group after `'Маркетинг'`, ~line 59, so it reads as its own section rather than crowding an existing one):

```ts
  {
    title: 'Оператор',
    desc: 'Данни за платформата като юридическо лице.',
    items: [
      { key: 'legal', label: 'Легални данни', Icon: FileText, desc: 'Данни на оператора за приемо-предавателни протоколи и разписки за доставка.' },
    ],
  },
```

Add `FileText` to the `lucide-react` import at the top of `configurations-card.tsx` (alongside `SlidersHorizontal, Truck, ...`).

- [ ] **Step 3: Wire the tile into `settings/page.tsx`.** Add `'legal'` to `CONFIG_KEYS` (~line 23-31):

```ts
const CONFIG_KEYS: ConfigKey[] = [
  'setup',
  'delivery',
  'slots',
  'features',
  'merchandising',
  'landing',
  'marketing',
  'legal',
];
```

Import `LegalCard` at the top:
```ts
import { LegalCard } from '@/components/settings/legal-card';
```

Add the case to `ConfigSection`'s switch (~line 39-56):
```ts
    case 'legal':
      return <LegalCard />;
```

- [ ] **Step 4: Verify it compiles**

Run: `pnpm --filter @fermeribg/web build`
Expected: clean, `/settings` route still generates.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/settings/configurations-card.tsx "client/src/app/(admin)/settings/page.tsx"
git commit -m "feat(client): wire Легални данни tile into the settings hub"
```

---

## Task 6: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1:** Start the dev stack via `.claude/launch.json` (server `api-dev` + client `web-dev`) — never Bash for servers. If the FarmFlow dev Postgres port is unavailable (a known conflict with concurrent worktree sessions on this machine — check `docker compose ps` in the FarmFlow root first), note that and skip to a static review instead of blocking.
- [ ] **Step 2:** Log in as admin, navigate to Настройки → Конфигурации → „Легални данни" tile appears in its own "Оператор" group.
- [ ] **Step 3:** Open it, fill kind=„ЕТ", name, ЕИК, address, save → toast success, „Последно потвърдено" timestamp appears.
- [ ] **Step 4:** Reload the page, re-open the tile → the saved values persist.
- [ ] **Step 5:** Go to the handover-protocol „Протоколи за деня" screen (from the prior feature) and confirm „Липсват легални данни за оператор" no longer appears once this is filled in; „Печат за деня" proceeds past that check.
- [ ] **Step 6:** Watch browser console + server logs for errors during the above; fix any, re-verify.

---

## Self-review

- **Spec coverage:** backend DTO+endpoints (Tasks 1-2) · atomic jsonb_set matching site-contact (Task 1 Step 6) · confirmedAt server-stamped, pure-tested (Task 1 Steps 2-6) · client helpers (Task 3) · form mirroring farmer-panel's legal card (Task 4) · new settings tile, no new route (Task 5, corrected from the spec's original assumption after reading `configurations-card.tsx`/`settings/page.tsx` — the spec said "new page.tsx"; the real codebase opens config screens inline via `ConfigKey`, so Task 5 wires it into that system instead). No shortcut link (explicitly out of scope, not built). Covered.
- **Placeholder scan:** none — every step has concrete code. Two explicit judgment calls are flagged inline rather than left vague: Task 1's test approach (extract-and-test-the-pure-helper, matching the real, verified `site-contact.spec.ts` precedent instead of inventing an untested-elsewhere DB-mock pattern) and Task 2 Step 3's controller-test-or-not decision (matching the file's existing untested-pass-through precedent).
- **Type consistency:** `LegalIdentity` is the single shared type (from `@fermeribg/types`, already merged) used identically in the DTO (server), `normalizeLegal`'s return type, the service, and the client card's state — no renamed duplicate introduced.
