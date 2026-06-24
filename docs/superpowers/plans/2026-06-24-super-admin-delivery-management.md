# Super-Admin Delivery Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the super-admin an admin-panel surface to see standalone delivery accounts (with shipment/COD overview), create accounts marked shop / delivery / both, enable delivery on an existing farm, and toggle the delivery service on/off — no impersonation, no `:3100` change, no DB migration.

**Architecture:** Capabilities are derived from `tenants.settings` (delivery = `settings.econtApp` present; active = `econtApp.active`; shop = `product !== 'econt-standalone'`). All backend lives in the main API's `platform` module against the shared Postgres. The admin Next.js app gets a new „Доставка" page mirroring the existing tenants page. Toggle reuses the existing `setEcontAppActive`.

**Tech Stack:** NestJS + Drizzle (server), Jest (server tests), Next.js 14 app-router + Tailwind + lucide + sonner (admin). Money is integer stotinki.

**Spec:** `docs/superpowers/specs/2026-06-24-super-admin-delivery-management-design.md`

**Conventions for every server task:**
- Typecheck: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
- Test one suite: `pnpm --filter @fermeribg/api exec jest <pattern> --silent`
- Lint: `pnpm --filter @fermeribg/api exec eslint "src/modules/platform/**/*.ts"`
- Admin build/typecheck: `pnpm --filter @fermeribg/admin build`

---

## File structure

| File | Responsibility |
|---|---|
| `server/src/modules/platform/delivery-accounts.helpers.ts` (+`.spec.ts`) | Pure `deliveryCapabilities` + `buildDeliveryOverview` |
| `server/src/modules/platform/platform.helpers.ts` (+`.spec.ts`) | Pure `farmDefaultSettings` (extracted from `createTenant`) |
| `server/src/modules/platform/dto/create-delivery-account.dto.ts` | Create-account DTO |
| `server/src/modules/platform/dto/set-delivery-active.dto.ts` | Toggle DTO |
| `server/src/modules/platform/platform.service.ts` | `listDeliveryAccounts`, `getDeliveryAccount`, `createDeliveryAccount`, `enableDeliveryOnFarm` (+ refactor `createTenant`/`createDemoTenant` to use `farmDefaultSettings`; add `deliveryAccount` to `tenantDetail`) |
| `server/src/modules/platform/platform.controller.ts` | 5 new routes under `/platform/delivery/*` |
| `admin/src/lib/api-client.ts` | Types + 5 client fns + `deliveryAccount` on `PlatformTenantDetail` |
| `admin/src/app/(panel)/delivery/page.tsx` | Server page (SSR first page) |
| `admin/src/components/delivery-accounts-client.tsx` | List table + toggle + create modal |
| `admin/src/components/panel-chrome.tsx` | „Доставка" nav item |
| `admin/src/components/tenant-detail-client.tsx` | „Включи доставка" button + flag |

---

## Task DM-1: Pure helpers — capabilities + overview

**Files:**
- Create: `server/src/modules/platform/delivery-accounts.helpers.ts`
- Test: `server/src/modules/platform/delivery-accounts.helpers.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { deliveryCapabilities, buildDeliveryOverview } from './delivery-accounts.helpers';

describe('deliveryCapabilities', () => {
  it('classifies delivery-only', () => {
    expect(deliveryCapabilities({ product: 'econt-standalone', econtApp: { active: true } }))
      .toEqual({ shop: false, delivery: true, active: true, type: 'delivery' });
  });
  it('classifies farm-only (no econtApp)', () => {
    expect(deliveryCapabilities({ delivery: {} }))
      .toEqual({ shop: true, delivery: false, active: false, type: 'farm' });
  });
  it('classifies both (farm + econtApp)', () => {
    expect(deliveryCapabilities({ econtApp: { active: false } }))
      .toEqual({ shop: true, delivery: true, active: false, type: 'both' });
  });
  it('tolerates null/undefined settings', () => {
    expect(deliveryCapabilities(null)).toEqual({ shop: true, delivery: false, active: false, type: 'farm' });
  });
});

describe('buildDeliveryOverview', () => {
  it('folds shipment rows into the overview shape', () => {
    const out = buildDeliveryOverview([
      { carrier: 'econt', codAmountStotinki: 1000, codCollectedAt: null, createdAt: '2026-06-01T10:00:00.000Z' },
      { carrier: 'econt', codAmountStotinki: 500, codCollectedAt: '2026-06-03T10:00:00.000Z', createdAt: '2026-06-02T10:00:00.000Z' },
      { carrier: 'speedy', codAmountStotinki: null, codCollectedAt: null, createdAt: '2026-06-05T10:00:00.000Z' },
    ]);
    expect(out).toEqual({
      total: 3,
      codPendingStotinki: 1000,
      codCollectedStotinki: 500,
      econt: 2,
      speedy: 1,
      lastShipmentAt: '2026-06-05T10:00:00.000Z',
    });
  });
  it('returns zeros for an empty list', () => {
    expect(buildDeliveryOverview([])).toEqual({
      total: 0, codPendingStotinki: 0, codCollectedStotinki: 0, econt: 0, speedy: 0, lastShipmentAt: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api exec jest delivery-accounts.helpers --silent`
Expected: FAIL — `Cannot find module './delivery-accounts.helpers'`.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface DeliveryCaps {
  shop: boolean;
  delivery: boolean;
  active: boolean;
  type: 'delivery' | 'farm' | 'both';
}

/** Derive a tenant's delivery/shop capabilities from its settings JSON. */
export function deliveryCapabilities(settings: unknown): DeliveryCaps {
  const s = (settings ?? {}) as Record<string, any>;
  const delivery = s.econtApp != null;
  const active = s.econtApp?.active === true;
  const shop = s.product !== 'econt-standalone';
  const type = delivery && shop ? 'both' : delivery ? 'delivery' : 'farm';
  return { shop, delivery, active, type };
}

export interface DeliveryOverview {
  total: number;
  codPendingStotinki: number;
  codCollectedStotinki: number;
  econt: number;
  speedy: number;
  lastShipmentAt: string | null;
}

export interface ShipmentLite {
  carrier: string | null;
  codAmountStotinki: number | null;
  codCollectedAt: Date | string | null;
  createdAt: Date | string | null;
}

/** Fold a tenant's shipments into the super-admin overview. COD "pending" = not yet
 *  collected from the recipient; "collected" = courier marked it collected. */
export function buildDeliveryOverview(rows: ShipmentLite[]): DeliveryOverview {
  let codPendingStotinki = 0;
  let codCollectedStotinki = 0;
  let econt = 0;
  let speedy = 0;
  let last = 0;
  for (const r of rows) {
    const cod = r.codAmountStotinki ?? 0;
    if (r.codCollectedAt) codCollectedStotinki += cod;
    else codPendingStotinki += cod;
    if (r.carrier === 'speedy') speedy++;
    else econt++;
    const ts = r.createdAt ? new Date(r.createdAt).getTime() : 0;
    if (ts > last) last = ts;
  }
  return {
    total: rows.length,
    codPendingStotinki,
    codCollectedStotinki,
    econt,
    speedy,
    lastShipmentAt: last ? new Date(last).toISOString() : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api exec jest delivery-accounts.helpers --silent`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/platform/delivery-accounts.helpers.ts server/src/modules/platform/delivery-accounts.helpers.spec.ts
git commit -m "feat(platform): pure delivery capability + overview helpers"
```

---

## Task DM-2: Extract `farmDefaultSettings` (refactor)

The default farm `settings` blob is duplicated inline in `createTenant` and `createDemoTenant`. Extract it so `createDeliveryAccount` can reuse it without drift. Behaviour-preserving — existing tests must stay green.

**Files:**
- Create: `server/src/modules/platform/platform.helpers.ts`
- Test: `server/src/modules/platform/platform.helpers.spec.ts`
- Modify: `server/src/modules/platform/platform.service.ts` (`createTenant` ~line 691-704, `createDemoTenant` ~line 755-767)

- [ ] **Step 1: Write the failing test**

```ts
import { farmDefaultSettings } from './platform.helpers';

describe('farmDefaultSettings', () => {
  it('returns the sellable-by-default farm settings (pickup + cod + card on, econt off)', () => {
    expect(farmDefaultSettings()).toEqual({
      delivery: {
        methods: {
          pickup: { enabled: true },
          ownSlots: { enabled: false },
          econtOffice: { enabled: false },
          econtAddress: { enabled: false },
        },
        cod: { enabled: true },
        card: { enabled: true },
        econt: { mode: 'off' },
      },
    });
  });
  it('adds the brand theme colour when provided', () => {
    expect(farmDefaultSettings('#3a7d2c').brand).toEqual({ themeColor: '#3a7d2c' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api exec jest platform.helpers --silent`
Expected: FAIL — `Cannot find module './platform.helpers'`.

- [ ] **Step 3: Write the helper**

```ts
/** Default `tenants.settings` for a sellable farm: market pickup + COD + card on,
 *  own slots and Econt off. `themeColor` (auto-extracted from a logo at onboarding)
 *  is stored under `brand` where the storefront + Контакти read it. */
export function farmDefaultSettings(themeColor?: string): Record<string, unknown> {
  return {
    ...(themeColor ? { brand: { themeColor } } : {}),
    delivery: {
      methods: {
        pickup: { enabled: true },
        ownSlots: { enabled: false },
        econtOffice: { enabled: false },
        econtAddress: { enabled: false },
      },
      cod: { enabled: true },
      card: { enabled: true },
      econt: { mode: 'off' },
    },
  };
}
```

- [ ] **Step 4: Refactor `createTenant` and `createDemoTenant` to use it**

In `platform.service.ts`, add the import at the top alongside the other local imports:

```ts
import { farmDefaultSettings } from './platform.helpers';
```

In `createTenant`, replace the inline `settings: { ...(dto.themeColor ? ... ) , delivery: {...} }` object with:

```ts
        settings: farmDefaultSettings(dto.themeColor),
```

In `createDemoTenant`, replace the inline `settings: { delivery: {...} }` object with:

```ts
        settings: farmDefaultSettings(),
```

- [ ] **Step 5: Run the helper test + the existing platform service tests**

Run: `pnpm --filter @fermeribg/api exec jest platform.helpers --silent`
Expected: PASS (2 tests).

Run: `pnpm --filter @fermeribg/api exec jest platform.service --silent`
Expected: PASS — `createTenant` / `createDemoTenant` tests unchanged and green.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/platform/platform.helpers.ts server/src/modules/platform/platform.helpers.spec.ts server/src/modules/platform/platform.service.ts
git commit -m "refactor(platform): extract farmDefaultSettings, reuse in create paths"
```

---

## Task DM-3: DTOs

**Files:**
- Create: `server/src/modules/platform/dto/create-delivery-account.dto.ts`
- Create: `server/src/modules/platform/dto/set-delivery-active.dto.ts`

- [ ] **Step 1: Write `create-delivery-account.dto.ts`**

```ts
import { IsEmail, IsString, MinLength, MaxLength, IsOptional, IsBoolean } from 'class-validator';

export class CreateDeliveryAccountDto {
  @IsEmail()
  email!: string;

  // Platform password floor of 12.
  @IsString() @MinLength(12) @MaxLength(128)
  password!: string;

  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  // Capabilities. At least one must be true (enforced in the service).
  @IsBoolean()
  shop!: boolean;

  @IsBoolean()
  delivery!: boolean;

  // Whether the delivery service starts enabled (paid gate). Defaults true.
  @IsOptional() @IsBoolean()
  active?: boolean;
}
```

- [ ] **Step 2: Write `set-delivery-active.dto.ts`**

```ts
import { IsBoolean } from 'class-validator';

export class SetDeliveryActiveDto {
  @IsBoolean()
  active!: boolean;
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/platform/dto/create-delivery-account.dto.ts server/src/modules/platform/dto/set-delivery-active.dto.ts
git commit -m "feat(platform): delivery-account DTOs"
```

---

## Task DM-4: Service — list + detail

**Files:**
- Modify: `server/src/modules/platform/platform.service.ts`
- Test: `server/src/modules/platform/platform.service.spec.ts`

- [ ] **Step 1: Add imports** (top of `platform.service.ts`)

Add `inArray` to the existing `drizzle-orm` import (it currently imports `and, asc, eq, sql, desc`):

```ts
import { and, asc, eq, sql, desc, inArray } from 'drizzle-orm';
```

Add below the existing helper imports:

```ts
import {
  deliveryCapabilities,
  buildDeliveryOverview,
  type DeliveryOverview,
} from './delivery-accounts.helpers';
```

Add these exported interfaces near `PlatformTenantRow` (top of the file, after the existing interfaces):

```ts
export interface DeliveryAccountRow {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  type: 'delivery' | 'farm' | 'both';
  active: boolean;
  createdAt: Date | null;
  overview: DeliveryOverview;
}

export interface DeliveryShipmentRow {
  id: string;
  carrier: string;
  status: string;
  codAmountStotinki: number | null;
  codCollectedAt: Date | null;
  createdAt: Date | null;
  trackingNumber: string | null;
  econtShipmentNumber: string | null;
}

export interface DeliveryAccountDetail extends DeliveryAccountRow {
  recentShipments: DeliveryShipmentRow[];
}
```

- [ ] **Step 2: Write the failing test** (append inside the `describe('PlatformService', …)` block in `platform.service.spec.ts`)

```ts
describe('listDeliveryAccounts', () => {
  it('returns delivery-capable tenants with a folded shipment overview', async () => {
    // page of tenants (where econtApp is not null)
    db.limit.mockResolvedValueOnce([
      { id: 't1', name: 'Дел Едно', slug: 'del-edno', email: 'a@x.bg', phone: null,
        settings: { product: 'econt-standalone', econtApp: { active: true } }, createdAt: new Date('2026-06-01') },
    ]);
    // shipments for the page's tenant ids (inArray)
    db.where.mockResolvedValueOnce([
      { tenantId: 't1', carrier: 'econt', codAmountStotinki: 1000, codCollectedAt: null, createdAt: new Date('2026-06-02') },
      { tenantId: 't1', carrier: 'speedy', codAmountStotinki: 500, codCollectedAt: new Date('2026-06-04'), createdAt: new Date('2026-06-03') },
    ]);

    const res = await service.listDeliveryAccounts({});
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ id: 't1', type: 'delivery', active: true });
    expect(res.items[0].overview).toEqual({
      total: 2, codPendingStotinki: 1000, codCollectedStotinki: 500, econt: 1, speedy: 1,
      lastShipmentAt: '2026-06-03T00:00:00.000Z',
    });
  });
});

describe('getDeliveryAccount', () => {
  it('404s when the tenant is not delivery-capable', async () => {
    db.limit.mockResolvedValueOnce([{ id: 't9', name: 'Ферма', slug: 'ferma', email: null, phone: null, settings: { delivery: {} }, createdAt: new Date() }]);
    await expect(service.getDeliveryAccount('t9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns overview + recent shipments for a delivery account', async () => {
    db.limit.mockResolvedValueOnce([{ id: 't1', name: 'Дел', slug: 'del', email: null, phone: null, settings: { econtApp: { active: true } }, createdAt: new Date('2026-06-01') }]);
    db.where.mockResolvedValueOnce([
      { id: 's1', carrier: 'econt', status: 'created', codAmountStotinki: 1000, codCollectedAt: null, createdAt: new Date('2026-06-02'), trackingNumber: null, econtShipmentNumber: 'E1' },
    ]);
    const res = await service.getDeliveryAccount('t1');
    expect(res.type).toBe('both');
    expect(res.overview.total).toBe(1);
    expect(res.recentShipments).toHaveLength(1);
  });
});
```

> Note on the mock DB: `db.select().from().where()` returns `db` (chainable). The terminal call differs per query — `.limit(n)` for the tenant page, `.where(...)` resolved directly for the `inArray` shipments query (no `.limit`/`.orderBy` after it). The mocks above resolve `db.limit` then `db.where` in call order. For `getDeliveryAccount`, fetch the tenant via `.limit(1)` and all its shipments via `.where(eq(...))` resolved directly, then sort + slice in JS.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api exec jest platform.service --silent -t "DeliveryAccount"`
Expected: FAIL — `service.listDeliveryAccounts is not a function`.

- [ ] **Step 4: Implement the two methods** (add to `PlatformService`)

```ts
  /** Super-admin list of delivery-capable tenants (those with an econtApp settings
   *  block), each with a folded shipment/COD overview. Keyset-paginated like
   *  listTenants. Not cached — single-operator, low-traffic, must reflect toggles
   *  immediately. One shipments query for the whole page (no N+1). */
  async listDeliveryAccounts(
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<Paginated<DeliveryAccountRow>> {
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const econtFilter = sql`${tenants.settings} -> 'econtApp' is not null`;
    const where = cur
      ? and(econtFilter, keysetAfter(tenants.createdAt, tenants.id, cur, 'asc'))
      : econtFilter;

    const rows = await this.db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        email: tenants.email,
        phone: tenants.phone,
        settings: tenants.settings,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(where)
      .orderBy(asc(tenants.createdAt), asc(tenants.id))
      .limit(lim + 1);

    const page = buildPage(rows, lim, (r) => ({ createdAt: r.createdAt!, id: r.id }));

    const ids = page.items.map((r) => r.id);
    const ship = ids.length
      ? await this.db
          .select({
            tenantId: shipments.tenantId,
            carrier: shipments.carrier,
            codAmountStotinki: shipments.codAmountStotinki,
            codCollectedAt: shipments.codCollectedAt,
            createdAt: shipments.createdAt,
          })
          .from(shipments)
          .where(inArray(shipments.tenantId, ids))
      : [];

    const byTenant = new Map<string, typeof ship>();
    for (const s of ship) {
      const arr = byTenant.get(s.tenantId) ?? [];
      arr.push(s);
      byTenant.set(s.tenantId, arr);
    }

    const items: DeliveryAccountRow[] = page.items.map((r) => {
      const caps = deliveryCapabilities(r.settings);
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        email: r.email,
        phone: r.phone,
        type: caps.type,
        active: caps.active,
        createdAt: r.createdAt,
        overview: buildDeliveryOverview(byTenant.get(r.id) ?? []),
      };
    });

    return { items, nextCursor: page.nextCursor };
  }

  /** One delivery account: overview over ALL its shipments + the last 20 for a
   *  read-only recent list. 404 if the tenant is missing or not delivery-capable. */
  async getDeliveryAccount(tenantId: string): Promise<DeliveryAccountDetail> {
    const [t] = await this.db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        email: tenants.email,
        phone: tenants.phone,
        settings: tenants.settings,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const caps = t ? deliveryCapabilities(t.settings) : null;
    if (!t || !caps?.delivery) throw new NotFoundException('Акаунтът не е намерен');

    const ship = await this.db
      .select({
        id: shipments.id,
        carrier: shipments.carrier,
        status: shipments.status,
        codAmountStotinki: shipments.codAmountStotinki,
        codCollectedAt: shipments.codCollectedAt,
        createdAt: shipments.createdAt,
        trackingNumber: shipments.trackingNumber,
        econtShipmentNumber: shipments.econtShipmentNumber,
      })
      .from(shipments)
      .where(eq(shipments.tenantId, tenantId));

    const recentShipments = [...ship]
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .slice(0, 20);

    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      email: t.email,
      phone: t.phone,
      type: caps.type,
      active: caps.active,
      createdAt: t.createdAt,
      overview: buildDeliveryOverview(ship),
      recentShipments,
    };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api exec jest platform.service --silent -t "DeliveryAccount"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/platform/platform.service.ts server/src/modules/platform/platform.service.spec.ts
git commit -m "feat(platform): list + detail delivery accounts with overview"
```

---

## Task DM-5: Service — create

**Files:**
- Modify: `server/src/modules/platform/platform.service.ts`
- Test: `server/src/modules/platform/platform.service.spec.ts`

- [ ] **Step 1: Add imports** (top of `platform.service.ts`)

```ts
import { econtTenantSettings, withEcontActive } from '../econt-app/econt-app.helpers';
```

(`withEcontActive` is already imported — extend the existing line to also import `econtTenantSettings` rather than duplicating.)

- [ ] **Step 2: Write the failing test** (append in the spec)

```ts
describe('createDeliveryAccount', () => {
  beforeEach(() => {
    (argon2.hash as jest.Mock).mockResolvedValue('hashed');
    db.limit.mockResolvedValue([]); // no email clash, slug free
    db.returning.mockResolvedValue([{ id: 'new1', name: 'Нов', slug: 'nov', email: 'n@x.bg' }]);
  });

  it('rejects when neither role is selected', async () => {
    await expect(
      service.createDeliveryAccount({ email: 'a@x.bg', password: 'longenough12', name: 'X', shop: false, delivery: false }),
    ).rejects.toMatchObject({ message: 'Изберете поне една роля' });
  });

  it('rejects a duplicate email', async () => {
    db.limit.mockResolvedValueOnce([{ id: 'u' }]); // email exists
    await expect(
      service.createDeliveryAccount({ email: 'a@x.bg', password: 'longenough12', name: 'X', shop: true, delivery: false }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a delivery-only account with econt-standalone settings', async () => {
    await service.createDeliveryAccount({ email: 'd@x.bg', password: 'longenough12', name: 'Дел', shop: false, delivery: true, active: true });
    const settings = db.values.mock.calls[0][0].settings;
    expect(settings.product).toBe('econt-standalone');
    expect(settings.econtApp).toEqual({ active: true });
    expect(db.values.mock.calls[0][0].deliveryEnabled).toBe(false);
  });

  it('creates a both account: farm settings + econtApp', async () => {
    await service.createDeliveryAccount({ email: 'b@x.bg', password: 'longenough12', name: 'Двете', shop: true, delivery: true, active: false });
    const settings = db.values.mock.calls[0][0].settings;
    expect(settings.product).toBeUndefined();
    expect(settings.delivery).toBeDefined();
    expect(settings.econtApp).toEqual({ active: false });
    expect(db.values.mock.calls[0][0].deliveryEnabled).toBe(true);
  });

  it('echoes the chosen password once', async () => {
    const res = await service.createDeliveryAccount({ email: 's@x.bg', password: 'longenough12', name: 'Само', shop: true, delivery: false });
    expect(res.password).toBe('longenough12');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api exec jest platform.service --silent -t "createDeliveryAccount"`
Expected: FAIL — `service.createDeliveryAccount is not a function`.

- [ ] **Step 4: Implement** (add to `PlatformService`; `CreateDeliveryAccountDto` import goes with the other DTO imports)

```ts
  /** Super-admin-driven account creation. Capabilities pick the settings shape:
   *  delivery-only → econt-standalone; shop-only → farm; both → farm + econtApp.
   *  One admin user with a known password (no forced change) so the operator can
   *  log into the delivery app. Returns the password ONCE. */
  async createDeliveryAccount(
    dto: CreateDeliveryAccountDto,
  ): Promise<{ id: string; name: string; slug: string; email: string; password: string }> {
    if (!dto.shop && !dto.delivery) throw new BadRequestException('Изберете поне една роля');

    const email = dto.email.trim().toLowerCase();
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (existing.length) throw new ConflictException('Имейлът вече е зает');

    const slug = await this.uniqueSlug(dto.name);
    const active = dto.active !== false; // default true

    let settings: Record<string, unknown>;
    if (dto.delivery && !dto.shop) settings = withEcontActive(econtTenantSettings(), active);
    else if (dto.shop && !dto.delivery) settings = farmDefaultSettings();
    else settings = { ...farmDefaultSettings(), econtApp: { active } };

    const [tenant] = await this.db
      .insert(tenants)
      .values({
        name: dto.name,
        slug,
        phone: dto.phone,
        email,
        subscriptionStatus: 'active',
        subscriptionSince: new Date(),
        // Storefront delivery toggle only matters for shop accounts.
        deliveryEnabled: dto.shop,
        settings,
      })
      .returning();

    await this.db.insert(users).values({
      tenantId: tenant.id,
      email,
      passwordHash: await argon2.hash(dto.password),
      role: 'admin',
      mustChangePassword: false,
    });

    return { id: tenant.id, name: tenant.name, slug: tenant.slug, email: tenant.email ?? email, password: dto.password };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api exec jest platform.service --silent -t "createDeliveryAccount"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/platform/platform.service.ts server/src/modules/platform/platform.service.spec.ts
git commit -m "feat(platform): createDeliveryAccount (shop/delivery/both)"
```

---

## Task DM-6: Service — enable delivery on an existing farm

**Files:**
- Modify: `server/src/modules/platform/platform.service.ts`
- Test: `server/src/modules/platform/platform.service.spec.ts`

- [ ] **Step 1: Write the failing test** (append in the spec)

```ts
describe('enableDeliveryOnFarm', () => {
  it('404s for a missing tenant', async () => {
    db.limit.mockResolvedValueOnce([]);
    await expect(service.enableDeliveryOnFarm('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('merges econtApp into an existing farm additively', async () => {
    db.limit.mockResolvedValueOnce([{ id: 'f1', settings: { delivery: { cod: { enabled: true } } } }]);
    const res = await service.enableDeliveryOnFarm('f1');
    expect(res).toEqual({ id: 'f1', delivery: true });
    const written = db.set.mock.calls[0][0].settings;
    expect(written.delivery).toEqual({ cod: { enabled: true } }); // kept
    expect(written.econtApp).toEqual({ active: true }); // added
  });

  it('is idempotent when delivery is already enabled (no write)', async () => {
    db.limit.mockResolvedValueOnce([{ id: 'f2', settings: { econtApp: { active: false } } }]);
    const res = await service.enableDeliveryOnFarm('f2');
    expect(res).toEqual({ id: 'f2', delivery: true });
    expect(db.set).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api exec jest platform.service --silent -t "enableDeliveryOnFarm"`
Expected: FAIL — `service.enableDeliveryOnFarm is not a function`.

- [ ] **Step 3: Implement** (add to `PlatformService`)

```ts
  /** "Link" an existing farm to the delivery service by merging an econtApp block
   *  into its settings (additive — all farm keys preserved). Idempotent. */
  async enableDeliveryOnFarm(tenantId: string): Promise<{ id: string; delivery: true }> {
    const [t] = await this.db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!t) throw new NotFoundException('Фермата не е намерена');

    const s = (t.settings ?? {}) as Record<string, any>;
    if (s.econtApp == null) {
      await this.db
        .update(tenants)
        .set({ settings: { ...s, econtApp: { active: true } } })
        .where(eq(tenants.id, tenantId));
    }
    return { id: tenantId, delivery: true };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api exec jest platform.service --silent -t "enableDeliveryOnFarm"`
Expected: PASS.

- [ ] **Step 5: Add `deliveryAccount` to the `tenantDetail` return** — in `platform.service.ts` find the `tenantDetail` method's return object where `econtConfigured` is computed (around line 418-419 `const econtConfigured = ...; return { ... econtConfigured, ... }`). Add a derived field next to it:

```ts
    const econtConfigured = !!settings?.delivery?.econt?.configured;
    const deliveryAccount = deliveryCapabilities(settings).delivery;
```

and in that same `return { ... }` add the property after `econtConfigured`:

```ts
      econtConfigured,
      deliveryAccount,
```

- [ ] **Step 6: Typecheck + run the full platform suite**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: exit 0.

Run: `pnpm --filter @fermeribg/api exec jest platform.service --silent`
Expected: PASS (all platform service tests).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/platform/platform.service.ts server/src/modules/platform/platform.service.spec.ts
git commit -m "feat(platform): enableDeliveryOnFarm + deliveryAccount flag on tenant detail"
```

---

## Task DM-7: Controller routes

**Files:**
- Modify: `server/src/modules/platform/platform.controller.ts`

- [ ] **Step 1: Add imports** (with the other DTO imports near the top)

```ts
import { CreateDeliveryAccountDto } from './dto/create-delivery-account.dto';
import { SetDeliveryActiveDto } from './dto/set-delivery-active.dto';
```

- [ ] **Step 2: Add the five routes** inside `PlatformController` (e.g. just after the existing `setEcontActive` method ~line 146)

```ts
  // ── Delivery accounts (standalone Econt/Speedy service oversight) ──
  @Get('delivery/accounts')
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listDeliveryAccounts(@Query() q: PaginationQueryDto) {
    return this.platform.listDeliveryAccounts({ cursor: q.cursor, limit: q.limit });
  }

  @Get('delivery/accounts/:tenantId')
  getDeliveryAccount(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.platform.getDeliveryAccount(tenantId);
  }

  @Post('delivery/accounts')
  @HttpCode(201)
  createDeliveryAccount(@Body() dto: CreateDeliveryAccountDto) {
    return this.platform.createDeliveryAccount(dto);
  }

  @Patch('delivery/accounts/:tenantId/active')
  setDeliveryActive(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: SetDeliveryActiveDto,
  ) {
    return this.platform.setEcontAppActive(tenantId, dto.active);
  }

  @Patch('delivery/accounts/:tenantId/enable-delivery')
  enableDelivery(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.platform.enableDeliveryOnFarm(tenantId);
  }
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: exit 0.

Run: `pnpm --filter @fermeribg/api exec eslint "src/modules/platform/**/*.ts"`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/platform/platform.controller.ts
git commit -m "feat(platform): /platform/delivery/* routes"
```

---

## Task DM-8: Admin api-client

**Files:**
- Modify: `admin/src/lib/api-client.ts`

- [ ] **Step 1: Add the `deliveryAccount` field to `PlatformTenantDetail`** — in the `PlatformTenantDetail` interface, after `econtConfigured: boolean;`:

```ts
  /** True when the farm also has the standalone delivery service enabled. */
  deliveryAccount: boolean;
```

- [ ] **Step 2: Append the delivery types + client functions** at the end of the file

```ts
// ── Delivery accounts (standalone Econt/Speedy service) ──
export interface DeliveryOverview {
  total: number;
  codPendingStotinki: number;
  codCollectedStotinki: number;
  econt: number;
  speedy: number;
  lastShipmentAt: string | null;
}

export interface DeliveryAccount {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  type: 'delivery' | 'farm' | 'both';
  active: boolean;
  createdAt: string | null;
  overview: DeliveryOverview;
}

export interface DeliveryShipment {
  id: string;
  carrier: string;
  status: string;
  codAmountStotinki: number | null;
  codCollectedAt: string | null;
  createdAt: string | null;
  trackingNumber: string | null;
  econtShipmentNumber: string | null;
}

export interface DeliveryAccountDetail extends DeliveryAccount {
  recentShipments: DeliveryShipment[];
}

export const listDeliveryAccounts = (cursor?: string) =>
  apiFetch<Paginated<DeliveryAccount>>(
    `platform/delivery/accounts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );

export const getDeliveryAccount = (id: string) =>
  apiFetch<DeliveryAccountDetail>(`platform/delivery/accounts/${id}`);

export const createDeliveryAccount = (data: {
  email: string;
  password: string;
  name: string;
  phone?: string;
  shop: boolean;
  delivery: boolean;
  active: boolean;
}) =>
  apiFetch<{ id: string; name: string; slug: string; email: string; password: string }>(
    'platform/delivery/accounts',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    },
    'Неуспешно създаване на акаунт',
  );

export const setDeliveryActive = (id: string, active: boolean) =>
  apiFetch<{ id: string; active: boolean }>(
    `platform/delivery/accounts/${id}/active`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active }),
    },
    'Неуспешна промяна на услугата',
  );

export const enableDeliveryOnFarm = (id: string) =>
  apiFetch<{ id: string; delivery: boolean }>(
    `platform/delivery/accounts/${id}/enable-delivery`,
    { method: 'PATCH' },
    'Неуспешно включване на доставка',
  );
```

- [ ] **Step 3: Commit** (typecheck happens in the build at DM-12)

```bash
git add admin/src/lib/api-client.ts
git commit -m "feat(admin): delivery-account api-client types + fns"
```

---

## Task DM-9: Admin nav + server page

**Files:**
- Modify: `admin/src/components/panel-chrome.tsx`
- Create: `admin/src/app/(panel)/delivery/page.tsx`

- [ ] **Step 1: Add the nav item** — in `panel-chrome.tsx` add `Truck` to the lucide import:

```ts
import { Leaf, LogOut, Settings, Users, Mail, CreditCard, LineChart, Truck } from 'lucide-react';
```

and add a link right after the „Фермери" link:

```tsx
          <Link href="/delivery" className={NAV_LINK}>
            <Truck size={17} /> <span className="max-sm:hidden">Доставка</span>
          </Link>
```

- [ ] **Step 2: Create the server page** `admin/src/app/(panel)/delivery/page.tsx`

```tsx
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { DeliveryAccountsClient } from '@/components/delivery-accounts-client';
import type { Paginated, DeliveryAccount } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY: Paginated<DeliveryAccount> = { items: [], nextCursor: null };

async function getAccounts(): Promise<Paginated<DeliveryAccount>> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/platform/delivery/accounts?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return EMPTY;
  return res.json();
}

export default async function DeliveryPage() {
  const initial = await getAccounts();
  return <DeliveryAccountsClient initial={initial} />;
}
```

- [ ] **Step 3: Commit** (the page imports the client built next; build runs at DM-12)

```bash
git add admin/src/components/panel-chrome.tsx "admin/src/app/(panel)/delivery/page.tsx"
git commit -m "feat(admin): Доставка nav + server page"
```

---

## Task DM-10: Admin delivery list client

**Files:**
- Create: `admin/src/components/delivery-accounts-client.tsx`

- [ ] **Step 1: Write the client component**

```tsx
'use client';

import { useState } from 'react';
import { Search, Plus, Truck, Store, Copy, Check, RefreshCw, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { cn, eur } from '@/lib/utils';
import {
  ApiError,
  listDeliveryAccounts,
  createDeliveryAccount,
  setDeliveryActive,
  type DeliveryAccount,
  type Paginated,
} from '@/lib/api-client';
import { usePaginatedList } from '@/hooks/use-paginated-list';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="relative shrink-0 rounded-full transition-colors disabled:opacity-50"
      style={{ width: 46, height: 26, padding: 3, background: on ? 'var(--ff-green-600)' : '#D9D2C2' }}
    >
      <span
        className="absolute rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-[left] duration-200"
        style={{ top: 3, left: on ? 23 : 3, width: 20, height: 20 }}
      />
    </button>
  );
}

function TypeBadges({ type }: { type: DeliveryAccount['type'] }) {
  const shop = type === 'farm' || type === 'both';
  const delivery = type === 'delivery' || type === 'both';
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {shop && (
        <span className="inline-flex items-center gap-1 rounded-full bg-ff-green-50 px-2 py-0.5 text-[12px] font-bold text-ff-green-700">
          <Store size={12} /> Магазин
        </span>
      )}
      {delivery && (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#EEF4FF] px-2 py-0.5 text-[12px] font-bold text-[#3457B1]">
          <Truck size={12} /> Доставка
        </span>
      )}
    </span>
  );
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  const rnd = new Uint32Array(14);
  crypto.getRandomValues(rnd);
  let p = '';
  for (let i = 0; i < rnd.length; i++) p += chars[rnd[i] % chars.length];
  return p;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}
      className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[12.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
    >
      {copied ? <Check size={13} className="text-ff-green-600" /> : <Copy size={13} />}
      {copied ? 'Копирано' : 'Копирай'}
    </button>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (a: DeliveryAccount) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [shop, setShop] = useState(false);
  const [delivery, setDelivery] = useState(true);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [created, setCreated] = useState<{ name: string; email: string; password: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || password.length < 12) { setErr('Попълнете име, имейл и парола (поне 12 знака).'); return; }
    if (!shop && !delivery) { setErr('Изберете поне една роля.'); return; }
    setErr(''); setBusy(true);
    try {
      const res = await createDeliveryAccount({ name: name.trim(), email: email.trim(), password, phone: phone.trim() || undefined, shop, delivery, active });
      onCreated({
        id: res.id, name: res.name, slug: res.slug, email: res.email, phone: phone.trim() || null,
        type: shop && delivery ? 'both' : delivery ? 'delivery' : 'farm',
        active, createdAt: new Date().toISOString(),
        overview: { total: 0, codPendingStotinki: 0, codCollectedStotinki: 0, econt: 0, speedy: 0, lastShipmentAt: null },
      });
      setCreated({ name: res.name, email: res.email, password: res.password });
      toast.success(`Акаунтът "${res.name}" е създаден`);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.4)]" onClick={onClose} />
      <div className="animate-ff-pop fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg">
        {!created ? (
          <>
            <h2 className="mb-4 text-[17px] font-extrabold">Нов акаунт за доставка</h2>
            <form onSubmit={submit} className="flex flex-col gap-3.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Име *</span>
                <input value={name} onChange={(e) => setName(e.target.value)} required className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Имейл *</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Парола *</span>
                <div className="flex gap-2">
                  <input value={password} onChange={(e) => setPassword(e.target.value)} required className="h-10 flex-1 rounded-xl border border-ff-border bg-ff-bg px-3 font-mono text-[13.5px] outline-none focus:border-ff-green-500" />
                  <button type="button" onClick={() => setPassword(generatePassword())} className="inline-flex items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface-2 px-3 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface">
                    <RefreshCw size={13} /> Генерирай
                  </button>
                </div>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Телефон</span>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500" />
              </label>
              <div className="flex flex-wrap gap-4 rounded-xl border border-ff-border bg-ff-surface-2 p-3">
                <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={shop} onChange={(e) => setShop(e.target.checked)} /> Магазин</label>
                <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={delivery} onChange={(e) => setDelivery(e.target.checked)} /> Доставка</label>
                <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Активен</label>
              </div>
              {err && <p className="text-[13px] text-ff-red">{err}</p>}
              <div className="mt-1 flex justify-end gap-2.5">
                <button type="button" onClick={onClose} className="rounded-xl border border-ff-border bg-ff-surface px-4 py-2.5 text-[13.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2">Откажи</button>
                <button type="submit" disabled={busy} className="rounded-xl bg-ff-green-700 px-4 py-2.5 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60">{busy ? 'Създаване…' : 'Създай'}</button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="mb-3 flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-ff-green-50 text-ff-green-700"><Check size={20} /></span>
              <div>
                <h2 className="text-[17px] font-extrabold">Акаунтът е създаден</h2>
                <p className="mt-0.5 text-[13.5px] text-ff-ink-2"><strong>{created.name}</strong> — данните за вход в приложението за доставка. Показват се само сега.</p>
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-2.5">
              <div className="rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
                <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">Имейл</p>
                <div className="flex items-center gap-2.5"><code className="flex-1 break-all font-mono text-[14px] font-bold">{created.email}</code><CopyButton text={created.email} /></div>
              </div>
              <div className="rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
                <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">Парола</p>
                <div className="flex items-center gap-2.5"><code className="flex-1 break-all font-mono text-[15px] font-bold">{created.password}</code><CopyButton text={created.password} /></div>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={onClose} className="rounded-xl bg-ff-green-700 px-4 py-2.5 text-[13.5px] font-bold text-white hover:brightness-95">Затвори</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export function DeliveryAccountsClient({ initial }: { initial: Paginated<DeliveryAccount> }) {
  const { items, setItems, loadMore, hasMore, loading } = usePaginatedList<DeliveryAccount>(initial, listDeliveryAccounts);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const needle = q.trim().toLowerCase();
  const rows = items.filter((a) => !needle || a.name.toLowerCase().includes(needle) || (a.email ?? '').toLowerCase().includes(needle) || a.slug.toLowerCase().includes(needle));

  async function toggle(a: DeliveryAccount, next: boolean) {
    setBusyId(a.id);
    setItems((p) => p.map((x) => (x.id === a.id ? { ...x, active: next } : x)));
    try {
      await setDeliveryActive(a.id, next);
      toast.success(next ? `${a.name}: услугата е включена` : `${a.name}: услугата е спряна`);
    } catch (e) {
      setItems((p) => p.map((x) => (x.id === a.id ? { ...x, active: !next } : x)));
      toast.error(errMsg(e));
    } finally { setBusyId(null); }
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Доставка</h1>
          <p className="mt-0.5 text-[13.5px] text-ff-muted">{items.length} {items.length === 1 ? 'акаунт' : 'акаунта'}</p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="relative w-[280px] max-[560px]:w-full">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ff-muted"><Search size={18} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Търси по име, имейл или slug…" className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface pl-11 pr-3 text-[14.5px] shadow-ff-sm outline-none focus:border-ff-green-500" />
          </div>
          <button onClick={() => setShowAdd(true)} className="inline-flex h-11 items-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white shadow-ff-sm hover:brightness-95">
            <Plus size={17} /> Нов акаунт
          </button>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        {/* desktop */}
        <table className="w-full border-collapse max-[860px]:hidden">
          <thead>
            <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
              {['Акаунт', 'Тип', 'Пратки', 'Наложен платеж', 'Последна', 'Услуга'].map((h) => (
                <th key={h} className="px-5 py-3.5 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-b border-ff-border-2 last:border-0">
                <td className="px-5 py-3.5">
                  <div className="text-[14.5px] font-bold text-ff-ink">{a.name}</div>
                  <div className="text-xs text-ff-muted-2">{a.email ?? '—'} · /{a.slug}</div>
                </td>
                <td className="px-5 py-3.5"><TypeBadges type={a.type} /></td>
                <td className="ff-fig px-5 py-3.5 text-[14px] font-bold">
                  {a.overview.total}
                  <span className="ml-1 text-[11.5px] font-normal text-ff-muted">({a.overview.econt}E·{a.overview.speedy}S)</span>
                </td>
                <td className="ff-fig px-5 py-3.5 text-[13px] text-ff-ink-2 whitespace-nowrap">
                  <span title="Чака">{eur(a.overview.codPendingStotinki)}</span>
                  <span className="text-ff-muted"> · </span>
                  <span className="text-ff-green-700" title="Събрано">{eur(a.overview.codCollectedStotinki)}</span>
                </td>
                <td className="ff-fig px-5 py-3.5 text-[13px] text-ff-ink-2 whitespace-nowrap">{fmtDate(a.overview.lastShipmentAt)}</td>
                <td className="px-5 py-3.5"><Toggle on={a.active} disabled={busyId === a.id} onChange={(v) => toggle(a, v)} /></td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* mobile cards */}
        <div className="hidden flex-col max-[860px]:flex">
          {rows.map((a) => (
            <div key={a.id} className="flex flex-col gap-2.5 border-b border-ff-border-2 px-4 py-3.5 last:border-0">
              <div className="flex items-start justify-between gap-2.5">
                <div className="min-w-0">
                  <div className="text-[15.5px] font-extrabold text-ff-ink">{a.name}</div>
                  <div className="text-[12.5px] text-ff-muted">{a.email ?? '—'}</div>
                  <div className="mt-1"><TypeBadges type={a.type} /></div>
                </div>
                <Toggle on={a.active} disabled={busyId === a.id} onChange={(v) => toggle(a, v)} />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ff-muted">
                <span>Пратки: <b className="ff-fig text-ff-ink-2">{a.overview.total}</b></span>
                <span>Чака: <span className="ff-fig text-ff-ink-2">{eur(a.overview.codPendingStotinki)}</span></span>
                <span>Събрано: <span className="ff-fig text-ff-green-700">{eur(a.overview.codCollectedStotinki)}</span></span>
                <span>Последна: <span className="ff-fig text-ff-ink-2">{fmtDate(a.overview.lastShipmentAt)}</span></span>
              </div>
            </div>
          ))}
        </div>

        {rows.length === 0 && <p className="px-5 py-12 text-center text-sm text-ff-muted">{needle ? 'Няма намерени акаунти.' : 'Все още няма акаунти за доставка.'}</p>}
      </div>

      {hasMore && (
        <div className="mt-5 flex justify-center">
          <button onClick={loadMore} disabled={loading} className="rounded-xl border border-ff-border bg-ff-surface px-5 py-2.5 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60">
            {loading ? 'Зареждане…' : 'Зареди още'}
          </button>
        </div>
      )}

      {showAdd && <CreateDialog onClose={() => setShowAdd(false)} onCreated={(a) => setItems((p) => [a, ...p])} />}
    </div>
  );
}
```

- [ ] **Step 2: Commit** (build verified at DM-12)

```bash
git add admin/src/components/delivery-accounts-client.tsx
git commit -m "feat(admin): delivery accounts list + create modal"
```

---

## Task DM-11: „Включи доставка" on the farm detail page

**Files:**
- Modify: `admin/src/components/tenant-detail-client.tsx`

- [ ] **Step 1: Extend imports** — add `Truck` is already imported; add the api fn + toast:

At the top, add:

```ts
import { toast } from 'sonner';
import { enableDeliveryOnFarm } from '@/lib/api-client';
```

- [ ] **Step 2: Add local state + handler** — inside `TenantDetailClient`, after the existing `const [saving, setSaving] = useState(false);` line:

```ts
  const [enabling, setEnabling] = useState(false);
  const [deliveryOn, setDeliveryOn] = useState(d.deliveryAccount);

  async function enableDelivery() {
    setEnabling(true);
    try {
      await enableDeliveryOnFarm(d.id);
      setDeliveryOn(true);
      toast.success(`${d.name}: доставката е включена`);
    } catch {
      toast.error('Неуспешно включване на доставка');
    } finally {
      setEnabling(false);
    }
  }
```

- [ ] **Step 3: Show a delivery flag + enable button** — in the flags row (the `<div className="flex flex-wrap justify-end gap-2">` that holds the `Flag` components), add a delivery-account flag after the „Доставка" `Flag`:

```tsx
            <Flag on={deliveryOn} label="Доставка акаунт" icon={<Truck size={13} />} />
```

Then, in the right-hand actions column (the `<div className="flex flex-col items-end gap-2.5">`, after the „Редактирай" button block), add:

```tsx
          {!deliveryOn && (
            <button
              type="button"
              onClick={enableDelivery}
              disabled={enabling}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-3 py-1.5 text-[13px] font-bold text-[#3457B1] shadow-ff-sm hover:bg-[#EEF4FF] disabled:opacity-60"
            >
              <Truck size={14} /> {enabling ? 'Включване…' : 'Включи доставка'}
            </button>
          )}
```

- [ ] **Step 4: Commit** (build verified at DM-12)

```bash
git add admin/src/components/tenant-detail-client.tsx
git commit -m "feat(admin): enable delivery on an existing farm from its detail page"
```

---

## Task DM-12: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Server typecheck**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 2: Server lint**

Run: `pnpm --filter @fermeribg/api exec eslint "src/modules/platform/**/*.ts"`
Expected: exit 0.

- [ ] **Step 3: Full server test suite**

Run: `pnpm --filter @fermeribg/api exec jest --silent`
Expected: all suites pass (prior count + the new delivery/helpers/service tests).

- [ ] **Step 4: Admin build (typechecks + compiles the new page/client)**

Run: `pnpm --filter @fermeribg/admin build`
Expected: build succeeds, no type errors.

- [ ] **Step 5: Boot smoke (main API)** — the new routes live on the main API, not `:3100`. Build + boot it against local Postgres (note the local `.env` `DATABASE_URL` password is stale `farmflow`; the real one is `fermeribg`):

Run:
```bash
pnpm --filter @fermeribg/api build
DATABASE_URL="postgresql://farmflow:fermeribg@localhost:5433/farmflow" node server/dist/main.js
```
Then in another shell, confirm the route is mounted + guarded (no platform token → 401):
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/platform/delivery/accounts
```
Expected: `401` (guard active, route exists). Stop the server afterwards.

- [ ] **Step 6: Commit any verification fixups, then report green**

```bash
git add -A
git commit -m "chore(platform): delivery management — verification green" || echo "nothing to commit"
```

---

## Self-review checklist (run before handing off)

- **Spec coverage:** list/get/create/toggle/enable-on-farm → DM-4/DM-5/DM-7/DM-6; capabilities + overview helpers → DM-1; admin view + create + toggle → DM-9/DM-10; enable-on-farm UI → DM-11; no migration, no `:3100` change → respected throughout.
- **Type consistency:** `DeliveryAccount`/`DeliveryOverview`/`DeliveryAccountDetail` identical between server (`platform.service.ts`) and admin (`api-client.ts`); `deliveryCapabilities` shape `{ shop, delivery, active, type }` used uniformly; `setEcontAppActive` reused for the toggle.
- **Money:** all amounts stotinki; `eur()` formats for display only.
- **Security:** every route under `PlatformAdminGuard`; argon2 hash; password echoed once; no impersonation.
