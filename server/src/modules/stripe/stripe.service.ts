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
import { type Database, products, orders, tenants } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

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
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Stripe Connect integration for the storefront. Every call targets the farm's
 * **connected account** (`stripeAccount: tenant.stripeAccountId`). The service
 * degrades gracefully: with no `STRIPE_SECRET_KEY` it is "disabled" and the
 * checkout flow falls back to the cash path (`POST /public/:slug/orders`).
 *
 * Money is integer stotinki end-to-end; Stripe `unit_amount` is also the minor
 * unit, so values pass through unchanged. Currency = `bgn`.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly client: StripeClient | null;
  private readonly webhookSecret: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    config: ConfigService,
  ) {
    const key = config.get<string>('STRIPE_SECRET_KEY')?.trim();
    this.webhookSecret = config.get<string>('STRIPE_WEBHOOK_SECRET')?.trim() ?? '';
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
        if (existing.unit_amount !== p.priceStotinki || existing.currency !== 'bgn') {
          await this.stripe.prices.update(priceId, { active: false }, options);
          needNewPrice = true;
        }
      } catch {
        needNewPrice = true;
      }
    }
    if (needNewPrice) {
      const price = await this.stripe.prices.create(
        { product: stripeProductId, unit_amount: p.priceStotinki, currency: 'bgn' },
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
    const options: RequestOptions = { stripeAccount: params.stripeAccountId };

    const lineItems: SessionLineItem[] = params.lines.map((l) =>
      l.stripePriceId
        ? { price: l.stripePriceId, quantity: l.quantity }
        : {
            quantity: l.quantity,
            price_data: {
              currency: 'bgn',
              unit_amount: l.priceStotinki,
              product_data: { name: l.productName },
            },
          },
    );

    if (params.shippingStotinki > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: 'bgn',
          unit_amount: params.shippingStotinki,
          product_data: { name: 'Доставка' },
        },
      });
    }

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: lineItems,
        customer_email: params.customerEmail || undefined,
        metadata: { orderId: params.orderId },
        payment_intent_data: { metadata: { orderId: params.orderId } },
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

    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'payment_intent.succeeded'
    ) {
      const obj = event.data.object as {
        id?: string;
        metadata?: Record<string, string> | null;
        payment_intent?: string | { id: string } | null;
      };
      const paymentIntentId =
        event.type === 'payment_intent.succeeded' ? obj.id ?? null : this.idOf(obj.payment_intent);
      await this.markOrderPaid(obj.metadata?.orderId, paymentIntentId);
    }

    return { received: true };
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
  }
}
