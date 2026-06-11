# Configurable Landing Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each tenant choose which of the three dynamic storefront-home blocks (categories / farmers / latest offers) show, and how many items each shows, from a new admin Settings card.

**Architecture:** Config lives in `tenants.settings.landing` (jsonb, no migration). A pure leaf helper `resolveLanding()` clamps/defaults it; it's used on both the public-profile read path (`resolveTenant`) and the admin write path (`updateLanding`). Admin edits via `GET`/`PATCH /tenants/me/landing` (atomic `jsonb_set` + cache bust), mirroring the existing `site-contact` endpoints. The chaika Astro home reads the resolved config off the public profile and gates its three blocks.

**Tech Stack:** NestJS + Drizzle (server), Next.js admin (client), Astro (chaika storefront), Jest.

---

## File Structure

**Server (FarmFlow)**
- Create: `server/src/modules/tenants/landing.ts` — pure types + `DEFAULT_LANDING` + `resolveLanding()`
- Create: `server/src/modules/tenants/landing.spec.ts` — unit tests for `resolveLanding`
- Create: `server/src/modules/tenants/dto/landing.dto.ts` — `LandingDto` (request validation)
- Modify: `server/src/common/cache/public-cache.service.ts` — `TenantMeta.landing` + resolve in `resolveTenant`
- Modify: `server/src/modules/tenants/tenants.service.ts` — `PublicStorefront.landing`, `getLanding`, `updateLanding`
- Modify: `server/src/modules/tenants/tenants.controller.ts` — `GET`/`PATCH me/landing`

**Admin (FarmFlow `client/`)**
- Modify: `client/src/lib/api-client.ts` — `LandingConfig` type + `getLanding`/`updateLanding`
- Create: `client/src/components/settings/landing-card.tsx` — the editor card
- Modify: `client/src/app/(admin)/settings/page.tsx` — add „Начална страница" section

**Chaika (`fermerski-pazar-chaika`)**
- Modify: `src/lib/types.ts` — `Storefront.landing`
- Modify: `src/lib/api.ts` — `FALLBACK_STOREFRONT.landing`
- Modify: `src/pages/index.astro` — gate the three blocks

---

## Task 1: Pure landing resolver (`landing.ts`)

**Files:**
- Create: `server/src/modules/tenants/landing.ts`
- Test: `server/src/modules/tenants/landing.spec.ts`

- [ ] **Step 1: Write the failing test**

`server/src/modules/tenants/landing.spec.ts`:

```ts
import { resolveLanding, DEFAULT_LANDING } from './landing';

describe('resolveLanding', () => {
  it('returns defaults (all cats / 3 farmers / 4 latest) for missing or garbage input', () => {
    expect(resolveLanding(undefined)).toEqual(DEFAULT_LANDING);
    expect(resolveLanding(null)).toEqual(DEFAULT_LANDING);
    expect(resolveLanding('nope')).toEqual(DEFAULT_LANDING);
    expect(DEFAULT_LANDING.categories.count).toBe(0); // 0 = all
    expect(DEFAULT_LANDING.farmers.count).toBe(3);
    expect(DEFAULT_LANDING.latest.count).toBe(4);
  });

  it('clamps counts to range and coerces show', () => {
    const out = resolveLanding({
      categories: { show: false, count: 99 },
      farmers: { show: true, count: -5 },
      latest: { show: true, count: 3.5 },
    });
    expect(out.categories).toEqual({ show: false, count: 12 }); // capped at 12
    expect(out.farmers).toEqual({ show: true, count: 1 }); // farmers min is 1
    expect(out.latest).toEqual({ show: true, count: 4 }); // non-integer → default
  });

  it('keeps categories.count 0 (all) and allows 0 only for categories', () => {
    expect(resolveLanding({ categories: { count: 0 } }).categories.count).toBe(0);
    expect(resolveLanding({ farmers: { count: 0 } }).farmers.count).toBe(1); // clamped up
    expect(resolveLanding({ latest: { count: 0 } }).latest.count).toBe(1);
  });

  it('merges partial config with per-block defaults', () => {
    const out = resolveLanding({ farmers: { show: false } });
    expect(out.categories).toEqual(DEFAULT_LANDING.categories);
    expect(out.latest).toEqual(DEFAULT_LANDING.latest);
    expect(out.farmers).toEqual({ show: false, count: 3 }); // count falls back to default
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest src/modules/tenants/landing.spec.ts`
Expected: FAIL — `Cannot find module './landing'`.

- [ ] **Step 3: Write minimal implementation**

`server/src/modules/tenants/landing.ts`:

```ts
/**
 * Storefront landing-page block config (settings.landing). Each of the three
 * *dynamic* home blocks — categories, farmers, latest offers — can be shown or
 * hidden and capped to N items from the admin panel. A pure leaf module (no
 * imports) so both the public-cache read path and the tenants write path can
 * share it without a circular import, mirroring `site-contact.ts`.
 */

export interface LandingBlock {
  show: boolean;
  /** Items shown. For `categories`, 0 means "all"; farmers/latest are >= 1. */
  count: number;
}

export interface PublicLanding {
  categories: LandingBlock;
  farmers: LandingBlock;
  latest: LandingBlock;
}

/** Defaults mirror the storefront's pre-config hardcoded behavior, so a tenant
 *  with no saved config renders identically: all categories, 3 farmers, 4 latest. */
export const DEFAULT_LANDING: PublicLanding = {
  categories: { show: true, count: 0 }, // 0 = all categories
  farmers: { show: true, count: 3 },
  latest: { show: true, count: 4 },
};

const MAX_COUNT = 12;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Clamp one block against its defaults. `minCount` is 0 for categories (0 = all)
 *  and 1 for farmers/latest — hiding a block is the toggle's job, not count 0. */
function resolveBlock(raw: unknown, def: LandingBlock, minCount: number): LandingBlock {
  const r = asRecord(raw);
  const show = typeof r.show === 'boolean' ? r.show : def.show;
  const n = Number(r.count);
  const count = Number.isInteger(n) ? Math.min(MAX_COUNT, Math.max(minCount, n)) : def.count;
  return { show, count };
}

/** Resolve stored (or incoming) landing config into a complete, clamped value.
 *  Idempotent — used on both the read (public profile) and write (save) paths.
 *  Missing / garbage → DEFAULT_LANDING. */
export function resolveLanding(raw: unknown): PublicLanding {
  const r = asRecord(raw);
  return {
    categories: resolveBlock(r.categories, DEFAULT_LANDING.categories, 0),
    farmers: resolveBlock(r.farmers, DEFAULT_LANDING.farmers, 1),
    latest: resolveBlock(r.latest, DEFAULT_LANDING.latest, 1),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest src/modules/tenants/landing.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tenants/landing.ts server/src/modules/tenants/landing.spec.ts
git commit -m "feat(tenants): pure resolveLanding helper for landing-block config"
```

---

## Task 2: Surface `landing` on the cached public profile

**Files:**
- Modify: `server/src/common/cache/public-cache.service.ts` (`TenantMeta` ~line 24-67, `resolveTenant` ~line 145-177)

- [ ] **Step 1: Add the import + `TenantMeta` field**

At the top of `public-cache.service.ts`, add to the existing imports:

```ts
import { resolveLanding, type PublicLanding } from '../../modules/tenants/landing';
```

In the `TenantMeta` interface, add (next to `themeColor`):

```ts
  landing: PublicLanding;
```

- [ ] **Step 2: Resolve it in `resolveTenant`**

In `resolveTenant`, extend the `settingsObj` cast type to include `landing`:

```ts
    const settingsObj = row.settings as
      | {
          delivery?: DeliveryConfig & { econt?: { configured?: boolean } };
          media?: Record<string, { url?: unknown }>;
          contact?: unknown;
          brand?: { favicon?: { url?: unknown }; themeColor?: unknown };
          landing?: unknown;
        }
      | null;
```

Then add `landing` to the `meta` object literal (next to `themeColor`):

```ts
      themeColor,
      landing: resolveLanding(settingsObj?.landing),
    };
```

- [ ] **Step 3: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/common/cache/public-cache.service.ts
git commit -m "feat(public): carry resolved landing config on the cached tenant profile"
```

---

## Task 3: Read + write endpoints (`getLanding` / `updateLanding`)

**Files:**
- Create: `server/src/modules/tenants/dto/landing.dto.ts`
- Modify: `server/src/modules/tenants/tenants.service.ts` (`PublicStorefront` ~line 44-77; add methods after `updateSiteContact` ~line 329)
- Modify: `server/src/modules/tenants/tenants.controller.ts` (imports + routes after line 88)

- [ ] **Step 1: Create the DTO**

`server/src/modules/tenants/dto/landing.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';

/** One landing block as sent by the admin form. Service-side `resolveLanding`
 *  is authoritative (re-clamps); this just rejects gross abuse. */
export class LandingBlockDto {
  @IsOptional()
  @IsBoolean()
  show?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  count?: number;
}

export class LandingDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => LandingBlockDto)
  categories?: LandingBlockDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LandingBlockDto)
  farmers?: LandingBlockDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LandingBlockDto)
  latest?: LandingBlockDto;
}
```

- [ ] **Step 2: Wire the service**

In `tenants.service.ts`, add the import near the other local imports (e.g. below the `site-contact` import):

```ts
import { resolveLanding, type PublicLanding } from './landing';
import { LandingDto } from './dto/landing.dto';
```

Add `landing` to the `PublicStorefront` interface (next to `themeColor`):

```ts
  themeColor: string | null;
  // Configurable landing blocks (settings.landing) — which of the three dynamic
  // home blocks show and how many items each shows. Always present (resolved).
  landing: PublicLanding;
```

Add these two methods right after `updateSiteContact` (after ~line 329, before `setFavicon`):

```ts
  // ---- Landing-page blocks (settings.landing) ----

  /** Current landing config for the admin editor (resolved + clamped). */
  async getLanding(tenantId: string): Promise<{ landing: PublicLanding }> {
    const settings = await this.loadSettings(tenantId);
    return { landing: resolveLanding(settings.landing) };
  }

  /** Replace settings.landing with the resolved (clamped) incoming config in a
   *  single atomic per-path write, then bust the cached public profile. */
  async updateLanding(tenantId: string, dto: LandingDto): Promise<{ landing: PublicLanding }> {
    const { slug } = await this.loadTenantForMedia(tenantId);
    const landing = resolveLanding(dto);
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['landing'], ${JSON.stringify(landing)}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));
    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { landing };
  }
```

- [ ] **Step 3: Wire the controller**

In `tenants.controller.ts`, add to the imports:

```ts
import { LandingDto } from './dto/landing.dto';
```

Add after the `updateSiteContact` route (after line 88, still inside `TenantsController`):

```ts
  // ---- Landing-page blocks ----

  @ApiOperation({ summary: 'Storefront landing blocks (show + count)' })
  @Get('me/landing')
  getLanding(@CurrentTenant() tenantId: string) {
    return this.tenantsService.getLanding(tenantId);
  }

  @ApiOperation({ summary: 'Update storefront landing blocks' })
  @Patch('me/landing')
  updateLanding(@CurrentTenant() tenantId: string, @Body() dto: LandingDto) {
    return this.tenantsService.updateLanding(tenantId, dto);
  }
```

- [ ] **Step 4: Typecheck + full server suite**

Run: `cd server && npx tsc --noEmit && npx jest`
Expected: no type errors; all suites pass (existing count + the new `landing.spec.ts`).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tenants/dto/landing.dto.ts server/src/modules/tenants/tenants.service.ts server/src/modules/tenants/tenants.controller.ts
git commit -m "feat(tenants): GET/PATCH /me/landing for landing-block config"
```

---

## Task 4: Admin Settings card

**Files:**
- Modify: `client/src/lib/api-client.ts` (add near `getSiteContact` ~line 260)
- Create: `client/src/components/settings/landing-card.tsx`
- Modify: `client/src/app/(admin)/settings/page.tsx`

- [ ] **Step 1: Add the api-client helpers**

In `client/src/lib/api-client.ts`, add (near the `getSiteContact`/`updateSiteContact` block):

```ts
export interface LandingBlock {
  show: boolean;
  count: number;
}
export interface LandingConfig {
  categories: LandingBlock;
  farmers: LandingBlock;
  latest: LandingBlock;
}

export const getLanding = () => apiFetch<{ landing: LandingConfig }>('tenants/me/landing');

export const updateLanding = (landing: LandingConfig) =>
  apiFetch<{ landing: LandingConfig }>(
    'tenants/me/landing',
    { method: 'PATCH', ...json(landing) },
    'Неуспешна промяна',
  );
```

- [ ] **Step 2: Create the card**

`client/src/components/settings/landing-card.tsx`:

```tsx
'use client';

/**
 * Settings → начална страница. Lets the farm choose which of the three dynamic
 * home blocks (категории / фермери / най-актуални) appear on the storefront home
 * and how many items each shows. Stored in settings.landing via PATCH
 * /tenants/me/landing; the chaika storefront reads the resolved config.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { SaveBar } from '@/components/panels/panel-ui';
import {
  ApiError,
  getLanding,
  updateLanding,
  getTenant,
  type LandingConfig,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

type BlockKey = 'categories' | 'farmers' | 'latest';

const ROWS: { key: BlockKey; title: string; desc: string; allowAll: boolean }[] = [
  { key: 'categories', title: 'Категории', desc: 'Плочки „Какво ще намериш“.', allowAll: true },
  { key: 'farmers', title: 'Фермери', desc: 'Блок „Запознай се с фермерите“.', allowAll: false },
  { key: 'latest', title: 'Най-актуални', desc: 'Блок „Най-актуални предложения“.', allowAll: false },
];

const same = (a: LandingConfig, b: LandingConfig) => JSON.stringify(a) === JSON.stringify(b);

export function LandingCard() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [multiFarmer, setMultiFarmer] = React.useState(true);
  const [saved, setSaved] = React.useState<LandingConfig | null>(null);
  const [cfg, setCfg] = React.useState<LandingConfig | null>(null);

  React.useEffect(() => {
    let active = true;
    Promise.all([getLanding(), getTenant()])
      .then(([l, t]) => {
        if (!active) return;
        setSaved(l.landing);
        setCfg(l.landing);
        setMultiFarmer(Boolean(t.multiFarmer));
      })
      .catch(() => active && toast.error('Неуспешно зареждане на настройките'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const dirty = !!cfg && !!saved && !same(cfg, saved);

  const setShow = (key: BlockKey, show: boolean) =>
    setCfg((p) => (p ? { ...p, [key]: { ...p[key], show } } : p));
  const setCount = (key: BlockKey, count: number) =>
    setCfg((p) => (p ? { ...p, [key]: { ...p[key], count } } : p));

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      const { landing } = await updateLanding(cfg);
      setSaved(landing);
      setCfg(landing);
      toast.success('Началната страница е обновена');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className={cn(
        'rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm',
        dirty && 'mb-16',
      )}
    >
      <h2 className="text-[16px] font-extrabold">Начална страница</h2>
      <p className="mt-1 text-[13px] leading-snug text-ff-muted">
        Избери кои блокове да се показват на началната страница на магазина и колко неща да
        стоят във всеки. Останалите секции (заглавие, локация, бюлетин) остават непроменени.
      </p>

      {loading || !cfg ? (
        <div className="mt-5 text-[13.5px] text-ff-muted">Зареждане…</div>
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          {ROWS.map((row) => {
            const block = cfg[row.key];
            const farmersBlocked = row.key === 'farmers' && !multiFarmer;
            const on = block.show && !farmersBlocked;
            const opts = row.allowAll ? [0, ...range1to12] : range1to12;
            return (
              <div
                key={row.key}
                className={cn(
                  'rounded-xl border border-ff-border bg-ff-surface-2 px-[15px] py-3',
                  farmersBlocked && 'opacity-60',
                )}
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14.5px] font-extrabold text-ff-ink">{row.title}</div>
                    <div className="mt-0.5 text-[12.5px] leading-snug text-ff-muted">
                      {farmersBlocked ? 'Само при мулти-фермер режим.' : row.desc}
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={on}
                    disabled={farmersBlocked}
                    onChange={(v) => setShow(row.key, v)}
                  />
                </div>

                <div
                  className={cn(
                    'mt-3 flex items-center gap-2 transition-opacity',
                    (!on || farmersBlocked) && 'pointer-events-none opacity-45',
                  )}
                >
                  <label className="text-[12.5px] font-bold text-ff-ink-2">Брой:</label>
                  <select
                    value={block.count}
                    disabled={!on || farmersBlocked}
                    onChange={(e) => setCount(row.key, Number(e.target.value))}
                    className="rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13.5px] font-bold text-ff-ink"
                  >
                    {opts.map((n) => (
                      <option key={n} value={n}>
                        {n === 0 ? 'Всички' : n}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {dirty && (
        <SaveBar saving={saving} onSave={save} onDiscard={() => setCfg(saved)} />
      )}
    </section>
  );
}

const range1to12 = Array.from({ length: 12 }, (_, i) => i + 1);
```

- [ ] **Step 3: Register the section**

In `client/src/app/(admin)/settings/page.tsx`:

Add the import:

```tsx
import { LandingCard } from '@/components/settings/landing-card';
```

Extend the `Section` type and `SECTIONS` list:

```tsx
type Section = 'password' | 'nav' | 'landing';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'password', label: 'Смяна на парола' },
  { id: 'nav', label: 'Странична навигация' },
  { id: 'landing', label: 'Начална страница' },
];
```

Add the render branch (next to the others):

```tsx
            {section === 'landing' && <LandingCard />}
```

- [ ] **Step 4: Typecheck the admin**

Run: `cd client && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/api-client.ts client/src/components/settings/landing-card.tsx "client/src/app/(admin)/settings/page.tsx"
git commit -m "feat(admin): Начална страница settings card for landing blocks"
```

---

## Task 5: chaika storefront consumption

**Files:**
- Modify: `fermerski-pazar-chaika/src/lib/types.ts` (`Storefront` ~line 44)
- Modify: `fermerski-pazar-chaika/src/lib/api.ts` (`FALLBACK_STOREFRONT` ~line 159)
- Modify: `fermerski-pazar-chaika/src/pages/index.astro` (frontmatter + blocks at lines 133, 151, 171)

- [ ] **Step 1: Add `landing` to the `Storefront` type**

In `src/lib/types.ts`, inside `interface Storefront`, after `themeColor`:

```ts
  themeColor?: string | null;
  // Configurable landing blocks (settings.landing). Optional (older backend) →
  // index.astro falls back to DEFAULT_LANDING (all cats, 3 farmers, 4 latest).
  landing?: {
    categories: { show: boolean; count: number };
    farmers: { show: boolean; count: number };
    latest: { show: boolean; count: number };
  };
```

- [ ] **Step 2: Add `landing` to `FALLBACK_STOREFRONT`**

In `src/lib/api.ts`, inside the `FALLBACK_STOREFRONT` object, after `themeColor: null,`:

```ts
  themeColor: null,
  landing: {
    categories: { show: true, count: 0 },
    farmers: { show: true, count: 3 },
    latest: { show: true, count: 4 },
  },
```

- [ ] **Step 3: Gate the three blocks in `index.astro`**

In the frontmatter of `src/pages/index.astro`, replace the line:

```ts
const feat = featured(products, 4);
```

with:

```ts
const DEFAULT_LANDING = {
  categories: { show: true, count: 0 },
  farmers: { show: true, count: 3 },
  latest: { show: true, count: 4 },
};
const L = sf.landing ?? DEFAULT_LANDING;
const catList = L.categories.count > 0 ? cats.slice(0, L.categories.count) : cats;
const farmerList = farmers.slice(0, L.farmers.count);
const feat = featured(products, L.latest.count);
```

Replace the **categories** block opening (`index.astro:133`):

```astro
    {cats.length > 0 && (
```

with:

```astro
    {L.categories.show && catList.length > 0 && (
```

and the grid map inside it (`{cats.map((c) => <CategoryCard category={c} />)}`) with:

```astro
          {catList.map((c) => <CategoryCard category={c} />)}
```

Replace the **farmers** block opening (`index.astro:151`):

```astro
    {showFarmers && farmers.length > 0 && (
```

with:

```astro
    {L.farmers.show && showFarmers && farmerList.length > 0 && (
```

and its slice map (`{farmers.slice(0, 3).map((f) => (`) with:

```astro
            {farmerList.map((f) => (
```

Replace the **featured** block opening (`index.astro:171`):

```astro
    {seeded && (
```

with:

```astro
    {L.latest.show && seeded && (
```

(The `feat.map(...)` inside it is unchanged — `feat` now holds `featList`.)

> Note: the hero stat `{cats.length || 5}` (line 56) keeps using the full `cats` — it shows the total number of categories, not the landing cap.

- [ ] **Step 4: Typecheck chaika**

Run: `cd ../fermerski-pazar-chaika && npx astro check`
Expected: 0 errors (warnings about pre-existing unrelated code are fine).

- [ ] **Step 5: Commit (chaika repo)**

```bash
cd ../fermerski-pazar-chaika
git add src/lib/types.ts src/lib/api.ts src/pages/index.astro
git commit -m "feat: gate home blocks by configurable landing config"
```

---

## Final verification

- [ ] Server: `cd server && npx tsc --noEmit && npx jest` → all green.
- [ ] Admin: `cd client && npx tsc --noEmit && npm run build` → builds.
- [ ] Chaika: `cd fermerski-pazar-chaika && npx astro check && npm run build` → builds.
- [ ] Live E2E (manual): admin → Настройки → Начална страница → toggle each block + change counts → save → reload chaika home → blocks hide / counts change. Confirm farmers row is disabled when multiFarmer is off.

## Notes

- No DB migration — `settings` is existing jsonb.
- Back-compat: a tenant with no `settings.landing` resolves to `DEFAULT_LANDING`, which equals the current hardcoded behavior, so the live пазар is unchanged until edited.
- POTW is untouched — it keeps its own toggle on the Products page.
