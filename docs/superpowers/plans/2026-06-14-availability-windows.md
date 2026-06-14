# „Задай наличност" — Time-Bounded Availability Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a farmer declare time-bounded availability (от–до date range + quantity) per existing product; while a window is active it is the single source of truth for that product's stock (catalog + a new „Налично сега" storefront section), depletes on order, and blocks at 0.

**Architecture:** A new 1:N table `product_availability_windows` overlays existing `products`. A pure resolver picks the one active window for a product (`bgToday()` within `[starts_at, ends_at]`). Checkout decrements the active window's `remaining` under a row lock, mirroring the existing delivery-slot capacity pattern. The static `products.stock_quantity` field is left completely untouched (it stays dormant/unenforced as today). A new opt-in tenant toggle gates the storefront section.

**Tech Stack:** NestJS + Drizzle ORM (Postgres), class-validator DTOs, Jest (server). Next.js admin (`client/`) + Next.js storefront (`storefront/`). Monorepo with pnpm workspaces; `@farmflow/db` and `@farmflow/types` are consumed via their built `dist/`.

**Scope note:** This plan covers the FarmFlow repo only (server + `client/` admin + `storefront/` Next consumer + db). The **live** storefront is the separate `fermerski-pazar-chaika` Astro repo; mirroring the section there is a documented follow-up (same public API contract) — see Task 16.

---

## File Structure

**Create:**
- `server/src/modules/availability/availability.util.ts` — pure helpers (active window, overlap, quantity delta). No DB.
- `server/src/modules/availability/availability.util.spec.ts` — unit tests for the helpers.
- `server/src/modules/availability/dto/create-window.dto.ts` — create DTO.
- `server/src/modules/availability/dto/update-window.dto.ts` — update DTO.
- `server/src/modules/availability/dto/create-window.dto.spec.ts` — DTO validation test.
- `server/src/modules/availability/availability.service.ts` — CRUD + public read + cache busting.
- `server/src/modules/availability/availability.service.spec.ts` — service tests (overlap reject, quantity delta, tenant scope).
- `server/src/modules/availability/availability.controller.ts` — farmer + public controllers.
- `server/src/modules/availability/availability.module.ts` — module wiring.
- `server/src/modules/orders/availability-checkout.spec.ts` — checkout decrement + 409 + restore-on-cancel tests.
- `client/src/app/(admin)/availability/page.tsx` — admin screen route.
- `client/src/components/availability/availability-client.tsx` — screen UI (list + editor).
- `client/src/components/availability/window-editor.tsx` — add/edit window modal.
- `storefront/src/components/availability-section.tsx` — storefront section (in-repo Next consumer).

**Modify:**
- `packages/db/src/schema.ts` — new table + 2 tenant columns.
- `packages/db/drizzle/` — generated migration (drizzle-kit).
- `packages/types/src/index.ts` — window types.
- `server/src/modules/orders/orders.service.ts` — decrement on create, restore on cancel.
- `server/src/modules/public-bootstrap/public-bootstrap.controller.ts` — add availability to the bundle.
- `server/src/modules/tenants/tenants.service.ts` — project toggle + title to `PublicStorefront`.
- `server/src/modules/tenants/dto/update-tenant.dto.ts` — `availabilitySectionEnabled` + `availabilityTitle`.
- `server/src/app.module.ts` — register `AvailabilityModule`.
- `client/src/lib/api-client.ts` — availability CRUD calls + types.
- `client/src/lib/types.ts` — `AvailabilityWindow` client type.
- `client/src/components/panels/features-panel.tsx` — toggle card + flag.
- `client/src/components/layout/sidebar.tsx` — nav item under „Каталог".
- `client/src/components/layout/topbar.tsx` — `PAGE_TITLES` entry.
- `client/src/lib/help-content.ts` + `client/src/app/(admin)/help/page.tsx` — help entry (name sync).
- `storefront/src/app/page.tsx` + `storefront/src/lib/api.ts` — render the section from bootstrap.

---

## Conventions (read before starting)

- **Run commands from the repo root** `C:\Users\Lenovo\source\repos\FarmFlow` unless stated. The package manager is **pnpm** (NOT npm); packages are `workspace:*`.
- After **any** change to `packages/db/src/schema.ts` or `packages/types/src/index.ts`, rebuild the dist the server consumes:
  ```bash
  pnpm --filter @farmflow/db build && pnpm --filter @farmflow/types build
  ```
- Server tests: `pnpm --filter @farmflow/server test -- <pattern>`. The `client/` app has **no Jest** — verify it with `pnpm --filter @farmflow/client build` / `tsc`.
- This machine flakes when Jest + Next build + the server run in parallel — **run them sequentially** (per project gotchas).
- Day logic uses `bgToday()` from `server/src/common/time/bg-time.ts` (Europe/Sofia). `date` columns compare correctly against its `'YYYY-MM-DD'` string.

---

## Task 1: Schema — table + tenant columns + migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create (generated): `packages/db/drizzle/00XX_*.sql`

- [ ] **Step 1: Add the two tenant columns**

In `packages/db/src/schema.ts`, in the `tenants` table, right after the `reviewsEnabled` column (around line 56), add:

```ts
  // Opt-in „Задай наличност" section: farmers declare time-bounded availability
  // windows per product. Default OFF (new feature, preserves existing storefronts).
  availabilitySectionEnabled: boolean('availability_section_enabled').notNull().default(false),
  // Optional storefront title for that section. NULL → the storefront default
  // („Налично сега").
  availabilityTitle: text('availability_title'),
```

- [ ] **Step 2: Add the `product_availability_windows` table**

In `packages/db/src/schema.ts`, after the `products` table definition (and its indexes), add:

```ts
export const productAvailabilityWindows = pgTable(
  'product_availability_windows',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    // Inclusive BG-local date range. day = from == to; week/month/several = wider.
    startsAt: date('starts_at').notNull(),
    endsAt: date('ends_at').notNull(),
    // `quantity` = the amount the farmer set; `remaining` decrements on each order
    // and blocks at 0. An active window's `remaining` is the product's real stock.
    quantity: integer('quantity').notNull(),
    remaining: integer('remaining').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // Active-window lookup: "this product's window covering today".
    productRangeIdx: index('paw_product_range_idx').on(t.productId, t.startsAt, t.endsAt),
    // Tenant-scoped admin list.
    tenantIdx: index('paw_tenant_idx').on(t.tenantId),
  }),
);
```

Ensure `date` is imported from `drizzle-orm/pg-core` at the top of the file (it already imports `integer`, `text`, `boolean`, `uuid`, `timestamp`, `index`, `jsonb`, `numeric`). If `date` is missing, add it to that import list.

- [ ] **Step 3: Generate the migration**

Run:
```bash
pnpm --filter @farmflow/db generate
```
Expected: a new file `packages/db/drizzle/00XX_<name>.sql` is created containing `CREATE TABLE "product_availability_windows" (...)`, the two indexes, the FK constraints (product FK `ON DELETE cascade`), and two `ALTER TABLE "tenants" ADD COLUMN` statements. The drizzle `meta/_journal.json` updates automatically.

- [ ] **Step 4: Sanity-check the generated SQL**

Open the new `packages/db/drizzle/00XX_*.sql` and confirm it contains:
- `CREATE TABLE "product_availability_windows"` with `starts_at date NOT NULL`, `ends_at date NOT NULL`, `quantity integer NOT NULL`, `remaining integer NOT NULL`.
- `ADD COLUMN "availability_section_enabled" boolean DEFAULT false NOT NULL`.
- `ADD COLUMN "availability_title" text`.

No manual edits needed unless a column is missing (then fix `schema.ts` and re-run generate).

- [ ] **Step 5: Build the db package**

Run:
```bash
pnpm --filter @farmflow/db build
```
Expected: PASS (tsc clean).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle
git commit -m "feat(db): availability windows table + tenant availability toggle/title"
```

---

## Task 2: Types — window shapes

**Files:**
- Modify: `packages/types/src/index.ts`

- [ ] **Step 1: Add the window types**

In `packages/types/src/index.ts`, add `productAvailabilityWindows` to the import block from `@farmflow/db` (the `import type { tenants, users, products, ... }` list), then add after the `PublicProduct` definition (around line 92):

```ts
export type AvailabilityWindow = InferSelectModel<typeof productAvailabilityWindows>;
export type NewAvailabilityWindow = InferInsertModel<typeof productAvailabilityWindows>;

/** Active-window overlay the storefront merges onto the public catalog by
 *  `productId`. `tenantId` stripped; only what the storefront needs. */
export type PublicAvailabilityWindow = {
  productId: string;
  startsAt: string;
  endsAt: string;
  quantity: number;
  remaining: number;
};
```

- [ ] **Step 2: Build the types package**

Run:
```bash
pnpm --filter @farmflow/db build && pnpm --filter @farmflow/types build
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/index.ts
git commit -m "feat(types): AvailabilityWindow + PublicAvailabilityWindow"
```

---

## Task 3: Pure helpers (TDD)

**Files:**
- Create: `server/src/modules/availability/availability.util.ts`
- Test: `server/src/modules/availability/availability.util.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/availability/availability.util.spec.ts`:

```ts
import { activeWindow, rangesOverlap, applyQuantityDelta } from './availability.util';

type W = { id: string; startsAt: string; endsAt: string; quantity: number; remaining: number };
const w = (id: string, startsAt: string, endsAt: string, remaining = 5, quantity = 5): W =>
  ({ id, startsAt, endsAt, quantity, remaining });

describe('activeWindow', () => {
  it('returns the window covering today (inclusive bounds)', () => {
    const list = [w('a', '2026-06-01', '2026-06-10'), w('b', '2026-06-14', '2026-06-20')];
    expect(activeWindow(list, '2026-06-14')?.id).toBe('b');
    expect(activeWindow(list, '2026-06-20')?.id).toBe('b');
    expect(activeWindow(list, '2026-06-01')?.id).toBe('a');
  });
  it('returns null when no window covers today', () => {
    expect(activeWindow([w('a', '2026-06-01', '2026-06-10')], '2026-06-13')).toBeNull();
  });
});

describe('rangesOverlap', () => {
  it('detects overlapping inclusive ranges', () => {
    expect(rangesOverlap('2026-06-01', '2026-06-10', '2026-06-10', '2026-06-12')).toBe(true);
    expect(rangesOverlap('2026-06-01', '2026-06-10', '2026-06-11', '2026-06-12')).toBe(false);
  });
});

describe('applyQuantityDelta', () => {
  it('shifts remaining by the quantity delta, floored at amount already sold', () => {
    // sold = quantity - remaining = 10 - 4 = 6. New quantity 8 → remaining 8-6 = 2.
    expect(applyQuantityDelta({ quantity: 10, remaining: 4 }, 8)).toBe(2);
    // Lowering below sold floors remaining at 0 (can't un-sell).
    expect(applyQuantityDelta({ quantity: 10, remaining: 4 }, 5)).toBe(0);
    // Raising quantity adds headroom.
    expect(applyQuantityDelta({ quantity: 10, remaining: 4 }, 15)).toBe(9);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/server test -- availability.util`
Expected: FAIL — `Cannot find module './availability.util'`.

- [ ] **Step 3: Implement the helpers**

Create `server/src/modules/availability/availability.util.ts`:

```ts
/** Pure availability-window math. No DB, no tz: callers pass `today` as a
 *  'YYYY-MM-DD' BG-local string (from bgToday()). `date` columns serialize to the
 *  same lexically-comparable format, so string comparison is correct. */

export interface WindowRange {
  startsAt: string;
  endsAt: string;
}

/** The single window whose inclusive [startsAt, endsAt] covers `today`, or null.
 *  Callers guarantee non-overlap, so at most one matches; this returns the first. */
export function activeWindow<T extends WindowRange>(windows: T[], today: string): T | null {
  return windows.find((w) => w.startsAt <= today && today <= w.endsAt) ?? null;
}

/** True when two inclusive date ranges share any day. */
export function rangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}

/** New `remaining` after a farmer edits a window's `quantity`. Preserves the
 *  amount already sold (`quantity - remaining`); floors at 0 so lowering quantity
 *  below what's sold can't produce a negative. */
export function applyQuantityDelta(
  w: { quantity: number; remaining: number },
  newQuantity: number,
): number {
  const sold = w.quantity - w.remaining;
  return Math.max(0, newQuantity - sold);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @farmflow/server test -- availability.util`
Expected: PASS (3 suites green).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/availability/availability.util.ts server/src/modules/availability/availability.util.spec.ts
git commit -m "feat(availability): pure window helpers (active/overlap/quantity-delta)"
```

---

## Task 4: DTOs

**Files:**
- Create: `server/src/modules/availability/dto/create-window.dto.ts`
- Create: `server/src/modules/availability/dto/update-window.dto.ts`
- Test: `server/src/modules/availability/dto/create-window.dto.spec.ts`

- [ ] **Step 1: Write the failing DTO test**

Create `server/src/modules/availability/dto/create-window.dto.spec.ts`:

```ts
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateWindowDto } from './create-window.dto';

const make = (over: Partial<CreateWindowDto>) =>
  plainToInstance(CreateWindowDto, {
    productId: '11111111-1111-1111-1111-111111111111',
    startsAt: '2026-06-14',
    endsAt: '2026-06-20',
    quantity: 10,
    ...over,
  });

describe('CreateWindowDto', () => {
  it('accepts a valid window', async () => {
    expect(await validate(make({}))).toHaveLength(0);
  });
  it('rejects a non-date startsAt', async () => {
    expect((await validate(make({ startsAt: 'nope' as any }))).length).toBeGreaterThan(0);
  });
  it('rejects quantity < 1', async () => {
    expect((await validate(make({ quantity: 0 }))).length).toBeGreaterThan(0);
  });
  it('rejects a non-uuid productId', async () => {
    expect((await validate(make({ productId: 'x' as any }))).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/server test -- create-window.dto`
Expected: FAIL — `Cannot find module './create-window.dto'`.

- [ ] **Step 3: Implement the DTOs**

Create `server/src/modules/availability/dto/create-window.dto.ts`:

```ts
import { IsInt, IsISO8601, IsUUID, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWindowDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  // Date-only ISO strings ('YYYY-MM-DD'). `strict` keeps them date-shaped.
  @ApiProperty({ example: '2026-06-14' })
  @IsISO8601({ strict: true })
  startsAt: string;

  @ApiProperty({ example: '2026-06-20' })
  @IsISO8601({ strict: true })
  endsAt: string;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(1)
  quantity: number;
}
```

Create `server/src/modules/availability/dto/update-window.dto.ts`:

```ts
import { IsInt, IsISO8601, IsOptional, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateWindowDto {
  @ApiPropertyOptional({ example: '2026-06-14' })
  @IsOptional()
  @IsISO8601({ strict: true })
  startsAt?: string;

  @ApiPropertyOptional({ example: '2026-06-20' })
  @IsOptional()
  @IsISO8601({ strict: true })
  endsAt?: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @farmflow/server test -- create-window.dto`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/availability/dto
git commit -m "feat(availability): create/update window DTOs"
```

---

## Task 5: AvailabilityService (CRUD + public read)

**Files:**
- Create: `server/src/modules/availability/availability.service.ts`
- Test: `server/src/modules/availability/availability.service.spec.ts`

- [ ] **Step 1: Write the failing service test**

Create `server/src/modules/availability/availability.service.spec.ts`. This test uses an in-memory fake `Database` thin enough to exercise overlap rejection and quantity-delta wiring without a live Postgres. Model it on the existing pure-logic service specs in the repo (e.g. `server/src/modules/farmers/farmers.reorder.spec.ts`) — but the cleanest seam here is to **extract the overlap check into the service and test it via a stubbed `db`**. Concretely:

```ts
import { ConflictException } from '@nestjs/common';
import { AvailabilityService } from './availability.service';

// Minimal db stub: only the calls create() makes, in order.
function makeDbReturning(existing: any[]) {
  return {
    // create(): select existing windows for the product, then insert.
    select: () => ({ from: () => ({ where: () => Promise.resolve(existing) }) }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'new' }]) }) }),
  } as any;
}

const cacheStub = { invalidate: async () => {} } as any;
const publicCacheStub = { del: async () => {}, resolveTenant: async () => ({ id: 't1' }), get: async () => null, set: async () => {} } as any;

describe('AvailabilityService.create overlap guard', () => {
  it('rejects a window overlapping an existing one for the same product', async () => {
    const db = makeDbReturning([
      { id: 'x', productId: 'p1', startsAt: '2026-06-10', endsAt: '2026-06-20' },
    ]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub);
    await expect(
      svc.create('t1', { productId: 'p1', startsAt: '2026-06-15', endsAt: '2026-06-25', quantity: 5 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows a non-overlapping window', async () => {
    const db = makeDbReturning([
      { id: 'x', productId: 'p1', startsAt: '2026-06-10', endsAt: '2026-06-20' },
    ]);
    const svc = new AvailabilityService(db, cacheStub, publicCacheStub);
    const row = await svc.create('t1', { productId: 'p1', startsAt: '2026-06-21', endsAt: '2026-06-25', quantity: 5 });
    expect(row).toEqual({ id: 'new' });
  });
});
```

> If the stub shape drifts from the real Drizzle chain used in the implementation, adjust the stub to match the exact calls `create()` makes (the test asserts behavior — overlap → 409, no overlap → insert — not the chain shape).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/server test -- availability.service`
Expected: FAIL — `Cannot find module './availability.service'`.

- [ ] **Step 3: Implement the service**

Create `server/src/modules/availability/availability.service.ts`:

```ts
import { Injectable, Inject, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { type Database, productAvailabilityWindows, products } from '@farmflow/db';
import type { AvailabilityWindow, PublicAvailabilityWindow } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { bgToday } from '../../common/time/bg-time';
import { CreateWindowDto } from './dto/create-window.dto';
import { UpdateWindowDto } from './dto/update-window.dto';
import { activeWindow, rangesOverlap, applyQuantityDelta } from './availability.util';

@Injectable()
export class AvailabilityService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly cache: CatalogCacheService,
    private readonly publicCache: PublicCacheService,
  ) {}

  /** All windows for the tenant (optionally one product), current + upcoming + past,
   *  ordered by start date. */
  list(tenantId: string, productId?: string): Promise<AvailabilityWindow[]> {
    const where = productId
      ? and(eq(productAvailabilityWindows.tenantId, tenantId), eq(productAvailabilityWindows.productId, productId))
      : eq(productAvailabilityWindows.tenantId, tenantId);
    return this.db
      .select()
      .from(productAvailabilityWindows)
      .where(where)
      .orderBy(asc(productAvailabilityWindows.startsAt));
  }

  async create(tenantId: string, dto: CreateWindowDto): Promise<AvailabilityWindow> {
    if (dto.endsAt < dto.startsAt) throw new BadRequestException('Крайната дата е преди началната');
    const existing = await this.db
      .select()
      .from(productAvailabilityWindows)
      .where(and(eq(productAvailabilityWindows.tenantId, tenantId), eq(productAvailabilityWindows.productId, dto.productId)));
    if (existing.some((w) => rangesOverlap(dto.startsAt, dto.endsAt, w.startsAt, w.endsAt))) {
      throw new ConflictException('Периодът се застъпва с друг за този продукт');
    }
    const [row] = await this.db
      .insert(productAvailabilityWindows)
      .values({
        tenantId,
        productId: dto.productId,
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
        quantity: dto.quantity,
        remaining: dto.quantity,
      })
      .returning();
    await this.bust(tenantId);
    return row;
  }

  async update(id: string, tenantId: string, dto: UpdateWindowDto): Promise<AvailabilityWindow> {
    const [cur] = await this.db
      .select()
      .from(productAvailabilityWindows)
      .where(and(eq(productAvailabilityWindows.id, id), eq(productAvailabilityWindows.tenantId, tenantId)))
      .limit(1);
    if (!cur) throw new NotFoundException('Периодът не е намерен');

    const startsAt = dto.startsAt ?? cur.startsAt;
    const endsAt = dto.endsAt ?? cur.endsAt;
    if (endsAt < startsAt) throw new BadRequestException('Крайната дата е преди началната');

    // Overlap check against the product's *other* windows.
    const siblings = await this.db
      .select()
      .from(productAvailabilityWindows)
      .where(and(eq(productAvailabilityWindows.tenantId, tenantId), eq(productAvailabilityWindows.productId, cur.productId!)));
    if (siblings.some((w) => w.id !== id && rangesOverlap(startsAt, endsAt, w.startsAt, w.endsAt))) {
      throw new ConflictException('Периодът се застъпва с друг за този продукт');
    }

    const quantity = dto.quantity ?? cur.quantity;
    const remaining = dto.quantity == null ? cur.remaining : applyQuantityDelta(cur, dto.quantity);

    const [row] = await this.db
      .update(productAvailabilityWindows)
      .set({ startsAt, endsAt, quantity, remaining })
      .where(and(eq(productAvailabilityWindows.id, id), eq(productAvailabilityWindows.tenantId, tenantId)))
      .returning();
    await this.bust(tenantId);
    return row;
  }

  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    const res = await this.db
      .delete(productAvailabilityWindows)
      .where(and(eq(productAvailabilityWindows.id, id), eq(productAvailabilityWindows.tenantId, tenantId)))
      .returning({ id: productAvailabilityWindows.id });
    if (!res.length) throw new NotFoundException('Периодът не е намерен');
    await this.bust(tenantId);
    return { id };
  }

  /** Active windows (today within range) for a storefront slug — the overlay the
   *  storefront merges onto the cached catalog by productId. Not long-cached:
   *  `remaining` is volatile (changes per order). */
  async findPublicActiveBySlug(slug: string): Promise<PublicAvailabilityWindow[]> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);
    const today = bgToday();
    const rows = await this.db
      .select()
      .from(productAvailabilityWindows)
      .where(eq(productAvailabilityWindows.tenantId, tenant.id));
    return rows
      .filter((w) => w.startsAt <= today && today <= w.endsAt)
      .map((w) => ({
        productId: w.productId!,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        quantity: w.quantity,
        remaining: w.remaining,
      }));
  }

  /** Busts the admin catalog cache (window changes affect nothing long-cached on
   *  the public side, but keep the admin catalog view fresh). */
  private async bust(tenantId: string): Promise<void> {
    await this.cache.invalidate(tenantId);
  }
}

// `activeWindow` is re-exported for callers that resolve a single product's window.
export { activeWindow };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @farmflow/server test -- availability.service`
Expected: PASS. If the db stub shape mismatches the real chain, align the stub (Step 1 note).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/availability/availability.service.ts server/src/modules/availability/availability.service.spec.ts
git commit -m "feat(availability): service CRUD + public active read + overlap guard"
```

---

## Task 6: Controllers + module + app wiring

**Files:**
- Create: `server/src/modules/availability/availability.controller.ts`
- Create: `server/src/modules/availability/availability.module.ts`
- Modify: `server/src/app.module.ts`

- [ ] **Step 1: Implement the controllers**

Create `server/src/modules/availability/availability.controller.ts`:

```ts
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AvailabilityService } from './availability.service';
import { CreateWindowDto } from './dto/create-window.dto';
import { UpdateWindowDto } from './dto/update-window.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('availability')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('availability-windows')
export class AvailabilityController {
  constructor(private readonly svc: AvailabilityService) {}

  @Get()
  list(@CurrentTenant() tenantId: string, @Query('productId') productId?: string) {
    return this.svc.list(tenantId, productId);
  }

  @Post()
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateWindowDto) {
    return this.svc.create(tenantId, dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @CurrentTenant() tenantId: string, @Body() dto: UpdateWindowDto) {
    return this.svc.update(id, tenantId, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.svc.remove(id, tenantId);
  }
}

@ApiTags('public')
@Controller('public/:slug/availability')
export class PublicAvailabilityController {
  constructor(private readonly svc: AvailabilityService) {}

  @Get()
  findPublic(@Param('slug') slug: string) {
    return this.svc.findPublicActiveBySlug(slug);
  }
}
```

- [ ] **Step 2: Implement the module**

Create `server/src/modules/availability/availability.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import { AvailabilityController, PublicAvailabilityController } from './availability.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';

@Module({
  imports: [CatalogCacheModule],
  controllers: [AvailabilityController, PublicAvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
```

> `PublicCacheService` is provided by the global `PublicCacheModule` (already imported app-wide); `DB_TOKEN` by `DrizzleModule`. Mirror `FarmersModule` (which imports only `CatalogCacheModule`). If Nest reports `PublicCacheService` can't be resolved, add `PublicCacheModule` to this module's `imports` (check how `FarmersModule` resolves it — it relies on the global provider).

- [ ] **Step 3: Register in app.module**

In `server/src/app.module.ts`, add the import near the other module imports:

```ts
import { AvailabilityModule } from './modules/availability/availability.module';
```

and add `AvailabilityModule` to the `imports: [...]` array (next to `ProductsModule` / `FarmersModule`).

- [ ] **Step 4: Build the server**

Run: `pnpm --filter @farmflow/server build`
Expected: PASS (Nest compiles, DI resolves).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/availability/availability.controller.ts server/src/modules/availability/availability.module.ts server/src/app.module.ts
git commit -m "feat(availability): controllers + module + app wiring"
```

---

## Task 7: Add availability to the public bootstrap bundle

**Files:**
- Modify: `server/src/modules/public-bootstrap/public-bootstrap.controller.ts`
- Modify: `server/src/modules/public-bootstrap/public-bootstrap.module.ts`

- [ ] **Step 1: Inject the service and add it to the bundle**

In `public-bootstrap.controller.ts`:
- Add `import { AvailabilityService } from '../availability/availability.service';`
- Add `private readonly availability: AvailabilityService,` to the constructor.
- Add the read to the `Promise.all` and return value:

```ts
    const [storefront, products, farmers, subcategories, homeReviews, availability] = await Promise.all([
      this.tenants.findPublicProfileBySlug(slug),
      this.products.findPublicBySlug(slug),
      this.farmers.findPublicBySlug(slug),
      this.subcategories.findPublicBySlug(slug),
      this.reviews.findHomeReviews(slug),
      this.availability.findPublicActiveBySlug(slug),
    ]);
    const productOfWeek = resolveProductOfWeek(storefront, products, new Date());
    return { storefront, products, farmers, subcategories, productOfWeek, homeReviews, availability };
```

- [ ] **Step 2: Import AvailabilityModule into the bootstrap module**

In `public-bootstrap.module.ts`, add `AvailabilityModule` to its `imports` array (mirroring how `FarmersModule` etc. are imported there) and `import { AvailabilityModule } from '../availability/availability.module';`.

- [ ] **Step 3: Build the server**

Run: `pnpm --filter @farmflow/server build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/public-bootstrap
git commit -m "feat(availability): include active windows in storefront bootstrap"
```

---

## Task 8: Checkout enforcement — decrement active window (TDD)

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts`
- Test: `server/src/modules/orders/availability-checkout.spec.ts`

The decrement runs inside the existing order-create transaction, right after the slot-capacity block (`orders.service.ts:706-723`), reusing the row-lock pattern. Extract a small private method so it's testable and the create() body stays readable.

- [ ] **Step 1: Write the failing test (pure decrement logic)**

The order-create transaction needs a live DB, so test the **pure decrement decision** as a helper rather than the full tx. Add the helper to `availability.util.ts` first via this test. Create `server/src/modules/orders/availability-checkout.spec.ts`:

```ts
import { decideDecrement } from '../availability/availability.util';

describe('decideDecrement', () => {
  it('no active window → allow, no decrement', () => {
    expect(decideDecrement(null, 3)).toEqual({ ok: true, newRemaining: null });
  });
  it('active window with enough stock → decrement', () => {
    expect(decideDecrement({ remaining: 5 }, 3)).toEqual({ ok: true, newRemaining: 2 });
  });
  it('active window with insufficient stock → reject', () => {
    expect(decideDecrement({ remaining: 2 }, 3)).toEqual({ ok: false, newRemaining: null });
  });
  it('exact stock → decrement to 0', () => {
    expect(decideDecrement({ remaining: 3 }, 3)).toEqual({ ok: true, newRemaining: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/server test -- availability-checkout`
Expected: FAIL — `decideDecrement` not exported.

- [ ] **Step 3: Add the helper**

Append to `server/src/modules/availability/availability.util.ts`:

```ts
/** Checkout decision for one ordered item against its active window (or null when
 *  the product has no active window → today's behavior, no stock check). */
export function decideDecrement(
  active: { remaining: number } | null,
  qty: number,
): { ok: boolean; newRemaining: number | null } {
  if (!active) return { ok: true, newRemaining: null };
  if (active.remaining < qty) return { ok: false, newRemaining: null };
  return { ok: true, newRemaining: active.remaining - qty };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @farmflow/server test -- availability-checkout`
Expected: PASS.

- [ ] **Step 5: Wire the decrement into order creation**

In `server/src/modules/orders/orders.service.ts`:
- Add imports: `productAvailabilityWindows` to the `@farmflow/db` import; `decideDecrement` from `../availability/availability.util`. `bgToday` is already imported.
- Inside the `create()` transaction, after the slot-capacity block (right after line 723, before `let total = 0;`), insert:

```ts
      // Per-item availability-window enforcement. A product with an active window
      // (today within range) sells from that window's `remaining`; the row is
      // locked so concurrent intakes serialize, mirroring the slot-capacity guard
      // above. Products with no active window are unaffected (today's behavior).
      const today = bgToday();
      for (const it of dto.items) {
        const [win] = await tx
          .select()
          .from(productAvailabilityWindows)
          .where(
            and(
              eq(productAvailabilityWindows.productId, it.productId),
              eq(productAvailabilityWindows.tenantId, tenant.id),
            ),
          )
          .for('update');
        const active = win && win.startsAt <= today && today <= win.endsAt ? win : null;
        const decision = decideDecrement(active, it.quantity);
        if (!decision.ok) {
          const p = byId.get(it.productId);
          throw new ConflictException(`Няма достатъчна наличност: ${p?.name ?? 'продукт'}`);
        }
        if (active && decision.newRemaining != null) {
          await tx
            .update(productAvailabilityWindows)
            .set({ remaining: decision.newRemaining })
            .where(eq(productAvailabilityWindows.id, active.id));
        }
      }
```

> Note: the `.for('update')` lock here selects all of a product's windows for the tenant; for the expected handful of windows per product this is fine. If a product can accumulate many historical windows, narrow the lock with a date predicate later. `ConflictException` is already imported in this file.

- [ ] **Step 6: Build the server**

Run: `pnpm --filter @farmflow/server build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/availability/availability.util.ts server/src/modules/orders/availability-checkout.spec.ts
git commit -m "feat(availability): enforce active-window stock at checkout (row-locked, 409)"
```

---

## Task 9: Restore remaining on order cancel (TDD)

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts`
- Test: `server/src/modules/orders/availability-checkout.spec.ts` (extend)

Cancellation restores the active window's `remaining` (best-effort: only if a window is active for the product at cancel time; capped at `quantity`).

- [ ] **Step 1: Add the failing restore-cap test**

Append to `server/src/modules/orders/availability-checkout.spec.ts`:

```ts
import { restoreRemaining } from '../availability/availability.util';

describe('restoreRemaining', () => {
  it('adds qty back, capped at quantity', () => {
    expect(restoreRemaining({ quantity: 10, remaining: 4 }, 3)).toBe(7);
    expect(restoreRemaining({ quantity: 10, remaining: 9 }, 5)).toBe(10); // capped
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/server test -- availability-checkout`
Expected: FAIL — `restoreRemaining` not exported.

- [ ] **Step 3: Add the helper**

Append to `server/src/modules/availability/availability.util.ts`:

```ts
/** New `remaining` after returning `qty` to a still-active window on cancel,
 *  capped at the window's `quantity` so it can't exceed the original stock. */
export function restoreRemaining(w: { quantity: number; remaining: number }, qty: number): number {
  return Math.min(w.quantity, w.remaining + qty);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @farmflow/server test -- availability-checkout`
Expected: PASS.

- [ ] **Step 5: Wire restore into the cancel path**

Locate the status-update method in `orders.service.ts` that sets an order to `cancelled` (search for `'cancelled'` / `updateStatus`). When an order transitions **to** `cancelled` (and wasn't already cancelled), for each of its items restore the active window. Add `restoreRemaining` to the `availability.util` import. Inside that transition (within its transaction if present, else a small `db.transaction`):

```ts
    // Return reserved stock to each item's active window (best-effort; only while
    // the window is still active — expired windows are left as-is).
    const today = bgToday();
    for (const it of items) {
      const [win] = await tx
        .select()
        .from(productAvailabilityWindows)
        .where(
          and(
            eq(productAvailabilityWindows.productId, it.productId!),
            eq(productAvailabilityWindows.tenantId, order.tenantId),
          ),
        )
        .for('update');
      if (win && win.startsAt <= today && today <= win.endsAt) {
        await tx
          .update(productAvailabilityWindows)
          .set({ remaining: restoreRemaining(win, it.quantity) })
          .where(eq(productAvailabilityWindows.id, win.id));
      }
    }
```

Adapt the variable names (`items`, `order`, `tx`) to the actual cancel method. If the cancel method doesn't already load the order's items, load them first (`orderItems` where `orderId = order.id`).

- [ ] **Step 6: Build + run the availability suite**

Run: `pnpm --filter @farmflow/server build && pnpm --filter @farmflow/server test -- availability`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/availability/availability.util.ts server/src/modules/orders/availability-checkout.spec.ts
git commit -m "feat(availability): restore window stock when an order is cancelled"
```

---

## Task 10: Tenant toggle + title + storefront projection

**Files:**
- Modify: `server/src/modules/tenants/dto/update-tenant.dto.ts`
- Modify: `server/src/modules/tenants/tenants.service.ts`
- Modify: `client/src/components/panels/features-panel.tsx`

- [ ] **Step 1: Extend the tenant update DTO**

In `update-tenant.dto.ts`, after the `reviewsEnabled` field, add:

```ts
  @ApiPropertyOptional({ example: false, description: 'Show the „Задай наличност" section on the storefront' })
  @IsOptional()
  @IsBoolean()
  availabilitySectionEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Storefront title for the availability section (null → default)' })
  @IsOptional()
  @IsString()
  availabilityTitle?: string | null;
```

> Verify the tenants service `update()` whitelists/passes these fields the same way it does `articlesEnabled` (e.g. a column allow-list). If it spreads the DTO onto the row, no change needed; if it picks fields explicitly, add both. **This whitelist step is the silent-400 gotcha** — a field absent from the allow-list is dropped without error.

- [ ] **Step 2: Project the flag + title to the storefront profile**

In `tenants.service.ts`, find `findPublicProfileBySlug` (line ~120) and ensure the returned `PublicStorefront`/profile includes `availabilitySectionEnabled` and `availabilityTitle` (they're columns on `tenants`, so if the method returns the row minus stripped fields they may already be present; if it cherry-picks public fields, add both). Confirm `PublicStorefront` (or the equivalent return type) carries them so the storefront can gate the section and read the title.

- [ ] **Step 3: Add the toggle to the features panel**

In `client/src/components/panels/features-panel.tsx`:
- Add `availabilitySectionEnabled: boolean;` to the `FeatureFlags` interface.
- Import a suitable icon (e.g. `CalendarClock` from `lucide-react`).
- In the „Съдържание" `CardGroup`, add a third `ToggleCard`:

```tsx
        <ToggleCard
          icon={CalendarClock}
          title="Задай наличност"
          desc="Секция, в която обявяваш каква наличност имаш за определен период (ден/седмица/месец). Клиентът поръчва, количеството намалява."
          on={val.availabilitySectionEnabled}
          onToggle={(v) => set('availabilitySectionEnabled', v)}
          configLink={{ href: '/availability', label: 'Управлявай наличността' }}
        />
```

- Ensure the page that renders `FeaturesPanel` (`client/src/app/(admin)/features/page.tsx`) passes `availabilitySectionEnabled` in its `initial` prop (read from the tenant profile).

- [ ] **Step 4: Build server + client**

Run sequentially:
```bash
pnpm --filter @farmflow/server build
pnpm --filter @farmflow/client build
```
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tenants client/src/components/panels/features-panel.tsx client/src/app/\(admin\)/features/page.tsx
git commit -m "feat(availability): tenant toggle + title + storefront projection + features panel"
```

---

## Task 11: Admin api-client + client type

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/api-client.ts`

- [ ] **Step 1: Add the client type**

In `client/src/lib/types.ts`, add:

```ts
export interface AvailabilityWindow {
  id: string;
  productId: string;
  startsAt: string; // 'YYYY-MM-DD'
  endsAt: string;
  quantity: number;
  remaining: number;
}
```

- [ ] **Step 2: Add the api-client calls**

In `client/src/lib/api-client.ts`, following the existing call patterns (the file already wraps a fetch helper — mirror an existing CRUD group such as farmers/slots), add:

```ts
import type { AvailabilityWindow } from './types';

export function listAvailabilityWindows(productId?: string): Promise<AvailabilityWindow[]> {
  const q = productId ? `?productId=${encodeURIComponent(productId)}` : '';
  return api(`/availability-windows${q}`);
}

export function createAvailabilityWindow(body: {
  productId: string; startsAt: string; endsAt: string; quantity: number;
}): Promise<AvailabilityWindow> {
  return api('/availability-windows', { method: 'POST', body: JSON.stringify(body) });
}

export function updateAvailabilityWindow(
  id: string,
  body: Partial<{ startsAt: string; endsAt: string; quantity: number }>,
): Promise<AvailabilityWindow> {
  return api(`/availability-windows/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function deleteAvailabilityWindow(id: string): Promise<{ id: string }> {
  return api(`/availability-windows/${id}`, { method: 'DELETE' });
}
```

> Match the exact helper name/signature used in this file (it may be `apiFetch`, `request`, or a typed wrapper — open the file and copy the surrounding pattern, including how `updateTenant` issues a PATCH). The `updateTenant` import in `features-panel.tsx` is a good reference for the call shape.

- [ ] **Step 3: Typecheck the client**

Run: `pnpm --filter @farmflow/client build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts
git commit -m "feat(availability): admin api-client + AvailabilityWindow type"
```

---

## Task 12: Admin screen „Задай наличност"

**Files:**
- Create: `client/src/app/(admin)/availability/page.tsx`
- Create: `client/src/components/availability/availability-client.tsx`
- Create: `client/src/components/availability/window-editor.tsx`

Model the page shell + data loading on an existing admin screen (e.g. `client/src/app/(admin)/products/page.tsx`), and the modal on `client/src/components/products/product-dialog.tsx`. The screen lists the tenant's products; under each, its windows; with add/edit/delete.

- [ ] **Step 1: Window editor modal**

Create `client/src/components/availability/window-editor.tsx`:

```tsx
'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { ApiError, createAvailabilityWindow, updateAvailabilityWindow } from '@/lib/api-client';
import type { AvailabilityWindow } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

interface Props {
  productId: string;
  window?: AvailabilityWindow; // present = edit
  onClose: () => void;
  onSaved: () => void;
}

export function WindowEditor({ productId, window, onClose, onSaved }: Props) {
  const isEdit = !!window;
  const [startsAt, setStartsAt] = React.useState(window?.startsAt ?? '');
  const [endsAt, setEndsAt] = React.useState(window?.endsAt ?? '');
  const [quantity, setQuantity] = React.useState(window ? String(window.quantity) : '');
  const [saving, setSaving] = React.useState(false);

  const save = async () => {
    const qty = parseInt(quantity, 10);
    if (!startsAt || !endsAt || !qty || qty < 1) {
      toast.error('Попълни период и количество (поне 1)');
      return;
    }
    if (endsAt < startsAt) {
      toast.error('Крайната дата е преди началната');
      return;
    }
    setSaving(true);
    try {
      if (isEdit) await updateAvailabilityWindow(window!.id, { startsAt, endsAt, quantity: qty });
      else await createAvailabilityWindow({ productId, startsAt, endsAt, quantity: qty });
      toast.success('Запазено');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 font-display text-lg font-bold text-ff-ink">
          {isEdit ? 'Промени период' : 'Нов период с наличност'}
        </h2>
        <div className="flex flex-col gap-3">
          <label className="text-sm font-semibold text-ff-ink-2">
            От
            <input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ff-line px-3 py-2 text-ff-ink" />
          </label>
          <label className="text-sm font-semibold text-ff-ink-2">
            До
            <input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ff-line px-3 py-2 text-ff-ink" />
          </label>
          <label className="text-sm font-semibold text-ff-ink-2">
            Количество (бр.)
            <input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="numeric"
              className="mt-1 w-full rounded-lg border border-ff-line px-3 py-2 text-ff-ink" />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-semibold text-ff-ink-2">Отказ</button>
          <button onClick={save} disabled={saving}
            className="rounded-lg bg-ff-green-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-60">
            {saving ? 'Запазвам…' : 'Запази'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

> Match the exact CSS-variable / class names the codebase uses (e.g. `border-ff-line` vs `border-ff-green-100`) by copying from `product-dialog.tsx`. The logic above is the contract; the styling should follow house style.

- [ ] **Step 2: Screen client component**

Create `client/src/components/availability/availability-client.tsx`:

```tsx
'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { ApiError, listAvailabilityWindows, deleteAvailabilityWindow } from '@/lib/api-client';
import type { AvailabilityWindow, Product } from '@/lib/types';
import { WindowEditor } from './window-editor';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(new Date());
const isActive = (w: AvailabilityWindow) => w.startsAt <= today() && today() <= w.endsAt;

export function AvailabilityClient({ products, title }: { products: Product[]; title: string | null }) {
  const [windows, setWindows] = React.useState<AvailabilityWindow[]>([]);
  const [editing, setEditing] = React.useState<{ productId: string; window?: AvailabilityWindow } | null>(null);

  const reload = React.useCallback(async () => {
    try {
      setWindows(await listAvailabilityWindows());
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);
  React.useEffect(() => { void reload(); }, [reload]);

  const byProduct = (id: string) => windows.filter((w) => w.productId === id).sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const remove = async (id: string) => {
    try { await deleteAvailabilityWindow(id); await reload(); }
    catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-[26px] font-extrabold tracking-[-0.02em] text-ff-ink">Задай наличност</h1>
        <p className="mt-0.5 text-[14px] text-ff-ink-2">
          Обяви каква наличност имаш за определен период. Докато периодът е активен, количеството е реалната наличност в магазина — клиентът поръчва и то намалява.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {products.map((p) => (
          <div key={p.id} className="rounded-2xl border border-ff-line bg-white p-4">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-ff-ink">{[p.name, p.weight].filter(Boolean).join(' ')}</div>
              <button onClick={() => setEditing({ productId: p.id })}
                className="rounded-lg bg-ff-green-50 px-3 py-1.5 text-sm font-bold text-ff-green-700">
                + Период
              </button>
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              {byProduct(p.id).length === 0 && <div className="text-sm text-ff-muted-2">Няма зададени периоди.</div>}
              {byProduct(p.id).map((w) => (
                <div key={w.id} className="flex items-center justify-between rounded-lg bg-ff-bg px-3 py-2 text-sm">
                  <span className="text-ff-ink-2">
                    {w.startsAt} → {w.endsAt}
                    {isActive(w) && <span className="ml-2 rounded bg-ff-green-100 px-1.5 py-0.5 text-[11px] font-bold text-ff-green-700">активен</span>}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-semibold text-ff-ink">остават {w.remaining}/{w.quantity}</span>
                    <button onClick={() => setEditing({ productId: p.id, window: w })} className="text-ff-ink-2 hover:underline">Промени</button>
                    <button onClick={() => remove(w.id)} className="text-ff-red-600 hover:underline">Изтрий</button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <WindowEditor
          productId={editing.productId}
          window={editing.window}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
```

> `title` is threaded for future display of the configurable storefront title (a small input can be added later); for v1 it's accepted but the editing UI for it can be a follow-up. Adjust class names to house style.

- [ ] **Step 3: Page route (server component)**

Create `client/src/app/(admin)/availability/page.tsx`, mirroring how `products/page.tsx` fetches products server-side and renders its client component:

```tsx
import { AvailabilityClient } from '@/components/availability/availability-client';
import { listProducts, getTenantProfile } from '@/lib/api-client';

export default async function AvailabilityPage() {
  const [products, profile] = await Promise.all([listProducts(), getTenantProfile()]);
  return <AvailabilityClient products={products} title={profile.availabilityTitle ?? null} />;
}
```

> Use whatever the existing products screen uses to load products server-side (copy its imports/auth-cookie handling exactly — `listProducts`/`getProducts` and the tenant-profile getter names may differ). If a server-side product list helper doesn't exist, load it in the client component via `useEffect` instead and drop the server fetch.

- [ ] **Step 4: Typecheck/build the client**

Run: `pnpm --filter @farmflow/client build`
Expected: PASS. Fix any import-name mismatches against the real api-client.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/\(admin\)/availability client/src/components/availability
git commit -m "feat(availability): admin „Задай наличност" screen (list + window editor)"
```

---

## Task 13: Nav item + name sync + help

**Files:**
- Modify: `client/src/components/layout/sidebar.tsx`
- Modify: `client/src/components/layout/topbar.tsx`
- Modify: `client/src/lib/help-content.ts`
- Modify: `client/src/app/(admin)/help/page.tsx`

The screen is named in several drifting places (per the nav-naming gotcha) — keep them in sync.

- [ ] **Step 1: Add the nav item**

In `client/src/components/layout/sidebar.tsx`, in the `Каталог` group's `items` array (after `/products`), add:

```ts
      { href: '/availability', label: 'Задай наличност', Icon: CalendarClock, gated: true, desc: 'Обяви наличност за определен период (ден/седмица/месец).' },
```

Import `CalendarClock` from `lucide-react` in that file. `gated: true` hides it when the toggle is off — confirm how `gated` is resolved (it likely keys off a feature flag map; wire `availabilitySectionEnabled` into whatever drives `gated`, mirroring `/articles` which is gated by `articlesEnabled`).

- [ ] **Step 2: Add the page title**

In `client/src/components/layout/topbar.tsx`, add `'/availability': 'Задай наличност'` to the `PAGE_TITLES` map.

- [ ] **Step 3: Add a help entry**

In `client/src/lib/help-content.ts`, add a short section for the screen (mirror the „Продукти" entry shape) explaining: declare availability for a period; while active it's the real stock; orders deplete it. Add a matching bullet to `client/src/app/(admin)/help/page.tsx` quick-start if appropriate.

- [ ] **Step 4: Build the client**

Run: `pnpm --filter @farmflow/client build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/layout/sidebar.tsx client/src/components/layout/topbar.tsx client/src/lib/help-content.ts client/src/app/\(admin\)/help/page.tsx
git commit -m "feat(availability): nav item + page title + help (name sync)"
```

---

## Task 14: Storefront section (in-repo Next `storefront/`)

**Files:**
- Create: `storefront/src/components/availability-section.tsx`
- Modify: `storefront/src/app/page.tsx`
- Modify: `storefront/src/lib/api.ts`

The bootstrap now returns `availability: PublicAvailabilityWindow[]`. Render a section that overlays `remaining` onto catalog products by `productId`, gated by `storefront.availabilitySectionEnabled`, titled `storefront.availabilityTitle ?? 'Налично сега'`.

- [ ] **Step 1: Type the bootstrap addition**

In `storefront/src/lib/api.ts`, extend the bootstrap response type to include:

```ts
  availability: { productId: string; startsAt: string; endsAt: string; quantity: number; remaining: number }[];
```

and ensure `storefront` carries `availabilitySectionEnabled: boolean` and `availabilityTitle: string | null`.

- [ ] **Step 2: Section component**

Create `storefront/src/components/availability-section.tsx`:

```tsx
import type { PublicProduct } from '@/lib/api'; // adjust to the storefront's product type

interface Win { productId: string; remaining: number; quantity: number; startsAt: string; endsAt: string; }

export function AvailabilitySection({
  title, products, windows,
}: { title: string; products: PublicProduct[]; windows: Win[] }) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const items = windows
    .map((w) => ({ w, p: byId.get(w.productId) }))
    .filter((x) => x.p);

  if (items.length === 0) return null;

  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <h2 className="mb-4 text-2xl font-bold">{title}</h2>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {items.map(({ w, p }) => (
          <article key={w.productId} className="rounded-xl border p-3">
            <div className="font-semibold">{p!.name}</div>
            <div className="text-sm text-neutral-600">
              {w.remaining > 0 ? `остават ${w.remaining}` : 'изчерпан'}
            </div>
            {/* Reuse the storefront's existing add-to-cart button for `p`; disable when w.remaining === 0. */}
          </article>
        ))}
      </div>
    </section>
  );
}
```

> This is a skeleton against the contract — wire the storefront's real product-card / add-to-cart components and grouping-by-farmer (when `storefront.multiFarmer`) to match the site's existing catalog section markup.

- [ ] **Step 3: Render it on the home page**

In `storefront/src/app/page.tsx`, after fetching the bootstrap, render the section when enabled:

```tsx
{bootstrap.storefront.availabilitySectionEnabled && (
  <AvailabilitySection
    title={bootstrap.storefront.availabilityTitle ?? 'Налично сега'}
    products={bootstrap.products}
    windows={bootstrap.availability}
  />
)}
```

- [ ] **Step 4: Build the storefront**

Run: `pnpm --filter @farmflow/storefront build` (use the storefront package's actual name from its `package.json`).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add storefront/src/components/availability-section.tsx storefront/src/app/page.tsx storefront/src/lib/api.ts
git commit -m "feat(availability): storefront „Налично сега" section (in-repo Next consumer)"
```

---

## Task 15: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Build the whole stack (sequentially — FS flakes on parallel)**

```bash
pnpm --filter @farmflow/db build
pnpm --filter @farmflow/types build
pnpm --filter @farmflow/server build
pnpm --filter @farmflow/client build
pnpm --filter @farmflow/storefront build
```
Expected: all PASS.

- [ ] **Step 2: Run the full server test suite**

```bash
pnpm --filter @farmflow/server test
```
Expected: all green (existing suites + the new availability suites). Note the known flaky `email.service` load-timeout test (passes alone) per project history.

- [ ] **Step 3: Live E2E checklist (manual, with the API + db running)**

Run the API against a dev Postgres with the new migration applied (`pnpm --filter @farmflow/db migrate` or the app's boot auto-migrate). Then:
1. Toggle „Задай наличност" ON in „Функции на магазина".
2. Create a window for a product: от today, до +3 days, quantity 5. Confirm it shows „активен · остават 5/5".
3. Create a second, **overlapping** window for the same product → expect a 409 / „застъпва" error.
4. On the storefront bootstrap (`GET /public/:slug/bootstrap`), confirm `availability` lists the active window with `remaining: 5`.
5. Place an order for 2 of that product → order succeeds; re-fetch → `remaining: 3`.
6. Place an order for 4 → expect 409 „Няма достатъчна наличност".
7. Cancel the first order → `remaining` returns to 5.
8. Confirm a product **without** any window still orders exactly as before (no stock block), proving the static `stock_quantity` path is untouched.

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(availability): verification fixes"
```

---

## Task 16: Follow-up — mirror the section in the live storefront (chaika)

**Out of this repo.** The production storefront is `fermerski-pazar-chaika` (separate Astro repo). In a session rooted there, mirror Task 14 against the live API contract:
- Bootstrap (or `GET /public/:slug/availability`) now returns `availability: PublicAvailabilityWindow[]`.
- `storefront.availabilitySectionEnabled` gates the section; `storefront.availabilityTitle ?? 'Налично сега'` titles it.
- Overlay `remaining` onto catalog products by `productId`; group by farmer when `multiFarmer`; disable add-to-cart at `remaining === 0`.

This is tracked as a separate plan/session because the repo isn't in this working tree.

---

## Self-Review notes (author)

- **Spec coverage:** data model (T1–T2), resolver/helpers (T3,T8,T9), server module + endpoints (T4–T7), checkout enforcement (T8), cancellation (T9), admin screen (T11–T13), storefront (T14, T16), toggle + projection + title (T10), caching (T5 keeps `remaining` out of the long-cached catalog; bootstrap reads it fresh), migration (T1), tests throughout, landmines (static-stock untouched — T8 only enforces with an active window; tz via `bgToday`; overlap reject — T5; sold-out blocks — T8). All covered.
- **Type consistency:** helper names are stable across tasks — `activeWindow`, `rangesOverlap`, `applyQuantityDelta`, `decideDecrement`, `restoreRemaining`; types `AvailabilityWindow` / `PublicAvailabilityWindow` defined in T2 and used in T5/T7/T11.
- **Known soft spots flagged inline:** exact api-client helper name, the tenant-update whitelist (silent-400 gotcha), `gated` flag wiring, and storefront package name — each step says to align with the real file.
