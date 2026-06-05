# Automated SaaS Subscription Billing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Per user preference, Opus executes directly (no Sonnet delegation).

**Goal:** Auto-charge each farm €30/mo + €2 per newsletter broadcast via Stripe; a `premium` flag makes it free; failed payment → 7-day visible grace → auto-suspend. Platform takes 0% of orders.

**Architecture:** New platform-side `BillingModule` uses the existing Stripe client **without** the `stripeAccount` option (platform account, not Connect). A €30/mo Stripe **subscription** (Checkout subscription-mode) holds the card; each broadcast adds a €2 **invoice item** that rolls into the next invoice. Webhooks drive `tenants.subscription_status` (`active|past_due|inactive`); a daily cron suspends expired grace. Reuses the `email_pushes` ledger, `ActiveSubscriptionGuard` gating, `@nestjs/schedule`, and `stripe_events` idempotency.

**Tech Stack:** NestJS 10, Drizzle 0.35 + drizzle-kit 0.26, Stripe 22, Joi env validation, Jest. Frontend: Next 14 (client :3000 farmer, admin :3002 super-admin).

**Spec:** `docs/superpowers/specs/2026-06-05-automated-saas-billing-design.md`

---

## File Map

**DB**
- Modify `packages/db/src/schema.ts` — widen `subscriptionStatusEnum`; add tenant + email_pushes columns.
- Create `packages/db/drizzle/0027_*.sql` — generated.

**Server (new `BillingModule`)**
- Create `server/src/modules/billing/billing.service.ts` — customer/checkout/portal/summary/billPush/setPremium/webhook/cron.
- Create `server/src/modules/billing/billing.controller.ts` — `/billing/{summary,checkout,portal}`.
- Create `server/src/modules/billing/billing.module.ts`.
- Create `server/src/modules/billing/billing.service.spec.ts`.
- Modify `server/src/config/env.validation.ts` + `.env.example` — new env.
- Modify `server/src/modules/stripe/stripe.service.ts` — delegate billing webhook events.
- Modify `server/src/modules/stripe/stripe.module.ts` — import BillingModule.
- Modify `server/src/modules/newsletter/newsletter.service.ts` + `newsletter.module.ts` — call `billPush`.
- Modify `server/src/modules/platform/platform.service.ts` + `platform.controller.ts` + `platform.module.ts` + a new DTO — `setPremium`, expose billing fields.
- Modify `server/src/app.module.ts` — register BillingModule.

**Frontend — farmer (`client/`)**
- Create `client/src/components/payments/subscription-card.tsx`.
- Modify `client/src/components/payments/payments-client.tsx` + `client/src/app/(admin)/payments/page.tsx` — render it.
- Modify `client/src/lib/api-client.ts` — billing summary/checkout/portal + types.

**Frontend — super-admin (`admin/`)**
- Modify `admin/src/lib/api-client.ts` — premium toggle + billing fields on rows/detail.
- Modify `admin/src/components/tenants-client.tsx` (+ tenant detail page) — plan/status + premium toggle.
- Modify `admin/src/components/email-billing-client.tsx` — copy (now Stripe-collected).

---

## Task 1: DB schema + migration 0027

**Files:** Modify `packages/db/src/schema.ts`; generate `packages/db/drizzle/0027_*.sql`.

- [ ] **Step 1.1: Widen the enum.** In `schema.ts:27` replace:

```typescript
export const subscriptionStatusEnum = pgEnum('subscription_status', ['active', 'past_due', 'inactive']);
```

- [ ] **Step 1.2: Add tenant billing columns.** In the `tenants` table, after `stripeStatusUpdatedAt` (schema.ts:56) add:

```typescript
  // --- Platform-side SaaS billing (the platform charges the farm; distinct from
  // stripeAccountId, which is the farm's Connect account for customer orders). ---
  premium: boolean('premium').notNull().default(false),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  // Set on first failed payment; the suspend deadline (status flips to inactive after).
  graceUntil: timestamp('grace_until', { withTimezone: true }),
```

- [ ] **Step 1.3: Add the email-push billing link.** In the `emailPushes` table (schema.ts:355) after `priceStotinki` add:

```typescript
  stripeInvoiceItemId: text('stripe_invoice_item_id'),
```

- [ ] **Step 1.4: Generate the migration.**

Run: `pnpm --filter @farmflow/db generate`
Expected: a new `packages/db/drizzle/0027_*.sql` containing `ALTER TYPE "public"."subscription_status" ADD VALUE 'past_due'` and the `ALTER TABLE ... ADD COLUMN` statements. (Enum value goes before/after `inactive`; ordering doesn't matter for our reads.)

- [ ] **Step 1.5: Apply + rebuild dist.** The API consumes `@farmflow/db` via its built `dist/`, so rebuild after schema edits.

Run: `pnpm --filter @farmflow/db migrate && pnpm --filter @farmflow/db build && pnpm --filter @farmflow/types build`
Expected: migration applies; both builds exit 0.

- [ ] **Step 1.6: Commit.**

```bash
git add packages/db/src/schema.ts packages/db/drizzle
git commit -m "feat(db): SaaS billing columns + past_due status (migration 0027)"
```

---

## Task 2: Env config

**Files:** Modify `server/src/config/env.validation.ts`, `.env.example`.

- [ ] **Step 2.1: Add env vars.** In `env.validation.ts`, after `API_PUBLIC_URL` (line 61) add:

```typescript
  // --- Platform SaaS billing (the platform charges farms; Stripe subscription). ---
  // Recurring €30/mo Price id created once on the PLATFORM Stripe account. Empty
  // → billing disabled (checkout returns a clear error), like the rest of Stripe.
  STRIPE_BILLING_PRICE_ID: Joi.string().optional().allow(''),
  // Display/estimate only (the real charge is the Stripe price above). €30.00.
  BILLING_BASE_PRICE_STOTINKI: Joi.number().default(3000),
  // Days a farm keeps full access after a failed payment before auto-suspend.
  BILLING_GRACE_DAYS: Joi.number().default(7),
```

- [ ] **Step 2.2: Mirror into `.env.example`** (add the three keys with the defaults + a one-line comment each, matching the file's existing style).

- [ ] **Step 2.3: Commit.**

```bash
git add server/src/config/env.validation.ts .env.example
git commit -m "feat(config): SaaS billing env (price id, base price, grace days)"
```

---

## Task 3: BillingService — customer, checkout, portal, summary (TDD)

**Files:** Create `server/src/modules/billing/billing.service.ts`, `billing.service.spec.ts`.

The service mirrors `StripeService`'s graceful-degrade style: a private `client` is null when `STRIPE_SECRET_KEY` is empty; methods that need Stripe throw `BadRequestException('Stripe не е конфигуриран')` or (for summary) return a safe default.

- [ ] **Step 3.1: Write failing tests** (`billing.service.spec.ts`). Mock `DB_TOKEN`, `ConfigService`, `EmailService`. Build a chainable db mock like `platform.service.spec.ts`. Tests:

```typescript
import { Test } from '@nestjs/testing';
import { BillingService } from './billing.service';
import { EmailService } from '../../common/email/email.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { ConfigService } from '@nestjs/config';

function makeDb(tenant: any = {}) {
  const db: any = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([tenant]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  };
  // update().set().where() resolves; make where after set resolve too
  return db;
}
const cfg = (over: Record<string, any> = {}) => ({
  get: (k: string, d?: any) => (k in over ? over[k] : d),
});

describe('BillingService (disabled — no STRIPE_SECRET_KEY)', () => {
  let svc: BillingService;
  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: DB_TOKEN, useValue: makeDb({ id: 't1', premium: false, stripeCustomerId: null }) },
        { provide: ConfigService, useValue: cfg() },
        { provide: EmailService, useValue: { sendMail: jest.fn() } },
      ],
    }).compile();
    svc = mod.get(BillingService);
  });

  it('isEnabled() is false without a key', () => {
    expect(svc.isEnabled()).toBe(false);
  });

  it('summary() returns a safe disabled snapshot, never throws', async () => {
    const s = await svc.summary('t1');
    expect(s.enabled).toBe(false);
    expect(s.plan).toBe('standard');
    expect(s.status).toBe('active');
  });

  it('startCheckout() throws when Stripe disabled', async () => {
    await expect(svc.startCheckout('t1')).rejects.toThrow('Stripe не е конфигуриран');
  });

  it('summary() reports premium plan for a premium tenant', async () => {
    (svc as any).db = makeDb({ id: 't1', premium: true, subscriptionStatus: 'active' });
    const s = await svc.summary('t1');
    expect(s.plan).toBe('premium');
  });
});
```

- [ ] **Step 3.2: Run — expect fail.** `cd server && pnpm test -- --testPathPattern=billing.service --no-coverage` → "Cannot find module './billing.service'".

- [ ] **Step 3.3: Implement the service skeleton + these methods.**

```typescript
import { Injectable, Inject, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { type Database, tenants, emailPushes } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';

type StripeClient = InstanceType<typeof Stripe>;

export interface BillingSummary {
  enabled: boolean;                       // STRIPE_SECRET_KEY + price id present
  plan: 'standard' | 'premium';
  status: 'active' | 'past_due' | 'inactive';
  graceUntil: string | null;
  hasCard: boolean;
  cardBrand: string | null;
  cardLast4: string | null;
  basePriceStotinki: number;
  emailPriceStotinki: number;
  pushesThisCycle: number;
  estimatedNextStotinki: number;          // base + €2 × pushes this cycle
  invoices: { amountStotinki: number; status: string; date: string; url: string | null }[];
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly client: StripeClient | null;
  private readonly priceId: string;
  private readonly basePrice: number;
  private readonly emailPrice: number;
  private readonly graceDays: number;
  private readonly panelUrl: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {
    const key = config.get<string>('STRIPE_SECRET_KEY')?.trim();
    this.client = key ? new Stripe(key) : null;
    this.priceId = config.get<string>('STRIPE_BILLING_PRICE_ID')?.trim() ?? '';
    this.basePrice = config.get<number>('BILLING_BASE_PRICE_STOTINKI', 3000);
    this.emailPrice = config.get<number>('EMAIL_PUSH_PRICE_STOTINKI', 200);
    this.graceDays = config.get<number>('BILLING_GRACE_DAYS', 7);
    this.panelUrl = (config.get<string>('CORS_ORIGIN') ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  /** Billing is usable only with both a secret key AND the recurring price id. */
  isEnabled(): boolean {
    return this.client !== null && this.priceId !== '';
  }
  private get stripe(): StripeClient {
    if (!this.client) throw new BadRequestException('Stripe не е конфигуриран');
    return this.client;
  }
  private async tenant(id: string) {
    const [t] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundException('Фермата не е намерена');
    return t;
  }

  /** Find/create the platform-side Stripe Customer for a (non-premium) farm. */
  async getOrCreateCustomer(tenantId: string): Promise<string> {
    const t = await this.tenant(tenantId);
    if (t.stripeCustomerId) return t.stripeCustomerId;
    const customer = await this.stripe.customers.create({
      email: t.email ?? undefined,
      name: t.name,
      metadata: { farmflowTenantId: t.id },
    });
    await this.db.update(tenants).set({ stripeCustomerId: customer.id }).where(eq(tenants.id, tenantId));
    return customer.id;
  }

  /** Hosted Checkout (subscription mode) to collect a card + start the €30/mo sub. */
  async startCheckout(tenantId: string): Promise<{ url: string | null }> {
    if (!this.isEnabled()) throw new BadRequestException('Stripe не е конфигуриран');
    const t = await this.tenant(tenantId);
    if (t.premium) throw new BadRequestException('Премиум фермите нямат абонамент');
    const customer = await this.getOrCreateCustomer(tenantId);
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [{ price: this.priceId, quantity: 1 }],
      subscription_data: { metadata: { farmflowTenantId: tenantId } },
      success_url: `${this.panelUrl}/payments?billing=done`,
      cancel_url: `${this.panelUrl}/payments?billing=cancel`,
    });
    return { url: session.url };
  }

  /** Stripe Billing Portal (update card, invoices, cancel). */
  async billingPortal(tenantId: string): Promise<{ url: string }> {
    if (!this.client) throw new BadRequestException('Stripe не е конфигуриран');
    const t = await this.tenant(tenantId);
    if (!t.stripeCustomerId) throw new BadRequestException('Няма платежен профил');
    const session = await this.stripe.billingPortal.sessions.create({
      customer: t.stripeCustomerId,
      return_url: `${this.panelUrl}/payments`,
    });
    return { url: session.url };
  }

  /** Billing snapshot for the farmer Payments page. Never throws. */
  async summary(tenantId: string): Promise<BillingSummary> {
    const base: BillingSummary = {
      enabled: this.isEnabled(),
      plan: 'standard',
      status: 'active',
      graceUntil: null,
      hasCard: false, cardBrand: null, cardLast4: null,
      basePriceStotinki: this.basePrice,
      emailPriceStotinki: this.emailPrice,
      pushesThisCycle: 0,
      estimatedNextStotinki: this.basePrice,
      invoices: [],
    };
    let t;
    try { t = await this.tenant(tenantId); } catch { return base; }
    base.plan = t.premium ? 'premium' : 'standard';
    base.status = (t.subscriptionStatus as BillingSummary['status']) ?? 'active';
    base.graceUntil = t.graceUntil ? new Date(t.graceUntil).toISOString() : null;
    if (t.premium || !this.client || !t.stripeCustomerId) {
      base.estimatedNextStotinki = t.premium ? 0 : this.basePrice;
      return base;
    }
    // Pull card + recent invoices best-effort; any failure leaves safe defaults.
    try {
      const customer = await this.stripe.customers.retrieve(t.stripeCustomerId, {
        expand: ['invoice_settings.default_payment_method'],
      });
      const pm: any = (customer as any).invoice_settings?.default_payment_method;
      if (pm?.card) { base.hasCard = true; base.cardBrand = pm.card.brand; base.cardLast4 = pm.card.last4; }
    } catch (err) { this.logger.warn(`billing customer read failed: ${this.errText(err)}`); }
    try {
      const invs = await this.stripe.invoices.list({ customer: t.stripeCustomerId, limit: 6 });
      base.invoices = invs.data.map((i) => ({
        amountStotinki: i.amount_due,
        status: i.status ?? 'unknown',
        date: new Date((i.created ?? 0) * 1000).toISOString(),
        url: i.hosted_invoice_url ?? null,
      }));
      const open = invs.data.find((i) => i.status === 'draft' || i.status === 'open');
      base.estimatedNextStotinki = open ? open.amount_due : this.basePrice;
    } catch (err) { this.logger.warn(`billing invoices read failed: ${this.errText(err)}`); }
    return base;
  }

  private errText(err: unknown): string { return err instanceof Error ? err.message : 'unknown'; }
}
```

- [ ] **Step 3.4: Run — expect pass.** `cd server && pnpm test -- --testPathPattern=billing.service --no-coverage`.

- [ ] **Step 3.5: Commit.** `git add server/src/modules/billing && git commit -m "feat(billing): BillingService core (customer, checkout, portal, summary)"`

---

## Task 4: billPush — €2 invoice item per broadcast (TDD)

**Files:** Modify `billing.service.ts` + `billing.service.spec.ts`.

`billPush` is called by the newsletter after a successful send. Premium → mark the push free (price 0), no charge. No customer/subscription yet → leave unbilled (push keeps its price, no invoice item). Otherwise create a €2 invoice item and store its id (double-bill guard: skip if the push already has one).

- [ ] **Step 4.1: Add tests.**

```typescript
describe('BillingService.billPush', () => {
  it('premium → sets push price 0, no invoice item', async () => { /* premium tenant; assert db.update called with priceStotinki:0, no stripe call */ });
  it('non-premium with customer → creates invoice item + stores id', async () => { /* mock stripe.invoiceItems.create */ });
  it('already-billed push (has stripeInvoiceItemId) → no-op', async () => {});
  it('no customer → leaves push unbilled (no throw)', async () => {});
});
```

(Write these against a `client` injected via `(svc as any).client = { invoiceItems: { create: jest.fn().mockResolvedValue({ id: 'ii_1' }) } }` and a db mock whose `limit` returns the tenant then the push.)

- [ ] **Step 4.2: Implement.**

```typescript
  /**
   * Charge a newsletter broadcast: add a €2 invoice item to the farm's customer
   * so it rolls into the next subscription invoice. Premium → free (price 0).
   * Idempotent: a push that already carries an invoice-item id is skipped.
   */
  async billPush(pushId: string): Promise<void> {
    const [push] = await this.db.select().from(emailPushes).where(eq(emailPushes.id, pushId)).limit(1);
    if (!push || !push.tenantId) return;
    if (push.stripeInvoiceItemId) return;                       // already billed
    const t = await this.tenant(push.tenantId);
    if (t.premium) {
      await this.db.update(emailPushes).set({ priceStotinki: 0 }).where(eq(emailPushes.id, pushId));
      return;
    }
    if (!this.client || !t.stripeCustomerId) return;            // not billable yet — gating normally prevents this
    try {
      const item = await this.stripe.invoiceItems.create({
        customer: t.stripeCustomerId,
        amount: this.emailPrice,
        currency: 'eur',
        description: `Бюлетин: ${push.subject ?? ''} (${push.recipientCount} получателя)`,
        metadata: { farmflowTenantId: t.id, pushId },
      });
      await this.db.update(emailPushes).set({ stripeInvoiceItemId: item.id }).where(eq(emailPushes.id, pushId));
    } catch (err) {
      this.logger.error(`billPush failed for ${pushId}: ${this.errText(err)}`);
    }
  }
```

- [ ] **Step 4.3: Run tests — pass. Step 4.4: Commit** `git commit -am "feat(billing): bill €2 invoice item per broadcast (premium-free, idempotent)"`

---

## Task 5: Webhook handler + payment-failure grace (TDD)

**Files:** Modify `billing.service.ts` + spec.

A single `handleBillingEvent(event)` switch, called by `StripeService.handleWebhook` (Task 8) after signature-verify + idempotency. Resolves the tenant by `metadata.farmflowTenantId` or by `stripeCustomerId`/`stripeSubscriptionId`.

- [ ] **Step 5.1: Add tests:** `invoice.paid` → status active + graceUntil cleared; `invoice.payment_failed` (first) → past_due + graceUntil set + email sent; `invoice.payment_failed` when graceUntil already set → graceUntil unchanged; `customer.subscription.deleted` → inactive; `checkout.session.completed` (mode subscription) → stores subscription id + active.

- [ ] **Step 5.2: Implement.**

```typescript
  async handleBillingEvent(event: { type: string; data: { object: any } }): Promise<void> {
    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.mode !== 'subscription') return;               // order checkouts handled elsewhere
        const tenantId = await this.resolveTenant({ customer: obj.customer });
        if (!tenantId) return;
        await this.db.update(tenants).set({
          stripeSubscriptionId: typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id ?? null,
          subscriptionStatus: 'active', graceUntil: null,
        }).where(eq(tenants.id, tenantId));
        break;
      }
      case 'invoice.paid': {
        const tenantId = await this.resolveTenant({ customer: obj.customer });
        if (!tenantId) return;
        await this.db.update(tenants).set({ subscriptionStatus: 'active', graceUntil: null }).where(eq(tenants.id, tenantId));
        break;
      }
      case 'invoice.payment_failed': {
        const tenantId = await this.resolveTenant({ customer: obj.customer });
        if (!tenantId) return;
        const t = await this.tenant(tenantId);
        if (t.graceUntil) return;                              // grace already running — don't reset
        const graceUntil = new Date(Date.now() + this.graceDays * 86_400_000);
        await this.db.update(tenants).set({ subscriptionStatus: 'past_due', graceUntil }).where(eq(tenants.id, tenantId));
        await this.notifyPaymentFailed(t.email, graceUntil);
        break;
      }
      case 'customer.subscription.deleted': {
        const tenantId = await this.resolveTenant({ subscription: obj.id, customer: obj.customer });
        if (!tenantId) return;
        await this.db.update(tenants).set({ subscriptionStatus: 'inactive' }).where(eq(tenants.id, tenantId));
        break;
      }
    }
  }

  private async resolveTenant(ref: { customer?: string; subscription?: string }): Promise<string | null> {
    if (ref.customer) {
      const [t] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.stripeCustomerId, ref.customer)).limit(1);
      if (t) return t.id;
    }
    if (ref.subscription) {
      const [t] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.stripeSubscriptionId, ref.subscription)).limit(1);
      if (t) return t.id;
    }
    return null;
  }

  private async notifyPaymentFailed(email: string | null, graceUntil: Date): Promise<void> {
    if (!email) return;
    const date = graceUntil.toLocaleDateString('bg-BG');
    try {
      await this.email.sendMail({
        to: email,
        subject: 'Неуспешно плащане на абонамента — FarmFlow',
        html: `<p>Плащането на абонамента ти не успя. Моля обнови картата си до <strong>${date}</strong>, за да не спре магазинът.</p>`,
        text: `Плащането на абонамента не успя. Обнови картата до ${date}.`,
      });
    } catch (err) { this.logger.error(`payment-failed email failed: ${this.errText(err)}`); }
  }
```

- [ ] **Step 5.3: Run tests — pass. Step 5.4: Commit** `git commit -am "feat(billing): webhook handler + 7-day grace on payment failure"`

---

## Task 6: setPremium + grace-expiry cron (TDD)

**Files:** Modify `billing.service.ts` + spec.

- [ ] **Step 6.1: Tests:** `setPremium(true)` → cancels any subscription, sets premium + status active + clears grace; `suspendExpiredGrace()` → tenants with status past_due & graceUntil<now become inactive (others untouched).

- [ ] **Step 6.2: Implement.**

```typescript
  import { Cron } from '@nestjs/schedule';   // add to imports
  import { and, lt } from 'drizzle-orm';     // add to imports

  /** Super-admin toggles a farm's premium (free) plan. */
  async setPremium(tenantId: string, premium: boolean): Promise<void> {
    const t = await this.tenant(tenantId);
    if (premium && t.stripeSubscriptionId && this.client) {
      try { await this.stripe.subscriptions.cancel(t.stripeSubscriptionId); }
      catch (err) { this.logger.warn(`cancel sub on premium failed: ${this.errText(err)}`); }
    }
    await this.db.update(tenants).set(
      premium
        ? { premium: true, subscriptionStatus: 'active', graceUntil: null, stripeSubscriptionId: null }
        : { premium: false },
    ).where(eq(tenants.id, tenantId));
  }

  /** Daily: suspend farms whose grace window has expired. */
  @Cron('0 3 * * *', { timeZone: 'Europe/Sofia' })
  async suspendExpiredGrace(): Promise<void> {
    const rows = await this.db.update(tenants)
      .set({ subscriptionStatus: 'inactive' })
      .where(and(eq(tenants.subscriptionStatus, 'past_due'), lt(tenants.graceUntil, new Date())))
      .returning({ id: tenants.id });
    if (rows.length) this.logger.log(`[billing] suspended ${rows.length} farm(s) after grace`);
  }
```

- [ ] **Step 6.3: Run tests — pass. Step 6.4: Commit** `git commit -am "feat(billing): premium toggle + daily grace-expiry suspend cron"`

---

## Task 7: BillingController + BillingModule + app wiring

**Files:** Create `billing.controller.ts`, `billing.module.ts`; modify `app.module.ts`.

- [ ] **Step 7.1: Controller.**

```typescript
import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BillingService } from './billing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('summary')
  summary(@CurrentTenant() tenantId: string) { return this.billing.summary(tenantId); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('checkout')
  checkout(@CurrentTenant() tenantId: string) { return this.billing.startCheckout(tenantId); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('portal')
  portal(@CurrentTenant() tenantId: string) { return this.billing.billingPortal(tenantId); }
}
```

- [ ] **Step 7.2: Module** (`billing.module.ts`) — provide + **export** BillingService (EmailModule is `@Global`, so no import needed; verify, else import it):

```typescript
import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';

@Module({ controllers: [BillingController], providers: [BillingService], exports: [BillingService] })
export class BillingModule {}
```

- [ ] **Step 7.3: Register** `BillingModule` in `server/src/app.module.ts` imports (after `StripeModule`). Confirm `EmailModule` is global; if not, add it to BillingModule imports.

- [ ] **Step 7.4: Build.** `pnpm --filter @farmflow/api build` → exit 0.

- [ ] **Step 7.5: Commit** `git add server/src/modules/billing server/src/app.module.ts && git commit -m "feat(billing): /billing controller + module wiring"`

---

## Task 8: Delegate billing webhook events from StripeService

**Files:** Modify `stripe.service.ts`, `stripe.module.ts`.

- [ ] **Step 8.1: Inject BillingService** into `StripeService` constructor (add `private readonly billing: BillingService` + import). In `stripe.module.ts`, add `BillingModule` to imports.

- [ ] **Step 8.2: Delegate** in `handleWebhook`'s switch — add a `default` (and explicit cases) routing billing events. After the existing cases, before the closing `}` of the switch:

```typescript
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'customer.subscription.deleted':
        await this.billing.handleBillingEvent(event);
        break;
```

And in the existing `checkout.session.completed` case, branch by mode: if `(event.data.object as any).mode === 'subscription'`, call `await this.billing.handleBillingEvent(event); break;` BEFORE the order-payment logic (subscription checkouts have no `metadata.orderId`).

- [ ] **Step 8.3: Build + run stripe tests.** `pnpm --filter @farmflow/api build && pnpm test -- --testPathPattern=stripe.service --no-coverage` → green (order-payment path unaffected).

- [ ] **Step 8.4: Commit** `git commit -am "feat(billing): route subscription/invoice webhooks to BillingService"`

---

## Task 9: Wire newsletter broadcast → billPush

**Files:** Modify `newsletter.service.ts`, `newsletter.module.ts`.

- [ ] **Step 9.1:** In `newsletter.module.ts`, add `BillingModule` to imports. Inject `BillingService` into `NewsletterService`.

- [ ] **Step 9.2:** In `broadcast()` (newsletter.service.ts:159-169), capture the inserted push id and bill it. Replace the insert block with:

```typescript
    const priceStotinki = this.config.get<number>('EMAIL_PUSH_PRICE_STOTINKI') ?? 200;
    if (recipients.length > 0) {
      try {
        const [push] = await this.db
          .insert(emailPushes)
          .values({ tenantId, subject: dto.subject, recipientCount: recipients.length, priceStotinki })
          .returning({ id: emailPushes.id });
        await this.billing.billPush(push.id);     // €2 invoice item (premium → free, idempotent)
      } catch (err) {
        this.logger.error(`[newsletter] push-record/bill failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
```

- [ ] **Step 9.3: Build + newsletter tests.** Update `newsletter.service.spec.ts` to provide a `BillingService` mock (`{ billPush: jest.fn() }`) and add `.returning` to the db mock's insert chain. `pnpm --filter @farmflow/api build && pnpm test -- --testPathPattern=newsletter --no-coverage` → green.

- [ ] **Step 9.4: Commit** `git commit -am "feat(billing): charge €2 per broadcast via BillingService.billPush"`

---

## Task 10: Super-admin — premium toggle + billing fields

**Files:** Modify `platform.service.ts`, `platform.controller.ts`, `platform.module.ts`, new `dto/set-premium.dto.ts`.

- [ ] **Step 10.1:** `platform.module.ts` → import `BillingModule`; inject `BillingService` into `PlatformService`.

- [ ] **Step 10.2:** Add `premium` + billing fields to `PlatformTenantRow` (add `premium: boolean`, `billingStatus: 'active'|'past_due'|'inactive'`, `graceUntil: Date|null`) and select them in `listTenants` (`premium: tenants.premium`, `billingStatus: tenants.subscriptionStatus`, `graceUntil: tenants.graceUntil`). Same for `PlatformTenantDetail` (add `premium`, `graceUntil`).

- [ ] **Step 10.3:** Add `setPremium` passthrough:

```typescript
  async setPremium(id: string, premium: boolean) {
    await this.billing.setPremium(id, premium);
    return { id, premium };
  }
```

- [ ] **Step 10.4:** DTO `dto/set-premium.dto.ts`:

```typescript
import { IsBoolean } from 'class-validator';
export class SetPremiumDto { @IsBoolean() premium: boolean; }
```

- [ ] **Step 10.5:** `platform.controller.ts` → add (mirror the existing `setStatus` route + `PlatformAdminGuard`):

```typescript
  @Patch(':id/premium')
  setPremium(@Param('id') id: string, @Body() dto: SetPremiumDto) {
    return this.platformService.setPremium(id, dto.premium);
  }
```

- [ ] **Step 10.6: Build + platform tests.** Provide a `BillingService` mock in `platform.service.spec.ts`. `pnpm --filter @farmflow/api build && pnpm test -- --testPathPattern=platform --no-coverage` → green.

- [ ] **Step 10.7: Commit** `git commit -am "feat(billing): super-admin premium toggle + billing status in tenant rows"`

---

## Task 11: Farmer Payments page — subscription card

**Files:** Modify `client/src/lib/api-client.ts`; create `client/src/components/payments/subscription-card.tsx`; modify `payments-client.tsx` + `(admin)/payments/page.tsx`.

- [ ] **Step 11.1:** `api-client.ts` — add `BillingSummary` type (mirror the server interface) + `getBillingSummary()`, `startBillingCheckout()`, `openBillingPortal()` (POST → `{url}`, then `window.location.href = url`). Follow the existing Stripe-connect client calls in this file for auth/headers.

- [ ] **Step 11.2:** `subscription-card.tsx` — read the existing `connect`/payments card styling (ff- tokens) from `payments-client.tsx` and render: plan line (**Стандартен — 30 €/мес + 2 €/бюлетин** or **Премиум — безплатно**), status badge (Активен / **Просрочен — спира на {graceUntil}** / Спрян), card-on-file (brand•last4) or „Добави карта" → checkout, „Управление" → portal, next-charge estimate line, and a „0% комисиона върху поръчките" note. Premium → hide card UI, show the free state. Disabled (`enabled:false`) → „Плащанията не са активни (свържи Stripe ключове)".

- [ ] **Step 11.3:** Render `<SubscriptionCard summary={...}/>` in `payments-client.tsx`; fetch `getBillingSummary()` in the page (server component) alongside the existing connect summary, pass down.

- [ ] **Step 11.4: Build.** `pnpm --filter @farmflow/web build` (or the client's package name) → routes present, 0 errors.

- [ ] **Step 11.5: Commit** `git commit -am "feat(billing): farmer subscription card on Payments page"`

---

## Task 12: Super-admin UI — premium + status

**Files:** Modify `admin/src/lib/api-client.ts`, `admin/src/components/tenants-client.tsx` (+ tenant detail page), `admin/src/components/email-billing-client.tsx`.

- [ ] **Step 12.1:** `api-client.ts` — add `premium`, `billingStatus`, `graceUntil` to the tenant row/detail types; add `setPremium(id, premium)` → `PATCH /platform/tenants/:id/premium`.

- [ ] **Step 12.2:** `tenants-client.tsx` — add a **plan** column (Стандартен / Премиум) + **billing status** chip (Активен / Просрочен +дни / Спрян); add a premium toggle (mirror the existing active/inactive `setStatus` toggle pattern, optimistic update + rollback).

- [ ] **Step 12.3:** `email-billing-client.tsx:26-28` — change the subtitle „Плащанията събираш ти, ръчно." → „Таксува се автоматично през Stripe (30 € абонамент + 2 € на бюлетин)."

- [ ] **Step 12.4: Build.** `pnpm --filter @farmflow/admin build` → 0 errors. **Step 12.5: Commit** `git commit -am "feat(billing): super-admin premium toggle + billing status UI"`

---

## Task 13: Full verification + docs

- [ ] **Step 13.1:** `pnpm -r build` → all packages 0 errors.
- [ ] **Step 13.2:** `pnpm --filter @farmflow/api test` → full suite green (new billing specs + existing).
- [ ] **Step 13.3: Disabled-safe live check** (no Stripe keys): boot API, `GET /billing/summary` (with a tenant JWT) → `enabled:false, plan:standard, status:active`; `POST /billing/checkout` → 400 „Stripe не е конфигуриран"; cash newsletter broadcast still records a push (price unchanged, no invoice item).
- [ ] **Step 13.4:** Update the integration-status memory + `docs/SECURITY.md`/`.env.example` notes if needed. Note the live-test prerequisites (real key + `STRIPE_BILLING_PRICE_ID` + webhook registered for `invoice.*`, `customer.subscription.*`, `checkout.session.completed`).
- [ ] **Step 13.5: Commit** any remaining `git commit -am "chore(billing): verification + docs"`.

---

## Self-Review

**Spec coverage:** €30/mo subscription (Task 3 checkout + price) ✓ · €2/broadcast invoice item (Task 4) ✓ · premium=free flag (Task 1 col, Task 6 setPremium, Task 10/12 UI) ✓ · grace-then-suspend (Task 5 + Task 6 cron) ✓ · card-required-no-trial (Task 3 checkout) ✓ · webhook-driven status (Task 5 + Task 8) ✓ · 0% orders (unchanged; UI note Task 11) ✓ · farmer UI (Task 11) ✓ · super-admin UI (Task 12) ✓ · disabled-safe (Task 3 + 13.3) ✓ · enum widen + gating unchanged (Task 1) ✓.

**Type consistency:** `BillingSummary` fields identical across server (Task 3) + clients (Task 11/12). `handleBillingEvent`/`billPush`/`setPremium`/`suspendExpiredGrace` signatures stable across tasks. `subscriptionStatus` values `active|past_due|inactive` consistent (schema, webhook, gating, UI).

**Deferred (spec §8):** annual plans, per-recipient pricing, Stripe Tax, custom dunning copy, seats — intentionally not in any task.
