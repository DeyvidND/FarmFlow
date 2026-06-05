import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { and, eq, lt } from 'drizzle-orm';
import Stripe from 'stripe';
import { type Database, tenants, emailPushes } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';

// stripe@22 ships `export = StripeConstructor`; derive the client type from the
// constructor instead of the (unreachable) `Stripe.*` namespace. Mirrors StripeService.
type StripeClient = InstanceType<typeof Stripe>;

/** Billing snapshot for the farmer Payments page. Renders every state from one call. */
export interface BillingSummary {
  /** STRIPE_SECRET_KEY + STRIPE_BILLING_PRICE_ID both present. */
  enabled: boolean;
  plan: 'standard' | 'premium';
  status: 'active' | 'past_due' | 'inactive';
  graceUntil: string | null;
  hasCard: boolean;
  cardBrand: string | null;
  cardLast4: string | null;
  basePriceStotinki: number;
  emailPriceStotinki: number;
  pushesThisCycle: number;
  /** Estimated amount of the next invoice (base + €2 × pushes this cycle). */
  estimatedNextStotinki: number;
  invoices: { amountStotinki: number; status: string; date: string; url: string | null }[];
}

/**
 * Platform-side SaaS billing: the platform charges each farm €30/mo + €2 per
 * newsletter broadcast via a Stripe **subscription** on the **platform** account
 * (every call here omits `stripeAccount` — that option is for Connect / order
 * payments only). A `premium` farm pays nothing. Degrades gracefully: with no
 * `STRIPE_SECRET_KEY` the service is disabled and `summary()` returns a safe
 * snapshot while charging methods throw a clear 400.
 *
 * Money is integer EUR cents end-to-end.
 */
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
    if (!this.client) {
      this.logger.warn('STRIPE_SECRET_KEY not set — SaaS billing disabled.');
    }
  }

  /** Billing is usable only with both a secret key AND the recurring price id. */
  isEnabled(): boolean {
    return this.client !== null && this.priceId !== '';
  }

  private get stripe(): StripeClient {
    if (!this.client) throw new BadRequestException('Stripe не е конфигуриран');
    return this.client;
  }

  private async tenant(id: string): Promise<typeof tenants.$inferSelect> {
    const [t] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundException('Фермата не е намерена');
    return t;
  }

  private errText(err: unknown): string {
    return err instanceof Error ? err.message : 'unknown';
  }

  /* ----------------------------- customer / card ---------------------------- */

  /** Find/create the platform-side Stripe Customer for a (non-premium) farm. */
  async getOrCreateCustomer(tenantId: string): Promise<string> {
    const t = await this.tenant(tenantId);
    if (t.stripeCustomerId) return t.stripeCustomerId;
    const customer = await this.stripe.customers.create({
      email: t.email ?? undefined,
      name: t.name,
      metadata: { farmflowTenantId: t.id },
    });
    await this.db
      .update(tenants)
      .set({ stripeCustomerId: customer.id })
      .where(eq(tenants.id, tenantId));
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

  /** Stripe Billing Portal (update card, view invoices, cancel). */
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

  /* -------------------------------- summary -------------------------------- */

  /** Billing snapshot for the farmer Payments page. Never throws. */
  async summary(tenantId: string): Promise<BillingSummary> {
    const base: BillingSummary = {
      enabled: this.isEnabled(),
      plan: 'standard',
      status: 'active',
      graceUntil: null,
      hasCard: false,
      cardBrand: null,
      cardLast4: null,
      basePriceStotinki: this.basePrice,
      emailPriceStotinki: this.emailPrice,
      pushesThisCycle: 0,
      estimatedNextStotinki: this.basePrice,
      invoices: [],
    };

    let t: typeof tenants.$inferSelect;
    try {
      t = await this.tenant(tenantId);
    } catch {
      return base;
    }
    base.plan = t.premium ? 'premium' : 'standard';
    base.status = (t.subscriptionStatus as BillingSummary['status']) ?? 'active';
    base.graceUntil = t.graceUntil ? new Date(t.graceUntil).toISOString() : null;

    if (t.premium || !this.client || !t.stripeCustomerId) {
      base.estimatedNextStotinki = t.premium ? 0 : this.basePrice;
      return base;
    }

    try {
      const customer = await this.client.customers.retrieve(t.stripeCustomerId, {
        expand: ['invoice_settings.default_payment_method'],
      });
      const pm = (customer as { invoice_settings?: { default_payment_method?: { card?: { brand?: string; last4?: string } } } })
        .invoice_settings?.default_payment_method;
      if (pm?.card) {
        base.hasCard = true;
        base.cardBrand = pm.card.brand ?? null;
        base.cardLast4 = pm.card.last4 ?? null;
      }
    } catch (err) {
      this.logger.warn(`billing customer read failed (${tenantId}): ${this.errText(err)}`);
    }

    try {
      const invs = await this.client.invoices.list({ customer: t.stripeCustomerId, limit: 6 });
      base.invoices = invs.data.map((i) => ({
        amountStotinki: i.amount_due,
        status: i.status ?? 'unknown',
        date: new Date((i.created ?? 0) * 1000).toISOString(),
        url: i.hosted_invoice_url ?? null,
      }));
      const open = invs.data.find((i) => i.status === 'draft' || i.status === 'open');
      base.estimatedNextStotinki = open ? open.amount_due : this.basePrice;
    } catch (err) {
      this.logger.warn(`billing invoices read failed (${tenantId}): ${this.errText(err)}`);
    }

    return base;
  }

  /* -------------------------------- billing -------------------------------- */

  /**
   * Charge a newsletter broadcast: add a €2 invoice item to the farm's customer
   * so it rolls into the next subscription invoice. Premium → free (price 0, no
   * charge). Idempotent: a push that already carries an invoice-item id is skipped.
   * No customer yet → left unbilled (gating normally prevents an unbilled send).
   */
  async billPush(pushId: string): Promise<void> {
    const [push] = await this.db
      .select()
      .from(emailPushes)
      .where(eq(emailPushes.id, pushId))
      .limit(1);
    if (!push || !push.tenantId) return;
    if (push.stripeInvoiceItemId) return; // already billed

    const t = await this.tenant(push.tenantId);
    if (t.premium) {
      await this.db
        .update(emailPushes)
        .set({ priceStotinki: 0 })
        .where(eq(emailPushes.id, pushId));
      return;
    }
    if (!this.client || !t.stripeCustomerId) return; // not billable yet

    try {
      const item = await this.stripe.invoiceItems.create({
        customer: t.stripeCustomerId,
        amount: this.emailPrice,
        currency: 'eur',
        description: `Бюлетин: ${push.subject ?? ''} (${push.recipientCount} получателя)`,
        metadata: { farmflowTenantId: t.id, pushId },
      });
      await this.db
        .update(emailPushes)
        .set({ stripeInvoiceItemId: item.id })
        .where(eq(emailPushes.id, pushId));
    } catch (err) {
      this.logger.error(`billPush failed for ${pushId}: ${this.errText(err)}`);
    }
  }

  /* -------------------------------- webhook -------------------------------- */

  /**
   * Handle platform-account billing events (delegated from StripeService.handleWebhook
   * after signature-verify + idempotency). Resolves the tenant by stored
   * customer/subscription id.
   */
  async handleBillingEvent(event: { type: string; data: { object: Record<string, any> } }): Promise<void> {
    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.mode !== 'subscription') return; // order checkouts handled elsewhere
        const tenantId = await this.resolveTenant({ customer: this.idOf(obj.customer) });
        if (!tenantId) return;
        await this.db
          .update(tenants)
          .set({
            stripeSubscriptionId: this.idOf(obj.subscription),
            subscriptionStatus: 'active',
            graceUntil: null,
          })
          .where(eq(tenants.id, tenantId));
        break;
      }
      case 'invoice.paid': {
        const tenantId = await this.resolveTenant({ customer: this.idOf(obj.customer) });
        if (!tenantId) return;
        await this.db
          .update(tenants)
          .set({ subscriptionStatus: 'active', graceUntil: null })
          .where(eq(tenants.id, tenantId));
        break;
      }
      case 'invoice.payment_failed': {
        const tenantId = await this.resolveTenant({ customer: this.idOf(obj.customer) });
        if (!tenantId) return;
        const t = await this.tenant(tenantId);
        if (t.graceUntil) return; // grace already running — don't reset the timer
        const graceUntil = new Date(Date.now() + this.graceDays * 86_400_000);
        await this.db
          .update(tenants)
          .set({ subscriptionStatus: 'past_due', graceUntil })
          .where(eq(tenants.id, tenantId));
        await this.notifyPaymentFailed(t.email, graceUntil);
        break;
      }
      case 'customer.subscription.deleted': {
        const tenantId = await this.resolveTenant({
          subscription: this.idOf(obj.id),
          customer: this.idOf(obj.customer),
        });
        if (!tenantId) return;
        await this.db
          .update(tenants)
          .set({ subscriptionStatus: 'inactive' })
          .where(eq(tenants.id, tenantId));
        break;
      }
    }
  }

  private idOf(ref: unknown): string | null {
    if (!ref) return null;
    if (typeof ref === 'string') return ref;
    if (typeof ref === 'object' && 'id' in (ref as Record<string, unknown>)) {
      return String((ref as { id: unknown }).id);
    }
    return null;
  }

  private async resolveTenant(ref: { customer?: string | null; subscription?: string | null }): Promise<string | null> {
    if (ref.customer) {
      const [t] = await this.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.stripeCustomerId, ref.customer))
        .limit(1);
      if (t) return t.id;
    }
    if (ref.subscription) {
      const [t] = await this.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.stripeSubscriptionId, ref.subscription))
        .limit(1);
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
    } catch (err) {
      this.logger.error(`payment-failed email failed: ${this.errText(err)}`);
    }
  }

  /* ----------------------------- premium / cron ---------------------------- */

  /** Super-admin toggles a farm's premium (free) plan. */
  async setPremium(tenantId: string, premium: boolean): Promise<void> {
    const t = await this.tenant(tenantId);
    if (premium && t.stripeSubscriptionId && this.client) {
      try {
        await this.stripe.subscriptions.cancel(t.stripeSubscriptionId);
      } catch (err) {
        this.logger.warn(`cancel sub on premium failed: ${this.errText(err)}`);
      }
    }
    await this.db
      .update(tenants)
      .set(
        premium
          ? { premium: true, subscriptionStatus: 'active', graceUntil: null, stripeSubscriptionId: null }
          : { premium: false },
      )
      .where(eq(tenants.id, tenantId));
  }

  /** Daily: suspend farms whose grace window has expired. */
  @Cron('0 3 * * *', { timeZone: 'Europe/Sofia' })
  async suspendExpiredGrace(): Promise<void> {
    const rows = await this.db
      .update(tenants)
      .set({ subscriptionStatus: 'inactive' })
      .where(and(eq(tenants.subscriptionStatus, 'past_due'), lt(tenants.graceUntil, new Date())))
      .returning({ id: tenants.id });
    if (rows.length) this.logger.log(`[billing] suspended ${rows.length} farm(s) after grace`);
  }
}
