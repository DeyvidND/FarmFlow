import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { type Database, products, orders, tenants, stripeEvents } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { BillingService } from '../billing/billing.service';
import { EcontService } from '../econt/econt.service';

// stripe@22 ships `export = StripeConstructor`, so the rich `Stripe.*` type
// namespace isn't reachable through the default import under `moduleResolution:
// node`. Derive the few types we need straight from the client's method
// signatures instead — fully type-safe, no namespace reference.
type StripeClient = InstanceType<typeof Stripe>;
type RequestOptions = NonNullable<Parameters<StripeClient['products']['create']>[1]>;
type SessionCreateParams = NonNullable<
  Parameters<StripeClient['checkout']['sessions']['create']>[0]
>;
type SessionLineItem = NonNullable<SessionCreateParams['line_items']>[number];

/** One order line as snapshotted at intake — enough to build a Stripe line item. */
export interface CheckoutLine {
  productName: string;
  quantity: number;
  priceStotinki: number;
  /** Synced Stripe price id, if the catalog was synced; else inline price_data is used. */
  stripePriceId?: string | null;
}

export interface CreateCheckoutParams {
  stripeAccountId: string;
  orderId: string;
  lines: CheckoutLine[];
  shippingStotinki: number;
  /** Order grand total (items + shipping) — the base for the platform fee. */
  totalStotinki: number;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
}

/** Summary for the farmer Payments page — connection state + balance/next payout. */
export interface ConnectSummary {
  /** Stripe is configured on the server (secret key present). */
  enabled: boolean;
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** Stripe balance, minor units (EUR cents). */
  availableStotinki: number;
  pendingStotinki: number;
  /** Next scheduled payout to the farm's bank, if one is pending / in transit. */
  nextPayout: { amountStotinki: number; arrivalDate: string } | null;
  /** Platform commission in basis points — for the UI's transparency line. */
  feeBps: number;
}

/**
 * Stripe Connect integration for the storefront. Every call targets the farm's
 * **connected account** (`stripeAccount: tenant.stripeAccountId`). The service
 * degrades gracefully: with no `STRIPE_SECRET_KEY` it is "disabled" and the
 * checkout flow falls back to the cash path (`POST /public/:slug/orders`).
 *
 * Money is integer cents end-to-end; Stripe `unit_amount` is also the minor
 * unit, so values pass through unchanged. Currency = `eur`.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly client: StripeClient | null;
  private readonly webhookSecret: string;
  private readonly feeBps: number;
  private readonly connectCountry: string;
  private readonly panelUrl: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    config: ConfigService,
    private readonly billing: BillingService,
    private readonly econt: EcontService,
  ) {
    const key = config.get<string>('STRIPE_SECRET_KEY')?.trim();
    this.webhookSecret = config.get<string>('STRIPE_WEBHOOK_SECRET')?.trim() ?? '';
    this.feeBps = config.get<number>('STRIPE_PLATFORM_FEE_BPS', 0);
    this.connectCountry = config.get<string>('STRIPE_CONNECT_COUNTRY', 'BG');
    // CORS_ORIGIN may be a comma-separated allowlist — the panel redirect base is
    // the first (primary) origin.
    this.panelUrl = (config.get<string>('CORS_ORIGIN') ?? 'http://localhost:3000')
      .split(',')[0]
      .trim()
      .replace(/\/+$/, '');
    this.client = key ? new Stripe(key) : null;
    if (!this.client) {
      this.logger.warn(
        'STRIPE_SECRET_KEY not set — Stripe disabled; storefront checkout uses the cash path.',
      );
    }
  }

  /** True when a secret key is configured (catalog sync / checkout are possible). */
  isEnabled(): boolean {
    return this.client !== null;
  }

  /** A farm can take Stripe payments only when Stripe is configured AND it has a connected account. */
  isEnabledForAccount(stripeAccountId: string | null | undefined): stripeAccountId is string {
    return this.client !== null && !!stripeAccountId;
  }

  private get stripe(): StripeClient {
    if (!this.client) throw new BadRequestException('Stripe не е конфигуриран');
    return this.client;
  }

  /* --------------------------- connect onboarding -------------------------- */

  /**
   * The tenant's connected-account id, creating an Express account on the first
   * call and persisting it to `tenants.stripe_account_id`. Lets a farm self-serve
   * connect Stripe instead of an operator pasting an `acct_…` id into the DB.
   */
  async ensureConnectedAccount(tenantId: string): Promise<string> {
    const [tenant] = await this.db
      .select({
        id: tenants.id,
        stripeAccountId: tenants.stripeAccountId,
        email: tenants.email,
        name: tenants.name,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');
    if (tenant.stripeAccountId) return tenant.stripeAccountId;

    const account = await this.stripe.accounts.create(
      {
        type: 'express',
        country: this.connectCountry,
        email: tenant.email ?? undefined,
        business_profile: { name: tenant.name },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { farmflowTenantId: tenant.id },
      },
      // One account per tenant even if this call is retried before we persist.
      { idempotencyKey: `ff_connect_${tenantId}` },
    );
    await this.db
      .update(tenants)
      .set({ stripeAccountId: account.id })
      .where(eq(tenants.id, tenantId));
    return account.id;
  }

  /** Hosted onboarding link the farm follows to finish connecting its account. */
  async createOnboardingLink(tenantId: string): Promise<{ url: string }> {
    const accountId = await this.ensureConnectedAccount(tenantId);
    const link = await this.stripe.accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      refresh_url: `${this.panelUrl}/settings?stripe=refresh`,
      return_url: `${this.panelUrl}/settings?stripe=done`,
    });
    return { url: link.url };
  }

  /** Whether the farm can take card payments yet (onboarding complete + enabled). */
  async accountStatus(tenantId: string): Promise<{
    connected: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
  }> {
    const [tenant] = await this.db
      .select({ stripeAccountId: tenants.stripeAccountId })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant?.stripeAccountId) {
      return { connected: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
    }
    const acct = await this.stripe.accounts.retrieve(tenant.stripeAccountId);
    return {
      connected: true,
      chargesEnabled: !!acct.charges_enabled,
      payoutsEnabled: !!acct.payouts_enabled,
      detailsSubmitted: !!acct.details_submitted,
    };
  }

  /**
   * Mint a Stripe **Account Session** so the admin can embed Stripe Connect
   * components (onboarding, notification banner, payments, account management)
   * directly inside FarmFlow. Creates the Express account on the first call.
   */
  async createAccountSession(tenantId: string): Promise<{ clientSecret: string }> {
    const accountId = await this.ensureConnectedAccount(tenantId);
    const session = await this.stripe.accountSessions.create({
      account: accountId,
      components: {
        account_onboarding: { enabled: true },
        notification_banner: { enabled: true },
        payments: {
          enabled: true,
          features: { refund_management: true, dispute_management: true, capture_payments: true },
        },
        account_management: { enabled: true },
      },
    });
    return { clientSecret: session.client_secret };
  }

  /**
   * Connection state + a friendly balance / next-payout summary for the
   * Payments page. Never throws: returns a safe disconnected summary when Stripe
   * is disabled, the farm has no account, or any Stripe lookup fails — so the
   * page can render every state from this one call.
   */
  async connectSummary(tenantId: string): Promise<ConnectSummary> {
    const base: ConnectSummary = {
      enabled: !!this.client,
      connected: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      availableStotinki: 0,
      pendingStotinki: 0,
      nextPayout: null,
      feeBps: this.feeBps,
    };
    if (!this.client) return base;

    const [tenant] = await this.db
      .select({ stripeAccountId: tenants.stripeAccountId })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const accountId = tenant?.stripeAccountId;
    if (!accountId) return base;

    try {
      const acct = await this.client.accounts.retrieve(accountId);
      base.connected = true;
      base.chargesEnabled = !!acct.charges_enabled;
      base.payoutsEnabled = !!acct.payouts_enabled;
      base.detailsSubmitted = !!acct.details_submitted;
    } catch (err) {
      this.logger.warn(`Stripe account retrieve failed (${tenantId}): ${this.errText(err)}`);
      return base;
    }

    // A fresh, not-yet-active account can reject balance/payout reads — guard.
    if (!base.chargesEnabled) return base;

    try {
      const balance = await this.client.balance.retrieve({}, { stripeAccount: accountId });
      base.availableStotinki = this.sumEur(balance.available);
      base.pendingStotinki = this.sumEur(balance.pending);
    } catch (err) {
      this.logger.warn(`Stripe balance read failed (${tenantId}): ${this.errText(err)}`);
    }

    try {
      const payouts = await this.client.payouts.list({ limit: 1 }, { stripeAccount: accountId });
      const p = payouts.data[0];
      if (p && (p.status === 'pending' || p.status === 'in_transit')) {
        base.nextPayout = {
          amountStotinki: p.amount,
          arrivalDate: new Date(p.arrival_date * 1000).toISOString(),
        };
      }
    } catch (err) {
      this.logger.warn(`Stripe payout read failed (${tenantId}): ${this.errText(err)}`);
    }

    return base;
  }

  private sumEur(entries: { amount: number; currency: string }[]): number {
    return entries.filter((e) => e.currency === 'eur').reduce((s, e) => s + e.amount, 0);
  }

  private errText(err: unknown): string {
    return err instanceof Error ? err.message : 'unknown';
  }

  /* ------------------------------ catalog sync ----------------------------- */

  /**
   * Upsert the tenant's active products into its Stripe catalog (Product + Price
   * on the connected account) and persist the resulting ids. Idempotent: a
   * product is updated in place; a price (immutable in Stripe) is archived and
   * recreated only when the amount/currency changed.
   */
  async syncCatalog(tenantId: string): Promise<{ synced: number }> {
    const [tenant] = await this.db
      .select({ id: tenants.id, stripeAccountId: tenants.stripeAccountId })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');
    if (!this.isEnabledForAccount(tenant.stripeAccountId)) {
      throw new BadRequestException('Фермата няма свързан Stripe акаунт');
    }
    const options: RequestOptions = { stripeAccount: tenant.stripeAccountId };

    const rows = await this.db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.isActive, true)));

    let synced = 0;
    for (const p of rows) {
      const ids = await this.upsertProductPrice(p, options);
      if (ids.stripeProductId !== p.stripeProductId || ids.stripePriceId !== p.stripePriceId) {
        await this.db.update(products).set(ids).where(eq(products.id, p.id));
      }
      synced++;
    }
    return { synced };
  }

  private async upsertProductPrice(
    p: typeof products.$inferSelect,
    options: RequestOptions,
  ): Promise<{ stripeProductId: string; stripePriceId: string }> {
    // Product — update in place, or (re)create if missing/never synced.
    let productId: string | null = p.stripeProductId;
    if (productId) {
      try {
        await this.stripe.products.update(
          productId,
          { name: p.name, active: true, metadata: { farmflowProductId: p.id } },
          options,
        );
      } catch {
        productId = null; // disappeared on Stripe — recreate below
      }
    }
    if (!productId) {
      const created = await this.stripe.products.create(
        { name: p.name, metadata: { farmflowProductId: p.id } },
        options,
      );
      productId = created.id;
    }
    const stripeProductId: string = productId;

    // Price — immutable; recreate (archiving the old one) only when it changed.
    let priceId: string | null = p.stripePriceId;
    let needNewPrice = !priceId;
    if (priceId) {
      try {
        const existing = await this.stripe.prices.retrieve(priceId, undefined, options);
        if (existing.unit_amount !== p.priceStotinki || existing.currency !== 'eur') {
          await this.stripe.prices.update(priceId, { active: false }, options);
          needNewPrice = true;
        }
      } catch {
        needNewPrice = true;
      }
    }
    if (needNewPrice) {
      const price = await this.stripe.prices.create(
        { product: stripeProductId, unit_amount: p.priceStotinki, currency: 'eur' },
        options,
      );
      priceId = price.id;
    }

    return { stripeProductId, stripePriceId: priceId as string };
  }

  /* ------------------------------- checkout -------------------------------- */

  /** Create a Checkout Session on the farm's connected account for an existing order. */
  async createCheckoutSession(
    params: CreateCheckoutParams,
  ): Promise<{ checkoutSessionId: string; checkoutUrl: string | null }> {
    // Idempotent per order: a retried checkout for the same order returns the
    // same session instead of creating a duplicate.
    const options: RequestOptions = {
      stripeAccount: params.stripeAccountId,
      idempotencyKey: `ff_checkout_${params.orderId}`,
    };

    const lineItems: SessionLineItem[] = params.lines.map((l) =>
      l.stripePriceId
        ? { price: l.stripePriceId, quantity: l.quantity }
        : {
            quantity: l.quantity,
            price_data: {
              currency: 'eur',
              unit_amount: l.priceStotinki,
              product_data: { name: l.productName },
            },
          },
    );

    if (params.shippingStotinki > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: params.shippingStotinki,
          product_data: { name: 'Доставка' },
        },
      });
    }

    // Platform commission on the connected-account direct charge. 0 bps → omitted
    // so the farm keeps 100%.
    const feeAmount =
      this.feeBps > 0 ? Math.round((params.totalStotinki * this.feeBps) / 10000) : 0;

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: lineItems,
        customer_email: params.customerEmail || undefined,
        metadata: { orderId: params.orderId },
        payment_intent_data: {
          metadata: { orderId: params.orderId },
          ...(feeAmount > 0 ? { application_fee_amount: feeAmount } : {}),
        },
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
      },
      options,
    );

    return { checkoutSessionId: session.id, checkoutUrl: session.url };
  }

  /* -------------------------------- webhook -------------------------------- */

  /**
   * Verify + handle a Stripe webhook (raw body + signature). On a successful
   * payment the order flips to `confirmed` with `paidAt` set (the slot stays
   * booked). Expiry/failure is left untouched — a pending order frees its slot
   * only when explicitly cancelled.
   */
  async handleWebhook(rawBody: Buffer, signature: string): Promise<{ received: boolean }> {
    if (!this.client) throw new BadRequestException('Stripe не е конфигуриран');
    if (!this.webhookSecret) throw new BadRequestException('Stripe webhook secret липсва');

    let event: ReturnType<StripeClient['webhooks']['constructEvent']>;
    try {
      event = this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (err) {
      throw new BadRequestException(
        `Невалиден webhook подпис: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }

    // Idempotency: record the event id, and no-op if Stripe redelivers it (retries
    // happen on any non-2xx or network blip — without this a refund/payment could
    // be double-applied).
    const [fresh] = await this.db
      .insert(stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });
    if (!fresh) return { received: true };

    switch (event.type) {
      case 'checkout.session.completed': {
        const obj = event.data.object as {
          mode?: string;
          metadata?: Record<string, string> | null;
          payment_intent?: string | { id: string } | null;
        };
        // SaaS subscription checkout (platform billing) — not an order payment.
        if (obj.mode === 'subscription') {
          await this.billing.handleBillingEvent(event);
          break;
        }
        await this.markOrderPaid(obj.metadata?.orderId, this.idOf(obj.payment_intent));
        break;
      }
      case 'payment_intent.succeeded': {
        const obj = event.data.object as {
          id?: string;
          metadata?: Record<string, string> | null;
        };
        await this.markOrderPaid(obj.metadata?.orderId, obj.id ?? null);
        break;
      }
      case 'charge.refunded': {
        // The charge rarely carries our orderId; resolve via the stored payment
        // intent. Only a FULL refund cancels the order (and frees its slot) — a
        // partial refund leaves it `confirmed`, since the customer still received
        // (and paid for) most of the order.
        const charge = event.data.object as {
          payment_intent?: string | { id: string } | null;
          metadata?: Record<string, string> | null;
          amount?: number;
          amount_refunded?: number;
          refunded?: boolean;
        };
        const fullyRefunded =
          charge.refunded === true ||
          (typeof charge.amount === 'number' &&
            typeof charge.amount_refunded === 'number' &&
            charge.amount > 0 &&
            charge.amount_refunded >= charge.amount);
        if (fullyRefunded) {
          await this.markOrderRefunded(this.idOf(charge.payment_intent), charge.metadata?.orderId);
        } else {
          this.logger.log(
            `Partial refund on order ${charge.metadata?.orderId ?? '?'} — order left confirmed`,
          );
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object as { metadata?: Record<string, string> | null };
        this.logger.warn(
          `Stripe payment failed for order ${pi.metadata?.orderId ?? '?'} — left pending`,
        );
        break;
      }
      case 'account.updated': {
        // Connected-account capability change — mirror the flags onto the tenant
        // so the super-admin oversight table stays fresh without polling Stripe.
        await this.syncAccountStatus(
          event.data.object as {
            id?: string;
            charges_enabled?: boolean;
            payouts_enabled?: boolean;
            details_submitted?: boolean;
          },
        );
        break;
      }
      // Platform-side SaaS subscription billing — delegate to BillingService.
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'customer.subscription.deleted':
        await this.billing.handleBillingEvent(event);
        break;
    }

    return { received: true };
  }

  /** Persist a connected account's capability flags onto its tenant row. */
  private async syncAccountStatus(account: {
    id?: string;
    charges_enabled?: boolean;
    payouts_enabled?: boolean;
    details_submitted?: boolean;
  }): Promise<void> {
    if (!account.id) return;
    await this.db
      .update(tenants)
      .set({
        stripeChargesEnabled: !!account.charges_enabled,
        stripePayoutsEnabled: !!account.payouts_enabled,
        stripeDetailsSubmitted: !!account.details_submitted,
        stripeStatusUpdatedAt: new Date(),
      })
      .where(eq(tenants.stripeAccountId, account.id));
  }

  private idOf(ref: string | { id: string } | null | undefined): string | null {
    if (!ref) return null;
    return typeof ref === 'string' ? ref : ref.id;
  }

  private async markOrderPaid(
    orderId: string | undefined,
    paymentIntentId: string | null,
  ): Promise<void> {
    if (!orderId) {
      this.logger.warn('Stripe webhook missing metadata.orderId — ignoring');
      return;
    }
    await this.db
      .update(orders)
      .set({
        status: 'confirmed',
        paidAt: new Date(),
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      })
      .where(eq(orders.id, orderId));

    // Fire-and-forget: auto-create the Econt waybill if the farm enabled it. Must
    // never block or fail the webhook (the method swallows its own errors).
    void this.econt.autoCreateForOrder(orderId);
  }

  /** A refunded charge cancels the order (frees the slot) and clears the paid mark. */
  private async markOrderRefunded(
    paymentIntentId: string | null,
    orderId?: string,
  ): Promise<void> {
    const cond = orderId
      ? eq(orders.id, orderId)
      : paymentIntentId
        ? eq(orders.stripePaymentIntentId, paymentIntentId)
        : null;
    if (!cond) {
      this.logger.warn('Stripe refund webhook with no order linkage — ignoring');
      return;
    }
    await this.db.update(orders).set({ status: 'cancelled', paidAt: null }).where(cond);
  }
}
