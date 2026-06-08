# наложен платеж (Cash on Delivery) Payment Choice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a storefront customer choose how to pay — card online (Stripe) or наложен платеж (cash on delivery) — with the farm able to toggle COD on/off, so Econt orders can ship manually (no API) and be paid at the office.

**Architecture:** New `orders.payment_method` enum column + a `settings.delivery.cod.enabled` farm flag. The checkout DTO carries the customer's choice; `CheckoutService` skips Stripe for COD and normalizes the stored method to reality (any non-Stripe order = `cod`). The public profile exposes `codEnabled` + `stripeEnabled` so each storefront renders the right radios. Manual Econt delivery already exists (`EcontMode='manual'`) — no Econt code changes.

**Tech Stack:** NestJS + Drizzle ORM (Postgres) backend; Next.js storefront + admin (React/TS); Jest tests. Money is integer stotinki (euro-cents).

**Spec:** `docs/superpowers/specs/2026-06-08-cod-payment-method-design.md`

---

## File structure

**Backend (`server/`, `packages/db/`)**
- `packages/db/src/schema.ts` — add `paymentMethodEnum` + `orders.payment_method` column.
- `packages/db/drizzle/0032_*.sql` — generated migration.
- `server/src/modules/orders/delivery-pricing.ts` — `cod` in `DeliveryConfig` + `codEnabled()` helper.
- `server/src/modules/orders/delivery-pricing.spec.ts` — tests for `codEnabled()`.
- `server/src/modules/orders/dto/create-order.dto.ts` — `paymentMethod` field.
- `server/src/modules/orders/orders.service.ts` — persist `paymentMethod` on intake.
- `server/src/modules/orders/checkout.service.ts` — COD branch + normalization.
- `server/src/common/cache/public-cache.service.ts` — `codEnabled` + internal `stripeAccountId` on `TenantMeta`.
- `server/src/modules/tenants/tenants.service.ts` — `stripeEnabled`/`codEnabled` in `PublicStorefront`; inject `StripeService`.
- `server/src/modules/tenants/tenants.module.ts` — import `StripeModule`.
- `server/src/modules/digest/digest.service.ts` + `.spec.ts` — owner digest shows COD amount.

**Admin (`client/`)**
- `client/src/lib/types.ts` — `cod` in `DeliveryConfig`.
- `client/src/lib/delivery-data.ts` — `cod` default + hydrate merge.
- `client/src/components/delivery/payment-section.tsx` — new COD toggle card.
- `client/src/components/delivery/delivery-client.tsx` — render the new section.

**Storefront (`storefront/`)**
- `storefront/src/lib/api.ts` — `paymentMethod` in DTO; `stripeEnabled`/`codEnabled` in profile.
- `storefront/src/app/checkout/page.tsx` — pass the two flags.
- `storefront/src/components/checkout-client.tsx` — payment-method radios.

**Separate repo (documented, not executed here)**
- `fermerski-pazar-chaika` (Astro) — mirror the storefront change. See Task 12.

---

## Task 1: DB — `payment_method` column + migration

**Files:**
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Add the enum next to the other pgEnums**

In `packages/db/src/schema.ts`, find `export const deliveryTypeEnum = pgEnum('delivery_type', ['pickup', 'address', 'econt', 'econt_address']);` (line ~34) and add directly below it:

```ts
export const paymentMethodEnum = pgEnum('payment_method', ['online', 'cod']);
```

- [ ] **Step 2: Add the column to the `orders` table**

In the `orders` table definition, after the Stripe linkage block (after `paidAt: timestamp('paid_at', { withTimezone: true }),`, line ~202) add:

```ts
    // How the customer chose to pay: 'online' (Stripe card) or 'cod' (наложен
    // платеж — collected at delivery/Econt office). Normalized at checkout to
    // reflect reality: any order with no Stripe session is recorded as 'cod'.
    paymentMethod: paymentMethodEnum('payment_method').notNull().default('online'),
```

- [ ] **Step 3: Generate the migration**

Run: `npm --prefix packages/db run generate`
Expected: a new file `packages/db/drizzle/0032_*.sql` is created, adding the `payment_method` enum type and the `orders.payment_method` column with default `'online'`.

- [ ] **Step 4: Inspect the generated SQL**

Run: `cat packages/db/drizzle/0032_*.sql`
Expected: contains `CREATE TYPE "public"."payment_method" AS ENUM('online', 'cod')` and `ALTER TABLE "orders" ADD COLUMN "payment_method" "payment_method" DEFAULT 'online' NOT NULL`. No other table changes.

- [ ] **Step 5: Build the db package so the server's `@farmflow/db` dist picks up the column**

Run: `npm --prefix packages/db run build`
Expected: exits 0; `packages/db/dist/schema.js` now exports `paymentMethodEnum` and the column.

- [ ] **Step 6: Apply the migration to the local dev DB**

Run: `npm --prefix packages/db run migrate`
Expected: applies `0032`; exits 0. (If the dev DB is down, this is applied automatically on the next API boot — note and continue.)

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle
git commit -m "feat(db): add orders.payment_method enum (online|cod)"
```

---

## Task 2: Server — `cod` config + `codEnabled()` helper (TDD)

**Files:**
- Modify: `server/src/modules/orders/delivery-pricing.ts`
- Test: `server/src/modules/orders/delivery-pricing.spec.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/modules/orders/delivery-pricing.spec.ts`, add (import `codEnabled` alongside the existing imports from `./delivery-pricing`):

```ts
describe('codEnabled', () => {
  it('defaults to true when unset (cash-first farms)', () => {
    expect(codEnabled(null)).toBe(true);
    expect(codEnabled({})).toBe(true);
    expect(codEnabled({ cod: {} })).toBe(true);
  });

  it('respects an explicit flag', () => {
    expect(codEnabled({ cod: { enabled: false } })).toBe(false);
    expect(codEnabled({ cod: { enabled: true } })).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm --prefix server test -- delivery-pricing`
Expected: FAIL — `codEnabled is not a function` (or import error).

- [ ] **Step 3: Add the `cod` field to the type and the helper**

In `server/src/modules/orders/delivery-pricing.ts`, extend the `DeliveryConfig` interface (add the `cod` line):

```ts
export interface DeliveryConfig {
  methods?: {
    ownSlots?: MethodConfig;
    econtOffice?: MethodConfig;
    econtAddress?: MethodConfig;
    pickup?: MethodConfig;
  };
  pricing?: { freeThresholdStotinki?: number };
  econt?: { mode?: EcontMode; configured?: boolean };
  cod?: { enabled?: boolean };
}
```

Then add the helper directly below `econtMode()` (after line ~49):

```ts
/**
 * Whether the farm offers наложен платеж (cash on delivery) as a payment choice.
 * Defaults to true — production runs cash-first, and an absent flag means "offer it".
 */
export function codEnabled(cfg: DeliveryConfig | null | undefined): boolean {
  return cfg?.cod?.enabled ?? true;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm --prefix server test -- delivery-pricing`
Expected: PASS (all `delivery-pricing` tests green).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/delivery-pricing.ts server/src/modules/orders/delivery-pricing.spec.ts
git commit -m "feat(orders): codEnabled() helper + cod config (default on)"
```

---

## Task 3: Server — `paymentMethod` on the checkout DTO

**Files:**
- Modify: `server/src/modules/orders/dto/create-order.dto.ts`

- [ ] **Step 1: Add the field**

In `server/src/modules/orders/dto/create-order.dto.ts`, after the `notes` field (line ~95, the last field) add:

```ts

  @ApiPropertyOptional({ enum: ['online', 'cod'], default: 'online' })
  @IsOptional()
  @IsEnum(['online', 'cod'])
  paymentMethod?: 'online' | 'cod';
```

(`IsEnum`, `IsOptional`, `ApiPropertyOptional` are already imported.)

- [ ] **Step 2: Build the server to typecheck the DTO**

Run: `npm --prefix server run build`
Expected: exits 0, no TS errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/orders/dto/create-order.dto.ts
git commit -m "feat(orders): accept paymentMethod (online|cod) in checkout DTO"
```

---

## Task 4: Server — persist `paymentMethod` on order intake

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts:355-376` (the `tx.insert(orders).values({...})` block in `create`)

- [ ] **Step 1: Persist the customer's choice on insert**

In `OrdersService.create`, in the `.values({ ... })` object of the `orders` insert, add a line after `econtOffice: isEcontOffice ? dto.econtOffice ?? null : null,`:

```ts
          // Customer's payment choice; checkout may normalize 'online'→'cod'
          // when the farm has no usable Stripe account.
          paymentMethod: dto.paymentMethod ?? 'online',
```

- [ ] **Step 2: Build to confirm the column type matches**

Run: `npm --prefix server run build`
Expected: exits 0. (If `paymentMethod` is unknown on the insert type, the `@farmflow/db` dist wasn't rebuilt — re-run Task 1 Step 5.)

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/orders/orders.service.ts
git commit -m "feat(orders): store paymentMethod on intake"
```

---

## Task 5: Server — COD branch + normalization in checkout

**Files:**
- Modify: `server/src/modules/orders/checkout.service.ts:42-96` (the `create` method)

- [ ] **Step 1: Import `codEnabled` (optional) and add the COD branch**

In `server/src/modules/orders/checkout.service.ts`, the cash/no-Stripe early return is at lines ~64-67:

```ts
    // Cash / no-Stripe farm → order already created; client goes straight to confirmation.
    if (!tenant || !this.stripe.isEnabledForAccount(tenant.stripeAccountId)) {
      return { orderId: order.id, checkoutUrl: null };
    }
```

Replace that block with:

```ts
    const wantsCod = dto.paymentMethod === 'cod';
    const canCard = !!tenant && this.stripe.isEnabledForAccount(tenant.stripeAccountId);

    // COD, or a farm that can't take cards → no Stripe session. Record the order
    // as 'cod' (collected at delivery) so the farmer badge + digest are accurate,
    // overriding an 'online' choice the farm can't actually honour.
    if (wantsCod || !canCard) {
      if (order.paymentMethod !== 'cod') {
        await this.db
          .update(orders)
          .set({ paymentMethod: 'cod' })
          .where(eq(orders.id, order.id));
      }
      return { orderId: order.id, checkoutUrl: null };
    }
```

The rest of the method (steps 4-5, building lines + creating the Stripe session) is unchanged and now only runs for `online` + card-capable farms.

- [ ] **Step 2: Build the server**

Run: `npm --prefix server run build`
Expected: exits 0. (`orders` and `eq` are already imported at the top of the file; `order.paymentMethod` is now on the returned row.)

- [ ] **Step 3: Manual reasoning check (no test infra for full checkout here)**

Confirm by reading the diff:
- `paymentMethod:'cod'` → always `checkoutUrl: null`, order row `payment_method='cod'`.
- `paymentMethod:'online'` + Stripe-connected farm → Stripe session, row stays `'online'`.
- `paymentMethod:'online'` + no Stripe → `checkoutUrl: null`, row normalized to `'cod'`.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/orders/checkout.service.ts
git commit -m "feat(checkout): skip Stripe for COD; normalize cash orders to cod"
```

---

## Task 6: Server — expose `codEnabled` + `stripeEnabled` on the public profile

**Files:**
- Modify: `server/src/common/cache/public-cache.service.ts`
- Modify: `server/src/modules/tenants/tenants.service.ts`
- Modify: `server/src/modules/tenants/tenants.module.ts`

- [ ] **Step 1: Carry `codEnabled` (public) + `stripeAccountId` (internal) on `TenantMeta`**

In `server/src/common/cache/public-cache.service.ts`, import `codEnabled` alongside `econtMode`:

```ts
import {
  buildPublicDelivery,
  econtMode,
  codEnabled,
  type PublicDelivery,
  type DeliveryConfig,
  type EcontMode,
} from '../../modules/orders/delivery-pricing';
```

Add two fields to the `TenantMeta` interface, after `econtMode: EcontMode;`:

```ts
  // Whether наложен платеж (COD) is offered — gates the storefront's COD radio.
  codEnabled: boolean;
  // Internal: the farm's connected Stripe account id. Used to derive `stripeEnabled`
  // in TenantsService, then stripped — never sent to the storefront.
  stripeAccountId: string | null;
```

In `resolveTenant`, add `stripeAccountId: tenants.stripeAccountId,` to the `.select({...})` block (after `settings: tenants.settings,`). Then in the `meta` object (after `econtMode: mode,`) add:

```ts
      codEnabled: codEnabled(delivery),
      stripeAccountId: row.stripeAccountId ?? null,
```

- [ ] **Step 2: Derive `stripeEnabled` and strip internals in TenantsService**

In `server/src/modules/tenants/tenants.service.ts`:

Add the import:

```ts
import { StripeService } from '../stripe/stripe.service';
```

Add `codEnabled` + `stripeEnabled` to the `PublicStorefront` interface (after `econtMode: EcontMode;`):

```ts
  codEnabled: boolean;
  stripeEnabled: boolean;
```

Inject `StripeService` in the constructor:

```ts
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly maps: MapsService,
    private readonly publicCache: PublicCacheService,
    private readonly storage: StorageService,
    private readonly stripe: StripeService,
  ) {}
```

Rewrite `findPublicProfileBySlug` to strip the internal `stripeAccountId` and inject the derived flag:

```ts
  async findPublicProfileBySlug(slug: string): Promise<PublicStorefront> {
    // Reuses the shared, Redis-cached slug→tenant resolver. The cached meta IS
    // the profile shape plus internal `id`/`stripeAccountId` — strip them, and
    // derive the public `stripeEnabled` flag (same gate the checkout uses).
    const { id: _id, stripeAccountId, ...profile } = await this.publicCache.resolveTenant(
      this.db,
      slug,
    );
    return { ...profile, stripeEnabled: this.stripe.isEnabledForAccount(stripeAccountId) };
  }
```

- [ ] **Step 3: Wire StripeModule into TenantsModule**

In `server/src/modules/tenants/tenants.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantsController, PublicTenantController } from './tenants.controller';
import { StripeModule } from '../stripe/stripe.module';

@Module({
  imports: [StripeModule],
  controllers: [TenantsController, PublicTenantController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
```

- [ ] **Step 4: Build the server (catches DI / type errors)**

Run: `npm --prefix server run build`
Expected: exits 0. (StripeModule exports StripeService and has no import cycle with TenantsModule — verified: TenantsModule is imported only by AppModule and PublicBootstrapModule.)

- [ ] **Step 5: Boot smoke-check the profile shape**

Start the API (however the project runs it locally, e.g. `npm --prefix server run start:dev`), then:

Run: `curl -s http://localhost:3001/public/ferma-petrovi | python -m json.tool`
Expected: JSON includes `"codEnabled": true` and `"stripeEnabled": false` (demo farm has no Stripe), and does NOT include `stripeAccountId`. Stop the API after.

- [ ] **Step 6: Commit**

```bash
git add server/src/common/cache/public-cache.service.ts server/src/modules/tenants/tenants.service.ts server/src/modules/tenants/tenants.module.ts
git commit -m "feat(public): expose codEnabled + stripeEnabled on storefront profile"
```

---

## Task 7: Server — owner digest shows COD amount

**Files:**
- Modify: `server/src/modules/digest/digest.service.ts`
- Test: `server/src/modules/digest/digest.service.spec.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/modules/digest/digest.service.spec.ts`, add a focused case. (Match the existing spec's setup style — it builds a `DigestService` over a fake/seeded db and calls `buildDigest`. If the existing tests stub rows, add a COD order to that fixture and assert on the rendered text.) Add:

```ts
it('tags COD orders with наложен платеж + amount in the owner digest', async () => {
  // Arrange: one confirmed COD econt order, total 2599 stotinki.
  // (Reuse this file's existing fixture/seed helper to insert it.)
  const res = await service.buildDigest(tenantId, date);
  expect(res).not.toBeNull();
  expect(res!.text).toContain('наложен платеж — 25,99 €');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm --prefix server test -- digest`
Expected: FAIL — the COD tag text is absent.

- [ ] **Step 3: Add the fields, the formatter, and the tag**

In `server/src/modules/digest/digest.service.ts`:

Extend the `DigestOrder` interface (add two fields):

```ts
interface DigestOrder {
  id: string;
  deliveryType: string;
  customerName: string | null;
  deliveryAddress: string | null;
  deliveryCity: string | null;
  econtOffice: string | null;
  slotFrom: string | null;
  slotTo: string | null;
  paymentMethod: string;
  totalStotinki: number;
}
```

Add a formatter + tag helper next to `econtDestination` (after line ~36):

```ts
/** stotinki → "25,99 €" for digest amounts. */
function eur(stotinki: number): string {
  return (stotinki / 100).toFixed(2).replace('.', ',') + ' €';
}

/** Suffix shown on a customer line when they pay наложен платеж. */
function codTag(o: DigestOrder): string {
  return o.paymentMethod === 'cod' ? ` · наложен платеж — ${eur(o.totalStotinki)}` : '';
}
```

Select the new columns in `buildDigest`'s query (in the `.select({...})`, after `econtOffice: orders.econtOffice,`):

```ts
        paymentMethod: orders.paymentMethod,
        totalStotinki: orders.totalStotinki,
```

In `renderHtml`, append the tag to the customer cell of each section. Change the three `customerName` cells:
- pickup rows: `${escapeHtml(o.customerName ?? '—')}${escapeHtml(codTag(o))}`
- address rows: `${escapeHtml(o.customerName ?? '—')}${escapeHtml(codTag(o))}`
- econt rows: `${escapeHtml(o.customerName ?? '—')}${escapeHtml(codTag(o))}`

In `renderText`, append `codTag(o)` to each `lines.push(... o.customerName ...)` (pickup, address, econt):
- pickup: `lines.push(\`  • ${o.customerName ?? '—'} — За вземане на място${slot}${codTag(o)}\`);`
- address: `lines.push(\`  • ${o.customerName ?? '—'} — ${o.deliveryAddress ?? '—'}${slot}${codTag(o)}\`);`
- econt: `lines.push(\`  • ${o.customerName ?? '—'} — ${econtDestination(o)}${codTag(o)}\`);`

> Scope note: the **per-farmer** digest (`buildFarmerDigest`/`renderFarmer*`) is intentionally left untouched — order-level COD totals don't map cleanly to a single farmer's slice. Deferred.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm --prefix server test -- digest`
Expected: PASS.

- [ ] **Step 5: Run the full server suite to catch fixture drift**

Run: `npm --prefix server test`
Expected: all green (the two new digest columns must be present in any test fixtures that stub `buildDigest` rows — add `paymentMethod: 'online', totalStotinki: 0` to existing stub rows if the suite fails on the shape).

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/digest/digest.service.ts server/src/modules/digest/digest.service.spec.ts
git commit -m "feat(digest): tag COD orders with наложен платеж amount (owner digest)"
```

---

## Task 8: Admin — `cod` in the client delivery config types + defaults

**Files:**
- Modify: `client/src/lib/types.ts:191-196` (`DeliveryConfig`)
- Modify: `client/src/lib/delivery-data.ts` (`DEFAULT_DELIVERY` + `hydrateDelivery`)

- [ ] **Step 1: Add `cod` to the `DeliveryConfig` interface**

In `client/src/lib/types.ts`, extend `DeliveryConfig`:

```ts
export interface DeliveryConfig {
  methods: DeliveryMethods;
  schedule: DeliverySchedule;
  pricing: DeliveryPricing;
  econt: EcontConfig;
  /** Customer-facing наложен платеж (COD) toggle. Absent → treated as enabled. */
  cod?: { enabled: boolean };
}
```

- [ ] **Step 2: Add the default + hydrate merge**

In `client/src/lib/delivery-data.ts`, in `DEFAULT_DELIVERY`, after the `econt: { ... }` block (before the closing `};` at line ~87) add:

```ts
  cod: { enabled: true },
```

In `hydrateDelivery`, add a `cod` line to the returned object (after the `econt: { ... }` block, before the closing `};`):

```ts
    cod: { enabled: saved?.cod?.enabled ?? d.cod?.enabled ?? true },
```

- [ ] **Step 3: Typecheck the client**

Run: `npm --prefix client run build`
Expected: exits 0 (or run `npx --prefix client tsc --noEmit` if the project uses that). No type errors on `DeliveryConfig`.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/delivery-data.ts
git commit -m "feat(admin): cod flag in delivery config types + defaults"
```

---

## Task 9: Admin — COD toggle section on the delivery page

**Files:**
- Create: `client/src/components/delivery/payment-section.tsx`
- Modify: `client/src/components/delivery/delivery-client.tsx`

- [ ] **Step 1: Create the section component**

Create `client/src/components/delivery/payment-section.tsx`:

```tsx
'use client';

import { Wallet } from 'lucide-react';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import type { DeliveryConfig } from '@/lib/types';
import { DSection, InfoNote } from './ui';

type Mut = (fn: (d: DeliveryConfig) => void) => void;

/**
 * Plащане — customer payment options. Right now this is the наложен платеж (COD)
 * switch: when on, customers can choose to pay at delivery (e.g. cash at the
 * Econt office) instead of online by card. Card payment is governed by the farm's
 * Stripe connection on the Payments page, not here.
 */
export function PaymentSection({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  const enabled = cfg.cod?.enabled ?? true;
  return (
    <DSection
      title="Плащане"
      helper="Как клиентите плащат поръчките си."
      info={
        <>
          <b>Наложен платеж</b> значи, че клиентът плаща при получаване — например в
          брой на гишето на Еконт, когато си вземе поръчката. Не изисква Еконт акаунт
          или API: ти просто пускаш пратката с „наложен платеж“, а Еконт събира сумата.
        </>
      }
    >
      <div className="flex items-center gap-3 rounded-xl border border-ff-border bg-ff-surface-2 px-[15px] py-3.5">
        <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border border-ff-border-2 bg-ff-surface text-ff-green-700">
          <Wallet size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-extrabold text-ff-ink">Наложен платеж</div>
          <div className="mt-px text-[12.5px] text-ff-muted">
            Клиентът плаща при доставка вместо онлайн с карта.
          </div>
        </div>
        <ToggleSwitch
          checked={enabled}
          onChange={(v) => mut((d) => (d.cod = { enabled: v }))}
        />
      </div>
      {!enabled && (
        <div className="mt-2.5">
          <InfoNote tone="green">
            Изключено — клиентите трябва да платят онлайн с карта (изисква свързан Stripe).
          </InfoNote>
        </div>
      )}
    </DSection>
  );
}
```

> Before writing, confirm `DSection` and `InfoNote` are exported from `./ui` (they are used by `methods-section.tsx` / `econt-section.tsx`). If `InfoNote` is not exported, drop the `{!enabled && ...}` block.

- [ ] **Step 2: Render it on the delivery page**

In `client/src/components/delivery/delivery-client.tsx`:

Add the import near the other section imports (after `import { PricingSection } from './pricing-section';`):

```ts
import { PaymentSection } from './payment-section';
```

Render it inside the methods stack — add after `<PricingSection cfg={cfg} mut={mut} />` (line ~159):

```tsx
        <PaymentSection cfg={cfg} mut={mut} />
```

- [ ] **Step 3: Build the client**

Run: `npm --prefix client run build`
Expected: exits 0.

- [ ] **Step 4: Visual verify (preview)**

Start the admin preview (preview_start), log in, open the Доставка page. Confirm a new **Плащане** card with a **Наложен платеж** toggle (default ON). Toggle it off → the sticky "unsaved changes" bar appears; Save; reload → state persists.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/delivery/payment-section.tsx client/src/components/delivery/delivery-client.tsx
git commit -m "feat(admin): наложен платеж (COD) toggle on delivery page"
```

---

## Task 10: Storefront — payment-method radios at checkout (main repo)

**Files:**
- Modify: `storefront/src/lib/api.ts`
- Modify: `storefront/src/app/checkout/page.tsx`
- Modify: `storefront/src/components/checkout-client.tsx`

- [ ] **Step 1: Extend the storefront API types**

In `storefront/src/lib/api.ts`:

Add `paymentMethod` to `CreateOrderDto` (after `econtOffice?: string;`, line ~74):

```ts
  paymentMethod?: 'online' | 'cod';
```

Add the two flags to `StorefrontProfile` (after `econtMode: 'off' | 'manual' | 'auto';`, line ~184):

```ts
  /** наложен платеж offered to customers. */
  codEnabled: boolean;
  /** Farm can take card payments (Stripe connected). */
  stripeEnabled: boolean;
```

- [ ] **Step 2: Pass the flags from the checkout page**

In `storefront/src/app/checkout/page.tsx`, pass two more props to `<CheckoutClient>`:

```tsx
  return (
    <CheckoutClient
      deliveryEnabled={profile?.deliveryEnabled ?? true}
      delivery={profile?.delivery ?? DEFAULT_DELIVERY}
      codEnabled={profile?.codEnabled ?? true}
      stripeEnabled={profile?.stripeEnabled ?? false}
    />
  );
```

- [ ] **Step 3: Add the payment-method UI + submit field**

In `storefront/src/components/checkout-client.tsx`:

Extend the component props:

```tsx
export function CheckoutClient({
  deliveryEnabled,
  delivery,
  codEnabled,
  stripeEnabled,
}: {
  deliveryEnabled: boolean;
  delivery: StorefrontDelivery;
  codEnabled: boolean;
  stripeEnabled: boolean;
}) {
```

Add payment state next to the other `useState` hooks (after `slotId`):

```tsx
  // Card only when the farm has Stripe; COD when offered. Default to card if
  // available, else COD. At least one is always present (COD defaults on).
  const [paymentMethod, setPaymentMethod] = useState<'online' | 'cod'>(
    stripeEnabled ? 'online' : 'cod',
  );
  const showPaymentChoice = stripeEnabled && codEnabled;
```

Add `paymentMethod` to the `createCheckout` body (in the `submit` handler, inside the object passed to `createCheckout`, after `econtOffice: ...,`):

```tsx
        paymentMethod,
```

Add a payment-method card to the form — insert it after the delivery-method `</div>` card and before the slot card (i.e. after the closing `</div>` of the "delivery method" card, line ~245, before the `{deliveryEnabled && !isEcont && ...}` slot block):

```tsx
              {/* payment method */}
              <div className="card" style={{ padding: 24, boxShadow: 'none' }}>
                <h3 style={{ fontSize: 20, marginBottom: 16 }}>Начин на плащане</h3>
                {showPaymentChoice ? (
                  <div className="stack" style={{ gap: 12 }}>
                    <label
                      className={`radio-card${paymentMethod === 'online' ? ' is-active' : ''}`}
                      onClick={() => setPaymentMethod('online')}
                    >
                      <span className="dot"></span>
                      <span>
                        <b>Карта (онлайн)</b>
                        <br />
                        <span className="muted" style={{ fontSize: 14 }}>
                          Плащаш сигурно с карта сега
                        </span>
                      </span>
                    </label>
                    <label
                      className={`radio-card${paymentMethod === 'cod' ? ' is-active' : ''}`}
                      onClick={() => setPaymentMethod('cod')}
                    >
                      <span className="dot"></span>
                      <span>
                        <b>Наложен платеж</b>
                        <br />
                        <span className="muted" style={{ fontSize: 14 }}>
                          Плащаш при получаване (напр. в офис на Еконт)
                        </span>
                      </span>
                    </label>
                  </div>
                ) : (
                  <p className="muted" style={{ fontSize: 14 }}>
                    {paymentMethod === 'online'
                      ? 'Плащане с карта (онлайн) при завършване на поръчката.'
                      : 'Плащане при получаване (наложен платеж).'}
                  </p>
                )}
              </div>
```

- [ ] **Step 4: Build the storefront**

Run: `npm --prefix storefront run build`
Expected: exits 0, no type errors.

- [ ] **Step 5: Verify the COD flow (preview)**

Start the storefront preview. Add an item → checkout. With the demo farm (no Stripe, COD on), confirm the **Начин на плащане** card shows the single-line COD note. Submit → lands on `/confirmation` (no Stripe redirect). In the admin Orders list, the new order badges **Наложен платеж / при доставка**.

(If a Stripe-connected test farm is available, confirm both radios show and selecting Карта redirects to Stripe while Наложен платеж goes straight to confirmation.)

- [ ] **Step 6: Commit**

```bash
git add storefront/src/lib/api.ts storefront/src/app/checkout/page.tsx storefront/src/components/checkout-client.tsx
git commit -m "feat(storefront): наложен платеж vs card payment choice at checkout"
```

---

## Task 11: Verify manual Econt + full regression

**Files:** none (verification + config).

- [ ] **Step 1: Confirm Econt manual mode is the delivery model**

In the admin Доставка page, the **Еконт** section → "Как ще изпращаш с Еконт?" → select **Ръчно** (manual). Enable the "До офис на Еконт" method under Методи. Save. This needs no code — manual mode already routes checkout through the flat-fee, no-API path (`checkout.service.ts:133` only calls the Econt API when mode is `auto`).

- [ ] **Step 2: End-to-end smoke**

Place a storefront order: Еконт офис delivery + Наложен платеж payment. Confirm: order created `pending`, `payment_method='cod'`, no Econt API call, confirmation page reached, admin badge = наложен платеж.

- [ ] **Step 3: Full server test suite**

Run: `npm --prefix server test`
Expected: all green (was 150/150; new `codEnabled` + digest COD tests added).

- [ ] **Step 4: Builds across workspaces**

Run: `npm --prefix packages/db run build; npm --prefix server run build; npm --prefix client run build; npm --prefix storefront run build`
Expected: all exit 0.

- [ ] **Step 5: Commit any fixups**

```bash
git add -A
git commit -m "test(payments): COD end-to-end verification fixups" || echo "nothing to commit"
```

---

## Task 12: chaika storefront (separate repo — documented, run separately)

> This repo is `fermerski-pazar-chaika` (Astro), **not** in the current working tree. Do these edits in that repo's checkout, then build/commit there. The backend already serves `codEnabled`/`stripeEnabled` on `GET /public/:slug` and accepts `paymentMethod` on checkout, so this is purely consuming them.

- [ ] **Step 1: Profile type** — wherever the chaika repo declares the public profile / bootstrap type, add `codEnabled: boolean` and `stripeEnabled: boolean`.

- [ ] **Step 2: Checkout body** — add `paymentMethod: 'online' | 'cod'` to the order/checkout request payload type and send the selected value.

- [ ] **Step 3: Checkout UI** — add a "Начин на плащане" control mirroring Task 10 Step 3: show «Карта (онлайн)» only when `stripeEnabled`, «Наложен платеж» only when `codEnabled`; default to card if available else COD; collapse to a one-line note when only one option exists.

- [ ] **Step 4: Verify** — COD order in chaika lands on its confirmation page with no Stripe redirect; the order shows наложен платеж in the FarmFlow admin.

- [ ] **Step 5: Commit in the chaika repo.**

---

## Self-review notes

- **Spec coverage:** order column (T1), `cod` flag + default-on (T2/T8), DTO (T3), intake persist (T4), checkout COD branch + normalization (T5), public `codEnabled`+`stripeEnabled` (T6), admin toggle (T9), both storefronts (T10 main, T12 chaika), digest COD (T7, owner-only by design), manual Econt confirmation (T11). Farmer badge needs no change — cash orders already render «Наложен платеж / при доставка» (`order-panel.tsx:32`). No in-app COD fee (per spec).
- **Type consistency:** `paymentMethod: 'online' | 'cod'` identical in DB enum, server DTO, `OrdersService` insert, storefront DTO. `cod: { enabled: boolean }` in both client `DeliveryConfig` and server `DeliveryConfig` (server's is `enabled?`). `codEnabled(cfg)` server-only helper; client reads `cfg.cod?.enabled ?? true` inline.
- **Deferred:** per-farmer digest COD tag; chaika executed in its own repo.
