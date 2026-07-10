# Vendor Finance (dormant) — Backend + Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the DORMANT commission ledger + vendor monthly-subscription tracker (spec workstream A) end-to-end: schema, services, money seams, API, and the two farmer-panel screens — with zero user-visible behavior change while dormant.

**Architecture:** One new NestJS module (`vendor-finance`) over two new tables; `CommissionService` is injected `@Optional()` into the existing order/stripe money seams (fire-and-forget, error-swallowing). Config lives in `tenants.settings.vendorFinance` (jsonb, absent → everything off, commission rate 0). Panel: one owner screen, one producer screen, two farmer-form override fields.

**Tech Stack:** NestJS 10 + Drizzle (server), hand-written SQL migrations, Jest (server specs, chainable-mock DB), Next.js App Router (client panel).

**Spec:** `docs/superpowers/specs/2026-07-10-farmmarket-marketplace-design.md` (workstream A + panel items D1-D2 and the two finance override fields from D3).

## Global Constraints

- **Auto-deploy:** push to main deploys production. COMMIT per task; do NOT push. The human pushes when the phase is done.
- **Deploy does NOT run migrations** (`deploy.yml` = compose pull + up only). Drizzle's bare `.select()` enumerates schema columns → shipping code whose schema has columns the prod DB lacks 500s every `farmers` query and takes down ALL storefronts. The migration MUST be applied to the prod DB BEFORE the code is pushed (additive DDL is invisible to the old code). See Task 12's pre-push runbook.
- **Public payloads must NOT carry the finance columns.** `farmers.service.ts` uses bare `.select()` and feeds the public storefront bootstrap — Task 2b strips `commissionRateBps`/`subscriptionFeeStotinki` from every public farmers path (phone/email stay: they are public on purpose).
- **Non-marketplace tenants must see ZERO panel change.** The «Финанси на пазара» nav item is gated on the tenant's `multiFarmer` flag (Task 9); the farmer-form fields live on the Фермери screen, which only multi-farmer tenants use.
- **Dormant by construction:** no code path may charge or change user-visible behavior unless `tenants.settings.vendorFinance.commissionEnabled` / `.subscriptionEnabled` is true. Neither flag is ever set by this plan.
- Money: integers in the same minor unit as order totals (`*_stotinki` = eurocents; €12 = 1200). Rates in basis points (500 = 5%). Rounding: `Math.round(gross * rateBps / 10000)`.
- Existing test suites must stay green WITHOUT edits (the `@Optional()` injection guarantees OrdersService/StripeService spec harnesses keep working).
- Migrations are hand-written SQL + `_journal.json` entry (idx 86 — 0085 exists only if nobody else claimed it first; CHECK `ls packages/db/drizzle` and use the next free number, adjusting the journal entry to match).
- All panel copy in Bulgarian; sentence case; no fake data.
- A draft of Tasks 1–7 exists at `C:\Users\Lenovo\AppData\Local\Temp\claude\C--Users-Lenovo-source-repos-FarmFlow\797cd1ec-4328-44b8-be93-77c114cc33ff\scratchpad\vendor-finance-draft\` — the code below is that draft, already adapted to repo patterns. If the dir is gone, the code blocks here are complete.

---

### Task 1: Schema — enums, farmer columns, two ledger tables

**Files:**
- Modify: `packages/db/src/schema.ts` (4 edits: after `subscriptionStatusEnum` ~line 30; inside `farmers` table ~line 940; before `export const schema = {` ~line 1045; inside the `schema` aggregate + trailing enum export block)

**Interfaces:**
- Produces: exported Drizzle tables `commissionEntries`, `vendorSubscriptionCharges`; enums `commissionEntryStatusEnum`, `vendorChargeStatusEnum`; `farmers.commissionRateBps`, `farmers.subscriptionFeeStotinki` (both `integer`, nullable). All later tasks import these from `@fermeribg/db`.

- [ ] **Step 1: Add the two enums** — in `packages/db/src/schema.ts`, directly after the `subscriptionStatusEnum` line:

```ts
// Vendor finance (DORMANT until enabled per tenant — see tenants.settings.vendorFinance).
// commission_entries lifecycle: accrued (money collected) → settled (paid out) or
// voided (order cancelled / COD refused). Settled is final.
export const commissionEntryStatusEnum = pgEnum('commission_entry_status', [
  'accrued',
  'voided',
  'settled',
]);
// Vendor monthly subscription charges (the operator collects the fee off-platform
// today; these rows only track who owes what per month).
export const vendorChargeStatusEnum = pgEnum('vendor_charge_status', ['due', 'paid', 'waived']);
```

- [ ] **Step 2: Add the farmer override columns** — inside `export const farmers = pgTable('farmers', {...})`, after the `since: text('since'),` line:

```ts
    // Vendor finance overrides (DORMANT): NULL = inherit the tenant default from
    // tenants.settings.vendorFinance. Rate in basis points (500 = 5%); fee in the
    // same minor unit as order totals.
    commissionRateBps: integer('commission_rate_bps'),
    subscriptionFeeStotinki: integer('subscription_fee_stotinki'),
```

- [ ] **Step 3: Add the two tables** — directly BEFORE the `export const schema = {` aggregate:

```ts
// Commission ledger (DORMANT until tenants.settings.vendorFinance.commissionEnabled).
// One row per (order, farmer): the farmer's item-only gross (delivery fee excluded,
// matching the turnover rule) and the commission at the rate SNAPSHOTTED at accrual
// time — enabling commission later must never retro-charge old orders. Accrual fires
// on the collected-money signal (COD received / Stripe paid), void on cancel/refusal.
export const commissionEntries = pgTable(
  'commission_entries',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'cascade' }),
    grossStotinki: integer('gross_stotinki').notNull(),
    rateBps: integer('rate_bps').notNull(),
    commissionStotinki: integer('commission_stotinki').notNull(),
    status: commissionEntryStatusEnum('status').notNull().default('accrued'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // Idempotent accrual: re-running accrueForOrder must not duplicate rows.
    orderFarmerUniq: uniqueIndex('commission_entries_order_farmer_uniq').on(t.orderId, t.farmerId),
    // Farmer statement + owner summary: tenant-scoped, per farmer, by period.
    tenantFarmerCreatedIdx: index('commission_entries_tenant_farmer_created_idx').on(
      t.tenantId,
      t.farmerId,
      t.createdAt,
    ),
  }),
);

// Vendor monthly subscription charges (DORMANT until
// tenants.settings.vendorFinance.subscriptionEnabled). Generated per farmer per
// 'YYYY-MM' period; the operator collects the money off-platform and marks rows
// paid/waived. No auto-charging anywhere.
export const vendorSubscriptionCharges = pgTable(
  'vendor_subscription_charges',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'cascade' }),
    // Billing month as 'YYYY-MM' (Europe/Sofia semantics decided by the caller).
    period: text('period').notNull(),
    feeStotinki: integer('fee_stotinki').notNull(),
    status: vendorChargeStatusEnum('status').notNull().default('due'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    note: text('note'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // Idempotent generation: one charge per farmer per month.
    farmerPeriodUniq: uniqueIndex('vendor_subscription_charges_farmer_period_uniq').on(
      t.farmerId,
      t.period,
    ),
    tenantPeriodIdx: index('vendor_subscription_charges_tenant_period_idx').on(
      t.tenantId,
      t.period,
    ),
  }),
);
```

- [ ] **Step 4: Register in the aggregates** — inside `export const schema = { ... }` add `commissionEntries,` and `vendorSubscriptionCharges,` after `orderItems,`; in the trailing enum re-export block add `commissionEntryStatusEnum,` and `vendorChargeStatusEnum,` after `subscriptionStatusEnum,`.

- [ ] **Step 5: Type-check the package**

Run: `cd packages/db && npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat(db): dormant vendor-finance schema — commission ledger + vendor charges + farmer overrides"
```

---

### Task 2: Migration + journal entry

**Files:**
- Create: `packages/db/drizzle/0086_vendor_finance.sql` (or next free number — check `ls packages/db/drizzle/*.sql | tail -1` first and rename accordingly)
- Modify: `packages/db/drizzle/meta/_journal.json` (append one entry)

**Interfaces:**
- Produces: DB objects matching Task 1 exactly (2 enums, 2 farmer columns, 2 tables, 4 indexes).

- [ ] **Step 1: Write the migration file** (adjust `0086` if a different number is free):

```sql
-- Vendor finance (DORMANT feature — no tenant has it enabled by default).
-- 1) commission_entries: per-(order, farmer) commission ledger. Gross = item-only
--    sum (delivery fee excluded, same rule as turnover). rate_bps is snapshotted at
--    accrual time so enabling commission later never retro-charges old orders.
-- 2) vendor_subscription_charges: per-farmer monthly fee tracker ('YYYY-MM'), the
--    operator collects the money off-platform and marks rows paid/waived.
-- 3) farmers gain per-farmer overrides (NULL = inherit tenant default from
--    tenants.settings.vendorFinance).
CREATE TYPE "public"."commission_entry_status" AS ENUM('accrued', 'voided', 'settled');
--> statement-breakpoint
CREATE TYPE "public"."vendor_charge_status" AS ENUM('due', 'paid', 'waived');
--> statement-breakpoint
ALTER TABLE "farmers" ADD COLUMN "commission_rate_bps" integer;
--> statement-breakpoint
ALTER TABLE "farmers" ADD COLUMN "subscription_fee_stotinki" integer;
--> statement-breakpoint
CREATE TABLE "commission_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"tenant_id" uuid,
	"order_id" uuid,
	"farmer_id" uuid,
	"gross_stotinki" integer NOT NULL,
	"rate_bps" integer NOT NULL,
	"commission_stotinki" integer NOT NULL,
	"status" "commission_entry_status" DEFAULT 'accrued' NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_farmer_id_farmers_id_fk" FOREIGN KEY ("farmer_id") REFERENCES "public"."farmers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "commission_entries_order_farmer_uniq" ON "commission_entries" USING btree ("order_id","farmer_id");
--> statement-breakpoint
CREATE INDEX "commission_entries_tenant_farmer_created_idx" ON "commission_entries" USING btree ("tenant_id","farmer_id","created_at");
--> statement-breakpoint
CREATE TABLE "vendor_subscription_charges" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"tenant_id" uuid,
	"farmer_id" uuid,
	"period" text NOT NULL,
	"fee_stotinki" integer NOT NULL,
	"status" "vendor_charge_status" DEFAULT 'due' NOT NULL,
	"paid_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "vendor_subscription_charges" ADD CONSTRAINT "vendor_subscription_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_subscription_charges" ADD CONSTRAINT "vendor_subscription_charges_farmer_id_farmers_id_fk" FOREIGN KEY ("farmer_id") REFERENCES "public"."farmers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_subscription_charges_farmer_period_uniq" ON "vendor_subscription_charges" USING btree ("farmer_id","period");
--> statement-breakpoint
CREATE INDEX "vendor_subscription_charges_tenant_period_idx" ON "vendor_subscription_charges" USING btree ("tenant_id","period");
```

- [ ] **Step 2: Append the journal entry** — in `packages/db/drizzle/meta/_journal.json`, after the last entry (match `idx` to the file number you used; `when` = any ms timestamp after the previous entry's):

```json
    {
      "idx": 86,
      "version": "7",
      "when": 1783800000000,
      "tag": "0086_vendor_finance",
      "breakpoints": true
    }
```

- [ ] **Step 3: Verify migration applies on the dev DB** (dev postgres on port 5433 per repo docs):

Run: `cd packages/db && npm run migrate` (or the repo's migrate script — check `package.json` scripts; it is the same command used for 0084)
Expected: applies cleanly, exit 0. Verify: `psql -p 5433 -c "\d commission_entries"` shows the table (or run the repo's usual verification).

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle
git commit -m "feat(db): migration for dormant vendor-finance tables"
```

---

### Task 2b: Keep the finance columns OUT of public farmers payloads

**Files:**
- Modify: `server/src/modules/farmers/farmers.service.ts` (the public read path — `findPublicBySlug` and any other method whose rows reach `public-bootstrap` / public farmers endpoints)
- Test: `server/src/modules/farmers/farmers.public-fields.spec.ts` (new)

**Interfaces:**
- Consumes: `farmers.commissionRateBps` / `farmers.subscriptionFeeStotinki` (Task 1).
- Produces: guarantee that no public farmers payload contains `commissionRateBps` or `subscriptionFeeStotinki`. Admin/owner endpoints keep returning them (the panel needs them in Task 11).

- [ ] **Step 1: Write the failing test.** Locate the public method(s) in `farmers.service.ts` that `public-bootstrap.controller.ts` calls (`findPublicBySlug`). Test with the thenable mock DB from Task 4 (copy `makeDb()`), queueing a farmer row that INCLUDES the two fields, and assert the public return strips them:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { FarmersService } from './farmers.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
// [copy makeDb() + the service's other constructor deps mocked the way
//  farmers.access.spec.ts already mocks them — reuse that spec's builder]

it('public farmers payload never exposes vendor finance fields', async () => {
  // queue tenant-by-slug + farmers rows as the real call sequence requires
  const row = {
    id: 'f1', tenantId: 't1', name: 'Васил', role: 'Ягодоплодни', bio: null,
    phone: '0888', email: 'v@x.bg', since: '2023', tint: null, imageUrl: null,
    coverCrop: null, position: 0, createdAt: new Date(),
    commissionRateBps: 500, subscriptionFeeStotinki: 1200,
  };
  // ...queue per the method's awaits...
  const out = await service.findPublicBySlug('chaika');
  for (const f of out) {
    expect(f).not.toHaveProperty('commissionRateBps');
    expect(f).not.toHaveProperty('subscriptionFeeStotinki');
    expect(f).toHaveProperty('phone'); // public on purpose — must survive
  }
});
```

(Adapt the queue order to the actual method body — read it first; if the public list is served from the Redis public cache, strip BEFORE caching so stale cached payloads can't leak either.)

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx jest src/modules/farmers/farmers.public-fields.spec.ts`
Expected: FAIL — properties present.

- [ ] **Step 3: Implement the strip** — in the public method, before returning (and before writing to the public cache):

```ts
    // Vendor finance terms are owner-only — never serve them to the storefront.
    return rows.map(({ commissionRateBps, subscriptionFeeStotinki, ...pub }) => pub);
```

- [ ] **Step 4: Run the new spec + the existing farmers suite**

Run: `cd server && npx jest src/modules/farmers`
Expected: all green (existing access/image/reorder specs untouched).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/farmers
git commit -m "fix(server): strip vendor-finance fields from public farmers payloads"
```

---

### Task 3: Settings reader (`vendor-finance.settings.ts`) — TDD

**Files:**
- Create: `server/src/modules/vendor-finance/vendor-finance.settings.ts`
- Test: `server/src/modules/vendor-finance/vendor-finance.settings.spec.ts`

**Interfaces:**
- Produces: `interface VendorFinanceSettings { commissionEnabled: boolean; defaultCommissionRateBps: number; subscriptionEnabled: boolean; defaultSubscriptionFeeStotinki: number }` and `function readVendorFinance(settings: unknown): VendorFinanceSettings`. Consumed by both services (Tasks 4-5).

- [ ] **Step 1: Write the failing test**

```ts
import { readVendorFinance } from './vendor-finance.settings';

describe('readVendorFinance', () => {
  it('is fully dormant on absent/garbage settings', () => {
    for (const input of [undefined, null, {}, { vendorFinance: null }, { vendorFinance: 'x' }, 42]) {
      expect(readVendorFinance(input)).toEqual({
        commissionEnabled: false,
        defaultCommissionRateBps: 0,
        subscriptionEnabled: false,
        defaultSubscriptionFeeStotinki: 0,
      });
    }
  });

  it('reads a full config', () => {
    expect(
      readVendorFinance({
        vendorFinance: {
          commissionEnabled: true,
          defaultCommissionRateBps: 500,
          subscriptionEnabled: true,
          defaultSubscriptionFeeStotinki: 1200,
        },
      }),
    ).toEqual({
      commissionEnabled: true,
      defaultCommissionRateBps: 500,
      subscriptionEnabled: true,
      defaultSubscriptionFeeStotinki: 1200,
    });
  });

  it('rejects negative/NaN numbers and truthy-but-not-true flags', () => {
    const out = readVendorFinance({
      vendorFinance: {
        commissionEnabled: 1,
        defaultCommissionRateBps: -5,
        subscriptionEnabled: 'yes',
        defaultSubscriptionFeeStotinki: NaN,
      },
    });
    expect(out).toEqual({
      commissionEnabled: false,
      defaultCommissionRateBps: 0,
      subscriptionEnabled: false,
      defaultSubscriptionFeeStotinki: 0,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx jest src/modules/vendor-finance/vendor-finance.settings.spec.ts`
Expected: FAIL — cannot find module './vendor-finance.settings'.

- [ ] **Step 3: Implement**

```ts
/**
 * Vendor-finance config, stored per tenant in `tenants.settings.vendorFinance`.
 * The WHOLE feature is dormant by design: with no settings written anywhere the
 * effective config is `{ commissionEnabled: false, subscriptionEnabled: false }`,
 * commission accrues at 0 bps and charge generation refuses to run. Enabling it
 * later is a settings write — no deploy, no migration.
 *
 * Money units follow the rest of the app: rate in basis points (500 = 5%), fees
 * in the same minor unit as order totals (`*_stotinki` columns).
 */
export interface VendorFinanceSettings {
  commissionEnabled: boolean;
  /** Tenant-wide default; `farmers.commission_rate_bps` overrides per farmer. */
  defaultCommissionRateBps: number;
  subscriptionEnabled: boolean;
  /** Tenant-wide default; `farmers.subscription_fee_stotinki` overrides per farmer. */
  defaultSubscriptionFeeStotinki: number;
}

/** Defensive parse of the untyped settings jsonb — absent/garbage → dormant. */
export function readVendorFinance(settings: unknown): VendorFinanceSettings {
  const raw =
    settings && typeof settings === 'object'
      ? ((settings as Record<string, unknown>).vendorFinance as Record<string, unknown> | undefined)
      : undefined;
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  return {
    commissionEnabled: raw?.commissionEnabled === true,
    defaultCommissionRateBps: num(raw?.defaultCommissionRateBps),
    subscriptionEnabled: raw?.subscriptionEnabled === true,
    defaultSubscriptionFeeStotinki: num(raw?.defaultSubscriptionFeeStotinki),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx jest src/modules/vendor-finance/vendor-finance.settings.spec.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/vendor-finance
git commit -m "feat(server): vendor-finance settings reader (dormant defaults)"
```

---

### Task 4: CommissionService — TDD

**Files:**
- Create: `server/src/modules/vendor-finance/commission.service.ts`
- Test: `server/src/modules/vendor-finance/commission.service.spec.ts`

**Interfaces:**
- Consumes: `readVendorFinance` (Task 3), tables from Task 1, `DB_TOKEN` from `server/src/common/drizzle/drizzle.constants`.
- Produces: `CommissionService` with `accrueForOrder(orderId: string, tenantId: string): Promise<void>`, `voidForOrder(orderId: string, tenantId: string): Promise<void>`, `summary(tenantId: string, opts?: { farmerId?: string; from?: Date; to?: Date }): Promise<CommissionSummary>` where `CommissionSummary = { commissionEnabled: boolean; defaultRateBps: number; farmers: CommissionFarmerSummary[]; totalGrossStotinki: number; totalCommissionStotinki: number }` and `CommissionFarmerSummary = { farmerId: string; farmerName: string | null; orderCount: number; grossStotinki: number; commissionStotinki: number; settledCommissionStotinki: number }`. Tasks 6, 7, 10, 11 rely on these exact names.

- [ ] **Step 1: Write the failing spec.** The mock DB is a **thenable chain**: every builder method returns the same object; `await`-ing any chain pops the next queued result (FIFO). Queue order = the order the service awaits queries.

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { CommissionService } from './commission.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

/** Thenable chainable Drizzle mock: builder methods return `this`; awaiting the
 *  chain resolves the next queued value (FIFO). `calls` records values() and
 *  set() payloads for assertions. */
function makeDb() {
  const queue: unknown[] = [];
  const calls: { values: unknown[]; set: unknown[] } = { values: [], set: [] };
  const db: any = {
    queue: (v: unknown) => queue.push(v),
    calls,
  };
  const chain = () => db;
  for (const m of [
    'select', 'from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy',
    'update', 'insert', 'onConflictDoNothing', 'returning', 'delete',
  ]) {
    db[m] = jest.fn(chain);
  }
  db.values = jest.fn((v: unknown) => { calls.values.push(v); return db; });
  db.set = jest.fn((v: unknown) => { calls.set.push(v); return db; });
  db.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    const v = queue.shift();
    if (v instanceof Error) reject(v);
    else resolve(v);
  };
  return db;
}

async function build(db: any): Promise<CommissionService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [CommissionService, { provide: DB_TOKEN, useValue: db }],
  }).compile();
  return mod.get(CommissionService);
}

const ORDER = 'o1';
const TENANT = 't1';

describe('CommissionService.accrueForOrder', () => {
  it('writes one entry per farmer with snapshot rate and rounding', async () => {
    const db = makeDb();
    db.queue([{ id: ORDER, status: 'confirmed', codOutcome: 'received' }]); // order
    db.queue([
      { farmerId: 'f1', quantity: 2, priceStotinki: 305 }, // f1 gross 610
      { farmerId: 'f1', quantity: 1, priceStotinki: 100 }, // f1 gross 710
      { farmerId: 'f2', quantity: 3, priceStotinki: 333 }, // f2 gross 999
      { farmerId: null, quantity: 5, priceStotinki: 100 }, // tenant's own → skipped
    ]); // items
    db.queue([{ settings: { vendorFinance: { commissionEnabled: true, defaultCommissionRateBps: 500 } } }]); // tenant
    db.queue([{ id: 'f1', commissionRateBps: 1000 }, { id: 'f2', commissionRateBps: null }]); // overrides
    db.queue(undefined); // insert
    db.queue(undefined); // revive update

    await (await build(db)).accrueForOrder(ORDER, TENANT);

    expect(db.calls.values).toHaveLength(1);
    const rows = db.calls.values[0] as any[];
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ farmerId: 'f1', grossStotinki: 710, rateBps: 1000, commissionStotinki: 71 }),
        // 999 * 500 / 10000 = 49.95 → 50
        expect.objectContaining({ farmerId: 'f2', grossStotinki: 999, rateBps: 500, commissionStotinki: 50 }),
      ]),
    );
    expect(rows).toHaveLength(2);
    // revive of voided entries fired
    expect(db.calls.set).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'accrued' })]));
  });

  it('records rate 0 while commission is disabled (dormant)', async () => {
    const db = makeDb();
    db.queue([{ id: ORDER, status: 'confirmed', codOutcome: null }]);
    db.queue([{ farmerId: 'f1', quantity: 1, priceStotinki: 1000 }]);
    db.queue([{ settings: {} }]); // no vendorFinance at all
    db.queue([{ id: 'f1', commissionRateBps: 700 }]); // override present but feature OFF
    db.queue(undefined);
    db.queue(undefined);

    await (await build(db)).accrueForOrder(ORDER, TENANT);

    expect(db.calls.values[0]).toEqual([
      expect.objectContaining({ farmerId: 'f1', grossStotinki: 1000, rateBps: 0, commissionStotinki: 0 }),
    ]);
  });

  it.each([
    ['cancelled order', { id: ORDER, status: 'cancelled', codOutcome: null }],
    ['refused COD', { id: ORDER, status: 'confirmed', codOutcome: 'refused' }],
  ])('never accrues on a dead order (%s)', async (_name, order) => {
    const db = makeDb();
    db.queue([order]);
    await (await build(db)).accrueForOrder(ORDER, TENANT);
    expect(db.calls.values).toHaveLength(0);
  });

  it('does nothing when the order has no vendor items', async () => {
    const db = makeDb();
    db.queue([{ id: ORDER, status: 'confirmed', codOutcome: null }]);
    db.queue([{ farmerId: null, quantity: 1, priceStotinki: 500 }]);
    await (await build(db)).accrueForOrder(ORDER, TENANT);
    expect(db.calls.values).toHaveLength(0);
  });

  it('swallows DB errors (fire-and-forget seam safety)', async () => {
    const db = makeDb();
    db.queue(new Error('boom'));
    await expect((await build(db)).accrueForOrder(ORDER, TENANT)).resolves.toBeUndefined();
  });
});

describe('CommissionService.voidForOrder', () => {
  it('voids accrued entries only', async () => {
    const db = makeDb();
    db.queue(undefined); // update
    await (await build(db)).voidForOrder(ORDER, TENANT);
    expect(db.calls.set).toEqual([{ status: 'voided' }]);
  });
});

describe('CommissionService.summary', () => {
  it('aggregates per farmer, names, totals', async () => {
    const db = makeDb();
    db.queue([
      { farmerId: 'f1', grossStotinki: 700, commissionStotinki: 70, status: 'accrued' },
      { farmerId: 'f1', grossStotinki: 300, commissionStotinki: 30, status: 'settled' },
      { farmerId: 'f2', grossStotinki: 999, commissionStotinki: 50, status: 'accrued' },
    ]); // entries
    db.queue([{ id: 'f1', name: 'Васил' }, { id: 'f2', name: 'Мариана' }]); // names
    db.queue([{ settings: { vendorFinance: { commissionEnabled: false } } }]); // tenant

    const s = await (await build(db)).summary(TENANT);
    expect(s.commissionEnabled).toBe(false);
    expect(s.totalGrossStotinki).toBe(1999);
    expect(s.totalCommissionStotinki).toBe(150);
    const f1 = s.farmers.find((f) => f.farmerId === 'f1')!;
    expect(f1).toMatchObject({
      farmerName: 'Васил', orderCount: 2, grossStotinki: 1000,
      commissionStotinki: 100, settledCommissionStotinki: 30,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx jest src/modules/vendor-finance/commission.service.spec.ts`
Expected: FAIL — cannot find module './commission.service'.

- [ ] **Step 3: Implement `commission.service.ts`** (this is the reviewed draft — use verbatim):

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import {
  type Database,
  commissionEntries,
  farmers,
  orderItems,
  orders,
  products,
  tenants,
} from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { readVendorFinance } from './vendor-finance.settings';

/** One farmer's line in the commission summary. */
export interface CommissionFarmerSummary {
  farmerId: string;
  farmerName: string | null;
  orderCount: number;
  grossStotinki: number;
  commissionStotinki: number;
  settledCommissionStotinki: number;
}

export interface CommissionSummary {
  commissionEnabled: boolean;
  defaultRateBps: number;
  farmers: CommissionFarmerSummary[];
  totalGrossStotinki: number;
  totalCommissionStotinki: number;
}

/**
 * Commission ledger over the vendor (`farmers`) attribution that already exists on
 * every order item (order_items → products.farmer_id). No order splitting — one
 * entry per (order, farmer) with the farmer's item-only gross.
 *
 * DORMANT: until `settings.vendorFinance.commissionEnabled` the effective rate is
 * 0 bps, so entries record gross history but charge nothing. The rate is
 * snapshotted per entry at accrual time — flipping the switch later never
 * retro-charges already-collected orders.
 *
 * Accrual fires on the collected-money signal (COD marked received / Stripe paid),
 * void on cancel or COD refusal — the same "collected" semantics as Плащания.
 * All methods swallow their own errors: they run fire-and-forget inside order
 * flows and must never break an order write.
 */
@Injectable()
export class CommissionService {
  private readonly logger = new Logger(CommissionService.name);

  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  /** Record (idempotently) the per-farmer commission entries for a collected order. */
  async accrueForOrder(orderId: string, tenantId: string): Promise<void> {
    try {
      const [order] = await this.db
        .select({
          id: orders.id,
          status: orders.status,
          codOutcome: orders.codOutcome,
        })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
        .limit(1);
      // Defense in depth: never accrue on a dead order even if a seam misfires.
      if (!order || order.status === 'cancelled' || order.codOutcome === 'refused') return;

      const items: { farmerId: string | null; quantity: number; priceStotinki: number }[] =
        await this.db
          .select({
            farmerId: products.farmerId,
            quantity: orderItems.quantity,
            priceStotinki: orderItems.priceStotinki,
          })
          .from(orderItems)
          .innerJoin(products, eq(products.id, orderItems.productId))
          .where(eq(orderItems.orderId, orderId));

      // Item-only gross per farmer (delivery fee excluded — same rule as turnover).
      // Items on products without a farmer are the tenant's own — no commission.
      const grossByFarmer = new Map<string, number>();
      for (const it of items) {
        if (!it.farmerId) continue;
        grossByFarmer.set(
          it.farmerId,
          (grossByFarmer.get(it.farmerId) ?? 0) + it.priceStotinki * it.quantity,
        );
      }
      if (grossByFarmer.size === 0) return;

      const [tenant] = await this.db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const vf = readVendorFinance(tenant?.settings);

      const overrides: { id: string; commissionRateBps: number | null }[] = await this.db
        .select({ id: farmers.id, commissionRateBps: farmers.commissionRateBps })
        .from(farmers)
        .where(inArray(farmers.id, [...grossByFarmer.keys()]));
      const overrideByFarmer = new Map(overrides.map((f) => [f.id, f.commissionRateBps]));

      const rows = [...grossByFarmer.entries()].map(([farmerId, grossStotinki]) => {
        const rateBps = vf.commissionEnabled
          ? (overrideByFarmer.get(farmerId) ?? vf.defaultCommissionRateBps)
          : 0;
        return {
          tenantId,
          orderId,
          farmerId,
          grossStotinki,
          rateBps,
          commissionStotinki: Math.round((grossStotinki * rateBps) / 10_000),
        };
      });

      // Idempotent: the (order, farmer) unique index makes a re-accrue a no-op —
      // the FIRST snapshot (amounts AND rate) always wins.
      await this.db.insert(commissionEntries).values(rows).onConflictDoNothing();

      // Revive entries a COD refusal voided when the outcome is re-marked received
      // (manual re-marks are authoritative). Keeps the original snapshot; settled
      // rows are final and untouched.
      await this.db
        .update(commissionEntries)
        .set({ status: 'accrued' })
        .where(and(eq(commissionEntries.orderId, orderId), eq(commissionEntries.status, 'voided')));
    } catch (e) {
      this.logger.warn(`commission accrue failed for order ${orderId}: ${(e as Error).message}`);
    }
  }

  /** Void the accrued (never settled) entries of a cancelled/refused order. */
  async voidForOrder(orderId: string, tenantId: string): Promise<void> {
    try {
      await this.db
        .update(commissionEntries)
        .set({ status: 'voided' })
        .where(
          and(
            eq(commissionEntries.orderId, orderId),
            eq(commissionEntries.tenantId, tenantId),
            eq(commissionEntries.status, 'accrued'),
          ),
        );
    } catch (e) {
      this.logger.warn(`commission void failed for order ${orderId}: ${(e as Error).message}`);
    }
  }

  /** Per-farmer totals (accrued + settled; voided excluded). Optional farmer/date scope. */
  async summary(
    tenantId: string,
    opts: { farmerId?: string; from?: Date; to?: Date } = {},
  ): Promise<CommissionSummary> {
    const conditions = [
      eq(commissionEntries.tenantId, tenantId),
      ne(commissionEntries.status, 'voided'),
      ...(opts.farmerId ? [eq(commissionEntries.farmerId, opts.farmerId)] : []),
      ...(opts.from ? [gte(commissionEntries.createdAt, opts.from)] : []),
      ...(opts.to ? [lte(commissionEntries.createdAt, opts.to)] : []),
    ];
    const entries: {
      farmerId: string | null;
      grossStotinki: number;
      commissionStotinki: number;
      status: 'accrued' | 'voided' | 'settled';
    }[] = await this.db
      .select({
        farmerId: commissionEntries.farmerId,
        grossStotinki: commissionEntries.grossStotinki,
        commissionStotinki: commissionEntries.commissionStotinki,
        status: commissionEntries.status,
      })
      .from(commissionEntries)
      .where(and(...conditions));

    const byFarmer = new Map<string, CommissionFarmerSummary>();
    for (const e of entries) {
      if (!e.farmerId) continue;
      const row = byFarmer.get(e.farmerId) ?? {
        farmerId: e.farmerId,
        farmerName: null,
        orderCount: 0,
        grossStotinki: 0,
        commissionStotinki: 0,
        settledCommissionStotinki: 0,
      };
      row.orderCount += 1;
      row.grossStotinki += e.grossStotinki;
      row.commissionStotinki += e.commissionStotinki;
      if (e.status === 'settled') row.settledCommissionStotinki += e.commissionStotinki;
      byFarmer.set(e.farmerId, row);
    }

    if (byFarmer.size > 0) {
      const names: { id: string; name: string }[] = await this.db
        .select({ id: farmers.id, name: farmers.name })
        .from(farmers)
        .where(inArray(farmers.id, [...byFarmer.keys()]));
      for (const n of names) {
        const row = byFarmer.get(n.id);
        if (row) row.farmerName = n.name;
      }
    }

    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const vf = readVendorFinance(tenant?.settings);

    const rows = [...byFarmer.values()].sort((a, b) => b.grossStotinki - a.grossStotinki);
    return {
      commissionEnabled: vf.commissionEnabled,
      defaultRateBps: vf.defaultCommissionRateBps,
      farmers: rows,
      totalGrossStotinki: rows.reduce((s, r) => s + r.grossStotinki, 0),
      totalCommissionStotinki: rows.reduce((s, r) => s + r.commissionStotinki, 0),
    };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx jest src/modules/vendor-finance/commission.service.spec.ts`
Expected: all pass. If the thenable mock misbehaves on a chain (e.g. `.limit()` after `.where()`), the queue order in the test must match the service's await order — order fetch, items, tenant, overrides, insert, revive (accrue) / single update (void) / entries, names, tenant (summary).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/vendor-finance
git commit -m "feat(server): CommissionService — dormant accrue/void/summary with rate snapshot"
```

---

### Task 5: VendorSubscriptionService — TDD

**Files:**
- Create: `server/src/modules/vendor-finance/vendor-subscription.service.ts`
- Test: `server/src/modules/vendor-finance/vendor-subscription.service.spec.ts`

**Interfaces:**
- Consumes: Task 3 reader; tables from Task 1.
- Produces: `VendorSubscriptionService` with `generateForPeriod(tenantId: string, period: string): Promise<{ created: number; skipped: number }>`, `list(tenantId: string, period?: string): Promise<VendorChargeRow[]>`, `setStatus(id: string, tenantId: string, status: 'due'|'paid'|'waived', note?: string): Promise<VendorChargeRow>` where `VendorChargeRow = { id: string; farmerId: string | null; farmerName: string | null; period: string; feeStotinki: number; status: 'due'|'paid'|'waived'; paidAt: Date | null; note: string | null }`.

- [ ] **Step 1: Write the failing spec** (same `makeDb()` thenable mock as Task 4 — copy it into this spec file):

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { VendorSubscriptionService } from './vendor-subscription.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

// [copy makeDb() helper from commission.service.spec.ts verbatim]

async function build(db: any): Promise<VendorSubscriptionService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [VendorSubscriptionService, { provide: DB_TOKEN, useValue: db }],
  }).compile();
  return mod.get(VendorSubscriptionService);
}

const TENANT = 't1';

describe('generateForPeriod', () => {
  it('409s while subscriptionEnabled is off (dormant guard)', async () => {
    const db = makeDb();
    db.queue([{ settings: {} }]);
    await expect((await build(db)).generateForPeriod(TENANT, '2026-07')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects a malformed period', async () => {
    const db = makeDb();
    await expect((await build(db)).generateForPeriod(TENANT, '2026-13')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('creates due rows with override > default fee, skips fee 0', async () => {
    const db = makeDb();
    db.queue([{ settings: { vendorFinance: { subscriptionEnabled: true, defaultSubscriptionFeeStotinki: 1200 } } }]);
    db.queue([
      { id: 'f1', subscriptionFeeStotinki: null },  // default 1200
      { id: 'f2', subscriptionFeeStotinki: 500 },   // override
      { id: 'f3', subscriptionFeeStotinki: 0 },     // skipped
    ]);
    db.queue([{ id: 'c1' }, { id: 'c2' }]); // insert returning
    const res = await (await build(db)).generateForPeriod(TENANT, '2026-07');
    expect(db.calls.values[0]).toEqual([
      expect.objectContaining({ farmerId: 'f1', period: '2026-07', feeStotinki: 1200 }),
      expect.objectContaining({ farmerId: 'f2', period: '2026-07', feeStotinki: 500 }),
    ]);
    expect(res).toEqual({ created: 2, skipped: 1 });
  });
});

describe('setStatus', () => {
  it('marks paid with paidAt, 404s on missing row', async () => {
    const db = makeDb();
    db.queue([{ id: 'c1', farmerId: 'f1', period: '2026-07', feeStotinki: 1200, status: 'paid', paidAt: new Date(), note: null }]);
    const row = await (await build(db)).setStatus('c1', TENANT, 'paid');
    expect(row.status).toBe('paid');
    expect(db.calls.set[0]).toMatchObject({ status: 'paid' });
    expect((db.calls.set[0] as any).paidAt).toBeInstanceOf(Date);

    const db2 = makeDb();
    db2.queue([]);
    await expect((await build(db2)).setStatus('nope', TENANT, 'waived')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('list', () => {
  it('joins farmer names', async () => {
    const db = makeDb();
    db.queue([
      { id: 'c1', farmerId: 'f1', period: '2026-07', feeStotinki: 1200, status: 'due', paidAt: null, note: null },
    ]);
    db.queue([{ id: 'f1', name: 'Васил' }]);
    const rows = await (await build(db)).list(TENANT, '2026-07');
    expect(rows[0].farmerName).toBe('Васил');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx jest src/modules/vendor-finance/vendor-subscription.service.spec.ts`
Expected: FAIL — cannot find module './vendor-subscription.service'.

- [ ] **Step 3: Implement `vendor-subscription.service.ts`** (reviewed draft — verbatim):

```ts
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { type Database, farmers, tenants, vendorSubscriptionCharges } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { readVendorFinance } from './vendor-finance.settings';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface VendorChargeRow {
  id: string;
  farmerId: string | null;
  farmerName: string | null;
  period: string;
  feeStotinki: number;
  status: 'due' | 'paid' | 'waived';
  paidAt: Date | null;
  note: string | null;
}

/**
 * Vendor monthly subscription tracker (DORMANT until
 * `settings.vendorFinance.subscriptionEnabled`). Nothing is auto-charged anywhere:
 * the operator collects the fee off-platform (as today) and this ledger only
 * answers "who owes what for which month". Generation is an explicit owner action
 * (no cron), idempotent per (farmer, period).
 */
@Injectable()
export class VendorSubscriptionService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  /** Create the month's `due` rows for every farmer with a resolvable fee > 0. */
  async generateForPeriod(
    tenantId: string,
    period: string,
  ): Promise<{ created: number; skipped: number }> {
    if (!PERIOD_RE.test(period)) {
      throw new BadRequestException('Невалиден период — очаква се формат YYYY-MM.');
    }
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');
    const vf = readVendorFinance(tenant.settings);
    if (!vf.subscriptionEnabled) {
      throw new ConflictException(
        'Абонаментното таксуване е изключено за тази ферма (settings.vendorFinance.subscriptionEnabled).',
      );
    }

    const vendorRows: { id: string; subscriptionFeeStotinki: number | null }[] = await this.db
      .select({ id: farmers.id, subscriptionFeeStotinki: farmers.subscriptionFeeStotinki })
      .from(farmers)
      .where(eq(farmers.tenantId, tenantId));

    const rows = vendorRows
      .map((f) => ({
        tenantId,
        farmerId: f.id,
        period,
        feeStotinki: f.subscriptionFeeStotinki ?? vf.defaultSubscriptionFeeStotinki,
      }))
      .filter((r) => r.feeStotinki > 0);
    if (rows.length === 0) return { created: 0, skipped: vendorRows.length };

    // Idempotent: (farmer, period) unique index — re-running a month is a no-op.
    const inserted: { id: string }[] = await this.db
      .insert(vendorSubscriptionCharges)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: vendorSubscriptionCharges.id });

    return { created: inserted.length, skipped: vendorRows.length - inserted.length };
  }

  /** Charges for the tenant (optionally one month), newest period first. */
  async list(tenantId: string, period?: string): Promise<VendorChargeRow[]> {
    if (period && !PERIOD_RE.test(period)) {
      throw new BadRequestException('Невалиден период — очаква се формат YYYY-MM.');
    }
    const rows: Omit<VendorChargeRow, 'farmerName'>[] = await this.db
      .select({
        id: vendorSubscriptionCharges.id,
        farmerId: vendorSubscriptionCharges.farmerId,
        period: vendorSubscriptionCharges.period,
        feeStotinki: vendorSubscriptionCharges.feeStotinki,
        status: vendorSubscriptionCharges.status,
        paidAt: vendorSubscriptionCharges.paidAt,
        note: vendorSubscriptionCharges.note,
      })
      .from(vendorSubscriptionCharges)
      .where(
        and(
          eq(vendorSubscriptionCharges.tenantId, tenantId),
          ...(period ? [eq(vendorSubscriptionCharges.period, period)] : []),
        ),
      )
      .orderBy(desc(vendorSubscriptionCharges.period), desc(vendorSubscriptionCharges.createdAt));

    const farmerIds = [...new Set(rows.map((r) => r.farmerId).filter((v): v is string => !!v))];
    const nameById = new Map<string, string>();
    if (farmerIds.length > 0) {
      const names: { id: string; name: string }[] = await this.db
        .select({ id: farmers.id, name: farmers.name })
        .from(farmers)
        .where(inArray(farmers.id, farmerIds));
      for (const n of names) nameById.set(n.id, n.name);
    }
    return rows.map((r) => ({ ...r, farmerName: r.farmerId ? (nameById.get(r.farmerId) ?? null) : null }));
  }

  /** Owner bookkeeping: mark a charge paid / waived / back to due. */
  async setStatus(
    id: string,
    tenantId: string,
    status: 'due' | 'paid' | 'waived',
    note?: string,
  ): Promise<VendorChargeRow> {
    const [row] = await this.db
      .update(vendorSubscriptionCharges)
      .set({
        status,
        paidAt: status === 'paid' ? new Date() : null,
        ...(note !== undefined ? { note: note || null } : {}),
      })
      .where(
        and(eq(vendorSubscriptionCharges.id, id), eq(vendorSubscriptionCharges.tenantId, tenantId)),
      )
      .returning({
        id: vendorSubscriptionCharges.id,
        farmerId: vendorSubscriptionCharges.farmerId,
        period: vendorSubscriptionCharges.period,
        feeStotinki: vendorSubscriptionCharges.feeStotinki,
        status: vendorSubscriptionCharges.status,
        paidAt: vendorSubscriptionCharges.paidAt,
        note: vendorSubscriptionCharges.note,
      });
    if (!row) throw new NotFoundException('Таксата не е намерена');
    return { ...row, farmerName: null };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx jest src/modules/vendor-finance/vendor-subscription.service.spec.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/vendor-finance
git commit -m "feat(server): VendorSubscriptionService — dormant monthly charge ledger"
```

---

### Task 6: DTOs, controller, module + app registration

**Files:**
- Create: `server/src/modules/vendor-finance/dto/vendor-finance.dto.ts`
- Create: `server/src/modules/vendor-finance/vendor-finance.controller.ts`
- Create: `server/src/modules/vendor-finance/vendor-finance.module.ts`
- Modify: `server/src/app.module.ts` (import + add `VendorFinanceModule` to the imports array, near `BillingModule`)

**Interfaces:**
- Consumes: `CommissionService.summary`, `VendorSubscriptionService.{list,generateForPeriod,setStatus}` (Tasks 4-5); `effectiveFarmerId` from `server/src/common/scope/farmer-scope.util`; `Roles` decorator, `JwtAuthGuard`, `CurrentTenant`, `CurrentUser` (existing common).
- Produces: HTTP API `GET /vendor-finance/commission/summary` (roles admin+farmer), `GET /vendor-finance/subscriptions`, `POST /vendor-finance/subscriptions/generate`, `PATCH /vendor-finance/subscriptions/:id` (admin only). Panel Tasks 9-11 call these paths via the BFF.

- [ ] **Step 1: DTOs** (`dto/vendor-finance.dto.ts`):

```ts
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

const PERIOD_MSG = 'Невалиден период — очаква се формат YYYY-MM.';

export class CommissionSummaryQueryDto {
  /** Owner-only narrowing; a producer token is always forced to its own farmerId. */
  @IsOptional()
  @IsUUID()
  farmerId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class GenerateChargesDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: PERIOD_MSG })
  period!: string;
}

export class ListChargesQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: PERIOD_MSG })
  period?: string;
}

export class UpdateChargeDto {
  @IsIn(['due', 'paid', 'waived'])
  status!: 'due' | 'paid' | 'waived';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
```

- [ ] **Step 2: Controller** (`vendor-finance.controller.ts`):

```ts
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { effectiveFarmerId } from '../../common/scope/farmer-scope.util';
import type { TenantRequestUser } from '@fermeribg/types';
import { CommissionService } from './commission.service';
import { VendorSubscriptionService } from './vendor-subscription.service';
import {
  CommissionSummaryQueryDto,
  GenerateChargesDto,
  ListChargesQueryDto,
  UpdateChargeDto,
} from './dto/vendor-finance.dto';

/**
 * Read/bookkeeping API over the DORMANT vendor-finance ledgers. Nothing here
 * charges anyone; the endpoints only report what the (currently 0-rate)
 * commission ledger recorded and let the owner track manually-collected
 * subscription fees. Safe to expose while the feature sleeps.
 */
@ApiTags('vendor-finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('vendor-finance')
export class VendorFinanceController {
  constructor(
    private readonly commission: CommissionService,
    private readonly subscriptions: VendorSubscriptionService,
  ) {}

  // Owner sees every producer (optionally narrowed via ?farmerId); a producer
  // sub-account is forced to its own farmerId — same IDOR scope as /stats.
  @Get('commission/summary')
  @Roles('admin', 'farmer')
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  commissionSummary(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Query() q: CommissionSummaryQueryDto,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, q.farmerId);
    return this.commission.summary(tenantId, {
      farmerId: scope ?? undefined,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
  }

  @Get('subscriptions')
  @Roles('admin')
  @ApiQuery({ name: 'period', required: false, description: 'YYYY-MM' })
  listCharges(@CurrentTenant() tenantId: string, @Query() q: ListChargesQueryDto) {
    return this.subscriptions.list(tenantId, q.period);
  }

  // Explicit owner action (no cron): create the month's `due` rows. Refuses to
  // run while settings.vendorFinance.subscriptionEnabled is off (409).
  @Post('subscriptions/generate')
  @Roles('admin')
  generateCharges(@CurrentTenant() tenantId: string, @Body() dto: GenerateChargesDto) {
    return this.subscriptions.generateForPeriod(tenantId, dto.period);
  }

  @Patch('subscriptions/:id')
  @Roles('admin')
  updateCharge(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateChargeDto,
  ) {
    return this.subscriptions.setStatus(id, tenantId, dto.status, dto.note);
  }
}
```

- [ ] **Step 3: Module** (`vendor-finance.module.ts`):

```ts
import { Module } from '@nestjs/common';
import { CommissionService } from './commission.service';
import { VendorSubscriptionService } from './vendor-subscription.service';
import { VendorFinanceController } from './vendor-finance.controller';

/**
 * DORMANT vendor-finance ledgers (commission + vendor monthly subscriptions).
 * Exported CommissionService is injected @Optional() into the order/stripe money
 * seams — with the per-tenant settings switch off it records 0-rate entries and
 * charges nothing. See vendor-finance.settings.ts for how to wake it up.
 */
@Module({
  controllers: [VendorFinanceController],
  providers: [CommissionService, VendorSubscriptionService],
  exports: [CommissionService],
})
export class VendorFinanceModule {}
```

- [ ] **Step 4: Register in `server/src/app.module.ts`** — add `import { VendorFinanceModule } from './modules/vendor-finance/vendor-finance.module';` with the other module imports and `VendorFinanceModule,` in the `imports:` array (next to `BillingModule`).

- [ ] **Step 5: Type-check + boot check**

Run: `cd server && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/vendor-finance server/src/app.module.ts
git commit -m "feat(server): vendor-finance API — commission summary + subscription ledger (owner/producer scoped)"
```

---

### Task 7: Money seams — orders cancel/COD + Stripe paid

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts` (imports ~line 1-8 and ~40; constructor ~line 442; `updateStatus` cancel branch ~line 1310-1360; `setCodOutcome` tail ~line 1440-1450)
- Modify: `server/src/modules/orders/orders.module.ts` (imports array)
- Modify: `server/src/modules/stripe/stripe.service.ts` (constructor ~line 102; paid-flip block ~line 728-745)
- Modify: `server/src/modules/stripe/stripe.module.ts` (imports array)

**Interfaces:**
- Consumes: `CommissionService.accrueForOrder/voidForOrder` (Task 4), `VendorFinanceModule` (Task 6).
- Produces: dormant ledger writes on the three collected-money transitions. NO other behavior change.

- [ ] **Step 1: orders.service imports** — add `Optional` to the `@nestjs/common` import list, and below the `CatalogCacheService` import add:

```ts
import { CommissionService } from '../vendor-finance/commission.service';
```

- [ ] **Step 2: orders.service constructor** — append as LAST parameter:

```ts
    // DORMANT commission ledger. @Optional() keeps the existing OrdersService
    // test harnesses valid; in the app the module is always wired.
    @Optional() private readonly commission?: CommissionService,
```

- [ ] **Step 3: cancel seam** — in `updateStatus`, the into-cancelled branch ends with the transaction block (`variantStockTouched = await this.restoreVariantStock(tx, items); });`). Directly AFTER that closing `});` and still inside the `if (dto.status === 'cancelled' && prev?.status !== 'cancelled') {` block, add:

```ts
      // Cancelled order collects no money — void its (dormant) commission entries.
      // Fire-and-forget: the ledger must never block or fail an order write.
      void this.commission?.voidForOrder(id, tenantId);
```

- [ ] **Step 4: COD seam** — in `setCodOutcome`, after the `codRisk.recordManualRefusal` try/catch block and BEFORE `await this.bustPayments(tenantId);`, add:

```ts
    // COD money outcome IS the collected-money signal the (dormant) commission
    // ledger accrues on: received → accrue (revives a voided re-mark), refused →
    // void. Fire-and-forget — must never block the outcome write.
    if (dto.outcome === 'received') void this.commission?.accrueForOrder(id, tenantId);
    else void this.commission?.voidForOrder(id, tenantId);
```

Note: `setCodOutcomeForFarmer` delegates to `setCodOutcome`, so the producer path is covered automatically.

- [ ] **Step 5: orders.module** — add `import { VendorFinanceModule } from '../vendor-finance/vendor-finance.module';` and `VendorFinanceModule,` to the `imports:` array.

- [ ] **Step 6: stripe.service** — add `Optional` to its `@nestjs/common` import; add `import { CommissionService } from '../vendor-finance/commission.service';`; append constructor param:

```ts
    @Optional() private readonly commission?: CommissionService,
```

In the paid-webhook handler, directly after `if (!flipped.length) return; // already confirmed by the sibling event`, add:

```ts
    // Card money is collected at this exact flip — accrue the (dormant) commission.
    void this.commission?.accrueForOrder(orderId, tenantId);
```

- [ ] **Step 7: stripe.module** — add `VendorFinanceModule` to its `imports:` array (same import line as Step 5).

- [ ] **Step 8: Prove existing suites stay green WITHOUT edits**

Run: `cd server && npx jest src/modules/orders src/modules/stripe`
Expected: all existing specs pass unchanged (the `@Optional()` injection means their harnesses resolve `undefined` and the `?.` seams no-op).

- [ ] **Step 9: Full server suite**

Run: `cd server && npm test`
Expected: entire suite green (370+ tests).

- [ ] **Step 10: Commit**

```bash
git add server/src/modules/orders server/src/modules/stripe
git commit -m "feat(server): wire dormant commission seams — COD outcome, Stripe paid, cancel void"
```

---

### Task 8: Panel API client methods

**Files:**
- Modify: `client/src/lib/api-client.ts` (append near the billing/payments exports)

**Interfaces:**
- Consumes: HTTP API from Task 6 (via the existing `/bff/` proxy and `apiFetch` helper).
- Produces: types `CommissionSummary`, `CommissionFarmerSummary`, `VendorCharge`; functions `getCommissionSummary`, `listVendorCharges`, `generateVendorCharges`, `updateVendorCharge`. Tasks 9-11 import these.

- [ ] **Step 1: Append to `api-client.ts`** (mirror the file's existing `apiFetch`/`json` idioms — check how `updateProduct` builds a PATCH and copy that exact shape):

```ts
// --- Vendor finance (дремещ модул: комисиона + месечни такси на производители) ---
export type CommissionFarmerSummary = {
  farmerId: string;
  farmerName: string | null;
  orderCount: number;
  grossStotinki: number;
  commissionStotinki: number;
  settledCommissionStotinki: number;
};
export type CommissionSummary = {
  commissionEnabled: boolean;
  defaultRateBps: number;
  farmers: CommissionFarmerSummary[];
  totalGrossStotinki: number;
  totalCommissionStotinki: number;
};
export const getCommissionSummary = (q?: { farmerId?: string; from?: string; to?: string }) => {
  const p = new URLSearchParams();
  if (q?.farmerId) p.set('farmerId', q.farmerId);
  if (q?.from) p.set('from', q.from);
  if (q?.to) p.set('to', q.to);
  const s = p.toString();
  return apiFetch<CommissionSummary>(`vendor-finance/commission/summary${s ? `?${s}` : ''}`);
};

export type VendorCharge = {
  id: string;
  farmerId: string | null;
  farmerName: string | null;
  period: string;
  feeStotinki: number;
  status: 'due' | 'paid' | 'waived';
  paidAt: string | null;
  note: string | null;
};
export const listVendorCharges = (period?: string) =>
  apiFetch<VendorCharge[]>(`vendor-finance/subscriptions${period ? `?period=${period}` : ''}`);
export const generateVendorCharges = (period: string) =>
  apiFetch<{ created: number; skipped: number }>('vendor-finance/subscriptions/generate', {
    ...json({ period }),
    method: 'POST',
  });
export const updateVendorCharge = (id: string, data: { status: 'due' | 'paid' | 'waived'; note?: string }) =>
  apiFetch<VendorCharge>(`vendor-finance/subscriptions/${id}`, { ...json(data), method: 'PATCH' });
```

- [ ] **Step 2: Type-check**

Run: `cd client && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/api-client.ts
git commit -m "feat(client): vendor-finance api-client methods + types"
```

---

### Task 9: Owner screen «Финанси на пазара»

**Files:**
- Create: `client/src/app/(admin)/marketplace-finance/page.tsx`
- Create: `client/src/components/marketplace-finance/marketplace-finance-client.tsx`
- Modify: `client/src/components/layout/sidebar.tsx` (add nav item in the Продажби group, after the `/payments` item ~line 79)

**Interfaces:**
- Consumes: Task 8 client methods.
- Produces: owner-only page at `/marketplace-finance` with two sections: Комисиона (summary table) and Абонаменти (ledger + generate + mark paid/waived).

- [ ] **Step 1: Sidebar entry — GATED on `multiFarmer`** — after the `/payments` line in the admin nav array:

```ts
      { href: '/marketplace-finance', label: 'Финанси на пазара', Icon: HandCoins, desc: 'Комисиона по производители и месечни такси — води кой колко дължи.' },
```

Add `HandCoins` to the existing `lucide-react` import in the same file.

Then gate it exactly like `/articles` and `/route` are gated: `sidebar.tsx`'s
`visibleItems` filter already switches per-href on flags passed in as props
(`articlesEnabled`, `deliveryEnabled`). Trace where those props are populated
(the shell/layout that renders `<Sidebar>` — it reads the tenant bootstrap),
add a `multiFarmer: boolean` prop through the same path, and extend the filter:

```ts
        (i.href === '/marketplace-finance' ? multiFarmer : true) &&
```

Result: a normal single-farm tenant NEVER sees the item — zero panel change
for every non-marketplace farm.

- [ ] **Step 2: Server page** (`page.tsx`) — mirror the payments page pattern (force-dynamic, token fetch, fallbacks):

```tsx
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { MarketplaceFinanceClient } from '@/components/marketplace-finance/marketplace-finance-client';
import type { CommissionSummary, VendorCharge } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY_SUMMARY: CommissionSummary = {
  commissionEnabled: false,
  defaultRateBps: 0,
  farmers: [],
  totalGrossStotinki: 0,
  totalCommissionStotinki: 0,
};

async function getJson<T>(path: string, fallback: T): Promise<T> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return fallback;
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return fallback;
  return (await res.json()) as T;
}

export default async function MarketplaceFinancePage() {
  const [summary, charges] = await Promise.all([
    getJson<CommissionSummary>('vendor-finance/commission/summary', EMPTY_SUMMARY),
    getJson<VendorCharge[]>('vendor-finance/subscriptions', []),
  ]);
  return <MarketplaceFinanceClient initialSummary={summary} initialCharges={charges} />;
}
```

(If `API_BASE`/`SESSION_COOKIE` are exported differently in `@/lib/session`, copy the exact pattern from `client/src/app/(admin)/payments/page.tsx` — same idiom.)

- [ ] **Step 3: Client component** (`marketplace-finance-client.tsx`):

```tsx
'use client';

import { useState } from 'react';
import {
  type CommissionSummary,
  type VendorCharge,
  generateVendorCharges,
  listVendorCharges,
  updateVendorCharge,
} from '@/lib/api-client';

const euro = (stotinki: number) => `${(stotinki / 100).toFixed(2)} €`;
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
const currentPeriod = () => new Date().toISOString().slice(0, 7);

const CHARGE_LABEL: Record<VendorCharge['status'], string> = {
  due: 'Дължима',
  paid: 'Платена',
  waived: 'Опростена',
};

export function MarketplaceFinanceClient({
  initialSummary,
  initialCharges,
}: {
  initialSummary: CommissionSummary;
  initialCharges: VendorCharge[];
}) {
  const [summary] = useState(initialSummary);
  const [charges, setCharges] = useState(initialCharges);
  const [period, setPeriod] = useState(currentPeriod());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    setCharges(await listVendorCharges());
  }

  async function onGenerate() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await generateVendorCharges(period);
      setMsg(`Създадени ${r.created} такси (${r.skipped} пропуснати).`);
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Грешка при генериране.');
    } finally {
      setBusy(false);
    }
  }

  async function onMark(id: string, status: VendorCharge['status']) {
    setBusy(true);
    try {
      await updateVendorCharge(id, { status });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8 p-6">
      <div>
        <h1 className="text-xl font-semibold">Финанси на пазара</h1>
        <p className="text-sm text-muted-foreground">
          Комисиона по производители и месечни такси. Ти събираш парите — тук само се води кой колко дължи.
        </p>
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-medium">Комисиона</h2>
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {summary.commissionEnabled ? `включена · ${pct(summary.defaultRateBps)}` : 'изключена'}
          </span>
        </div>
        {summary.farmers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Още няма записани продажби по производители.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2">Производител</th>
                <th className="py-2 text-right">Поръчки</th>
                <th className="py-2 text-right">Оборот</th>
                <th className="py-2 text-right">Комисиона</th>
              </tr>
            </thead>
            <tbody>
              {summary.farmers.map((f) => (
                <tr key={f.farmerId} className="border-b last:border-0">
                  <td className="py-2">{f.farmerName ?? '—'}</td>
                  <td className="py-2 text-right">{f.orderCount}</td>
                  <td className="py-2 text-right">{euro(f.grossStotinki)}</td>
                  <td className="py-2 text-right">{euro(f.commissionStotinki)}</td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="py-2">Общо</td>
                <td />
                <td className="py-2 text-right">{euro(summary.totalGrossStotinki)}</td>
                <td className="py-2 text-right">{euro(summary.totalCommissionStotinki)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Месечни такси</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            placeholder="2026-07"
            className="h-9 w-28 rounded-md border px-2 text-sm"
            aria-label="Период (YYYY-MM)"
          />
          <button
            onClick={onGenerate}
            disabled={busy}
            className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            Генерирай месеца
          </button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </div>
        {charges.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Няма генерирани такси. Генерирането изисква включено абонаментно таксуване в настройките.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2">Производител</th>
                <th className="py-2">Месец</th>
                <th className="py-2 text-right">Такса</th>
                <th className="py-2">Статус</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="py-2">{c.farmerName ?? '—'}</td>
                  <td className="py-2">{c.period}</td>
                  <td className="py-2 text-right">{euro(c.feeStotinki)}</td>
                  <td className="py-2">{CHARGE_LABEL[c.status]}</td>
                  <td className="py-2 text-right">
                    {c.status !== 'paid' && (
                      <button
                        onClick={() => onMark(c.id, 'paid')}
                        disabled={busy}
                        className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
                      >
                        Платена
                      </button>
                    )}{' '}
                    {c.status === 'due' && (
                      <button
                        onClick={() => onMark(c.id, 'waived')}
                        disabled={busy}
                        className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
                      >
                        Опрости
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

(Styling: reuse the panel's existing table/button utility classes — if the payments client uses shared UI components (`@/components/ui/*`), swap the raw elements for those, keeping the same structure.)

- [ ] **Step 4: Build check**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/\(admin\)/marketplace-finance client/src/components/marketplace-finance client/src/components/layout/sidebar.tsx
git commit -m "feat(client): owner screen «Финанси на пазара» — commission summary + subscription ledger"
```

---

### Task 10: Producer screen «Моят отчет»

**Files:**
- Create: `client/src/app/(admin)/my-report/page.tsx`
- Create: `client/src/components/my-report/my-report-client.tsx`
- Modify: `client/src/components/layout/sidebar.tsx` (producer nav array, ~line 120 — the reduced `role='farmer'` list)

**Interfaces:**
- Consumes: `getCommissionSummary` (Task 8) — the server forces the producer to its own farmerId, so the client passes no farmerId.
- Produces: producer page `/my-report` showing own turnover + (dormant) commission.

- [ ] **Step 1: Producer nav entry** — in the producer nav array in `sidebar.tsx` add:

```ts
  { href: '/my-report', label: 'Моят отчет', Icon: BarChart3, desc: 'Твоят оборот от пазара и комисионата (ако е включена).' },
```

(`BarChart3` is already imported for the admin /stats entry — reuse.)

- [ ] **Step 2: Server page** (`my-report/page.tsx`) — same getJson pattern as Task 9 Step 2, fetching only the summary:

```tsx
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { MyReportClient } from '@/components/my-report/my-report-client';
import type { CommissionSummary } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY: CommissionSummary = {
  commissionEnabled: false,
  defaultRateBps: 0,
  farmers: [],
  totalGrossStotinki: 0,
  totalCommissionStotinki: 0,
};

export default async function MyReportPage() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  let summary = EMPTY;
  if (token) {
    const res = await fetch(`${API_BASE}/vendor-finance/commission/summary`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (res.ok) summary = (await res.json()) as CommissionSummary;
  }
  return <MyReportClient summary={summary} />;
}
```

- [ ] **Step 3: Client component** (`my-report-client.tsx`):

```tsx
'use client';

import type { CommissionSummary } from '@/lib/api-client';

const euro = (stotinki: number) => `${(stotinki / 100).toFixed(2)} €`;

export function MyReportClient({ summary }: { summary: CommissionSummary }) {
  const me = summary.farmers[0]; // producer scope returns at most own row
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Моят отчет</h1>
        <p className="text-sm text-muted-foreground">
          Оборотът ти от събраните поръчки на пазара{summary.commissionEnabled ? ' и дължимата комисиона' : ''}.
        </p>
      </div>
      {!me ? (
        <p className="text-sm text-muted-foreground">Още няма събрани поръчки с твои продукти.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">Поръчки</div>
            <div className="mt-1 text-2xl font-semibold">{me.orderCount}</div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">Оборот</div>
            <div className="mt-1 text-2xl font-semibold">{euro(me.grossStotinki)}</div>
          </div>
          {summary.commissionEnabled && (
            <div className="rounded-lg border p-4">
              <div className="text-sm text-muted-foreground">Комисиона</div>
              <div className="mt-1 text-2xl font-semibold">{euro(me.commissionStotinki)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Build check**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/\(admin\)/my-report client/src/components/my-report client/src/components/layout/sidebar.tsx
git commit -m "feat(client): producer screen «Моят отчет» — own turnover + dormant commission"
```

---

### Task 11: Farmer form — finance override fields (server DTO + panel form)

**Files:**
- Modify: `server/src/modules/farmers/dto/create-farmer.dto.ts` (add two optional validated fields)
- Modify: `server/src/modules/farmers/dto/update-farmer.dto.ts` (same two fields — if it extends `PartialType(CreateFarmerDto)`, only the create DTO needs the change; check first)
- Modify: `server/src/modules/farmers/farmers.service.ts` (include the two columns in the create `values({...})` and update `.set({...})` objects)
- Modify: `client/src/components/farmers/farmer-panel.tsx` (two inputs + save payload)

**Interfaces:**
- Consumes: `farmers.commissionRateBps` / `farmers.subscriptionFeeStotinki` (Task 1).
- Produces: owner can set per-farmer % and monthly fee from the farmer edit panel; values flow through the existing farmers API.

- [ ] **Step 1: DTO fields** — in `create-farmer.dto.ts` (and `update-farmer.dto.ts` if not a PartialType):

```ts
  /** Комисиона override в базисни точки (500 = 5%). NULL = наследява настройката на фермата. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  commissionRateBps?: number | null;

  /** Месечна такса override в стотинки/евроценти (1200 = 12 €). NULL = наследява настройката. */
  @IsOptional()
  @IsInt()
  @Min(0)
  subscriptionFeeStotinki?: number | null;
```

Add `IsInt, Max, Min` to the existing `class-validator` import if missing.

- [ ] **Step 2: Service passthrough** — in `farmers.service.ts`, add to BOTH the create `values({...})` and the update `.set({...})` objects (matching how `since`/`bio` are passed):

```ts
      commissionRateBps: dto.commissionRateBps ?? null,
      subscriptionFeeStotinki: dto.subscriptionFeeStotinki ?? null,
```

For update, only set when provided (mirror the file's existing partial-update idiom — if it builds the set object conditionally, follow that: `...(dto.commissionRateBps !== undefined ? { commissionRateBps: dto.commissionRateBps } : {})`).

- [ ] **Step 3: Run farmers server specs**

Run: `cd server && npx jest src/modules/farmers`
Expected: existing DTO/access specs stay green.

- [ ] **Step 4: Panel form** — in `client/src/components/farmers/farmer-panel.tsx`: add state next to the `since` state:

```tsx
  const [commissionPct, setCommissionPct] = useState(
    farmer.commissionRateBps != null ? String(farmer.commissionRateBps / 100) : '',
  );
  const [monthlyFee, setMonthlyFee] = useState(
    farmer.subscriptionFeeStotinki != null ? String(farmer.subscriptionFeeStotinki / 100) : '',
  );
```

In the save payload (where `since: since.trim(),` is sent) add:

```tsx
        commissionRateBps: commissionPct.trim() === '' ? null : Math.round(parseFloat(commissionPct) * 100),
        subscriptionFeeStotinki: monthlyFee.trim() === '' ? null : Math.round(parseFloat(monthlyFee) * 100),
```

In the form JSX, after the „От коя година" (`since`) field, add two labeled inputs using the same `field` className:

```tsx
            <label className="block">
              Комисиона % (празно = по подразбиране)
              <input value={commissionPct} onChange={(e) => setCommissionPct(e.target.value)} inputMode="decimal" placeholder="5" className={field} />
            </label>
            <label className="block">
              Месечна такса € (празно = по подразбиране)
              <input value={monthlyFee} onChange={(e) => setMonthlyFee(e.target.value)} inputMode="decimal" placeholder="12" className={field} />
            </label>
```

Also extend the panel `Farmer` type (wherever the farmers client types live — `@/lib/api-client` or local) with `commissionRateBps?: number | null; subscriptionFeeStotinki?: number | null;`.

- [ ] **Step 5: Build + verify**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/farmers client/src/components/farmers client/src/lib/api-client.ts
git commit -m "feat: per-farmer finance overrides — % and monthly fee fields (dormant defaults)"
```

---

### Task 12: End-to-end dormancy verification

**Files:** none (verification only)

- [ ] **Step 1: Full server suite** — `cd server && npm test` → green.
- [ ] **Step 2: Client build** — `cd client && npm run build` → green.
- [ ] **Step 3: Manual dormancy check on dev** (dev DB port 5433, seeded tenant):
  1. Start server + client dev.
  2. Place a COD order with a vendor product via storefront/dev intake; mark it «Получих парите» in Плащания.
  3. `psql -p 5433 -c "SELECT farmer_id, gross_stotinki, rate_bps, commission_stotinki, status FROM commission_entries"` → row exists, `rate_bps = 0`, `commission_stotinki = 0`, status `accrued`.
  4. Cancel the order → same query → status `voided`.
  5. Open `/marketplace-finance` as owner → commission badge shows «изключена», ledger shows the gross; «Генерирай месеца» returns the 409 message about изключено таксуване.
  6. Open `/my-report` as a producer login → own turnover visible.
  7. Confirm NOTHING changed for buyers: storefront checkout flow untouched.
- [ ] **Step 4: Compatibility sweep for existing tenants** (the "will the current
  sites keep working" check):
  1. `cd server && npx jest src/modules/farmers src/modules/public-bootstrap` → green.
  2. With dev server running, hit the public bootstrap of the seeded tenant
     (`curl http://localhost:<api-port>/public/bootstrap/<slug>` — copy the exact
     path chaika uses) and confirm the farmers array has NO
     `commissionRateBps`/`subscriptionFeeStotinki` keys.
  3. Log into the panel as a NON-multiFarmer tenant → sidebar has no «Финанси
     на пазара»; as the marketplace tenant → item present.
- [ ] **Step 5: Final commit if any fixups**

```bash
git add -A && git commit -m "test: vendor-finance dormancy verification fixups"
```

**DO NOT PUSH YET — pre-push runbook (the human executes, in this order):**

1. **Apply the migration to prod FIRST.** Deploy does not run migrations, and
   new code against an unmigrated DB 500s every farmers query (storefronts go
   down). The DDL is additive — old code ignores it completely, so migrating
   first is zero-risk. From the local machine, tunnel to the prod DB через the
   app box (postgres lives on the DB box's private IP):

```bash
ssh -L 15432:10.0.0.3:5432 root@<app-box>   # keep open
# in a second shell, with the prod credentials from the box's .env:
DATABASE_URL='postgres://<user>:<pass>@localhost:15432/<db>' pnpm db:migrate
# verify:
psql 'postgres://<user>:<pass>@localhost:15432/<db>' -c '\d commission_entries'
```

2. **Then** `git push` → auto-deploy ships the code.
3. **Post-deploy smoke:** open farmmarket.bg/фермери + one other tenant
   storefront → farmers render; open the panel of a normal farm → no new nav
   item; open the marketplace tenant panel → «Финанси на пазара» loads.
