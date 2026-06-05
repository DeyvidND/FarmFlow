import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray } from 'drizzle-orm';
import { type Database, products, orders, tenants } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { OrdersService } from './orders.service';
import { StripeService, type CheckoutLine } from '../stripe/stripe.service';
import { EcontService } from '../econt/econt.service';
import { CreateOrderDto } from './dto/create-order.dto';

// Shipping rule (mirrors the storefront `lib/shipping.ts`): free over the
// threshold, otherwise a flat fee per delivery method.
const FREE_SHIPPING_THRESHOLD_STOTINKI = 4000;
const SHIPPING_ADDRESS_STOTINKI = 490; // local farm delivery (flat, regional)
const SHIPPING_ECONT_STOTINKI = 350; // Econt → office, fallback when no live quote
const SHIPPING_ECONT_ADDRESS_STOTINKI = 590; // Econt → door, fallback when no live quote

export interface CheckoutResult {
  orderId: string;
  /** Stripe-hosted Checkout URL, or `null` for the cash path (go to confirmation). */
  checkoutUrl: string | null;
}

/**
 * Storefront checkout orchestration. Reuses the row-locked order-intake
 * transaction (so over-capacity still yields a 409), folds shipping into the
 * order total, then — when the farm has a connected Stripe account — opens a
 * Checkout Session on it. With no Stripe configured it returns `checkoutUrl:
 * null` and the order is left `pending` for the farm to collect cash.
 */
@Injectable()
export class CheckoutService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly ordersService: OrdersService,
    private readonly stripe: StripeService,
    private readonly econt: EcontService,
    private readonly config: ConfigService,
  ) {}

  async create(slug: string, dto: CreateOrderDto): Promise<CheckoutResult> {
    // 1. Order intake — snapshot, row-lock the slot, 409 on overflow, status pending.
    const order = await this.ordersService.create(slug, dto);

    // 2. Fold shipping into the order total so the admin record matches the charge.
    const subtotal = order.items.reduce((sum, i) => sum + i.priceStotinki * i.quantity, 0);
    const shipping = await this.shippingStotinki(order, subtotal);
    const grandTotal = subtotal + shipping;
    if (grandTotal !== order.totalStotinki) {
      await this.db
        .update(orders)
        .set({ totalStotinki: grandTotal })
        .where(eq(orders.id, order.id));
    }

    // 3. Resolve the farm's connected account.
    const [tenant] = await this.db
      .select({ stripeAccountId: tenants.stripeAccountId })
      .from(tenants)
      .where(eq(tenants.id, order.tenantId!))
      .limit(1);

    // Cash / no-Stripe farm → order already created; client goes straight to confirmation.
    if (!tenant || !this.stripe.isEnabledForAccount(tenant.stripeAccountId)) {
      return { orderId: order.id, checkoutUrl: null };
    }

    // 4. Build line items, preferring synced Stripe prices (inline fallback otherwise).
    const productIds = order.items.map((i) => i.productId).filter((id): id is string => !!id);
    const prodRows = productIds.length
      ? await this.db
          .select({ id: products.id, stripePriceId: products.stripePriceId })
          .from(products)
          .where(and(eq(products.tenantId, order.tenantId!), inArray(products.id, productIds)))
      : [];
    const priceById = new Map(prodRows.map((p) => [p.id, p.stripePriceId]));
    const lines: CheckoutLine[] = order.items.map((i) => ({
      productName: i.productName ?? '',
      quantity: i.quantity,
      priceStotinki: i.priceStotinki,
      stripePriceId: i.productId ? priceById.get(i.productId) ?? null : null,
    }));

    // 5. Checkout Session on the connected account.
    const base = this.config.get<string>('STOREFRONT_URL')?.trim() || 'http://localhost:3003';
    const session = await this.stripe.createCheckoutSession({
      stripeAccountId: tenant.stripeAccountId,
      orderId: order.id,
      lines,
      shippingStotinki: shipping,
      totalStotinki: grandTotal,
      customerEmail: order.customerEmail,
      successUrl: `${base}/confirmation?order=${order.id}`,
      cancelUrl: `${base}/checkout`,
    });

    await this.db
      .update(orders)
      .set({ stripeCheckoutSessionId: session.checkoutSessionId })
      .where(eq(orders.id, order.id));

    return { orderId: order.id, checkoutUrl: session.checkoutUrl };
  }

  /**
   * Order shipping in stotinki. Free over the threshold. For Econt, prefer a live
   * price quote from the courier (when the farm has Econt connected); fall back to
   * the flat fee if Econt is unconfigured/unreachable. Address delivery is flat.
   */
  private async shippingStotinki(
    order: {
      tenantId: string | null;
      deliveryType: 'pickup' | 'address' | 'econt' | 'econt_address' | null;
      customerName: string | null;
      customerPhone: string | null;
      econtOffice: string | null;
      deliveryAddress: string | null;
      deliveryCity: string | null;
      items: { productName: string | null; quantity: number }[];
    },
    subtotal: number,
  ): Promise<number> {
    const method = order.deliveryType ?? 'address';
    // Market pickup — the customer collects at the stand, no delivery, no fee.
    if (method === 'pickup') return 0;
    // Local farm delivery — flat regional fee, free over the threshold (the farm
    // absorbs its own local delivery cost on big baskets).
    if (method === 'address') {
      return subtotal >= FREE_SHIPPING_THRESHOLD_STOTINKI ? 0 : SHIPPING_ADDRESS_STOTINKI;
    }

    // Econt (office or door) — always priced (a national courier charge is real;
    // no free-over-threshold). Prefer a live quote; fall back per method.
    if (order.tenantId) {
      const live = await this.econt.estimateShipping(
        order.tenantId,
        order,
        order.items.map((i) => ({ name: i.productName, qty: i.quantity })),
      );
      if (live != null) return live;
    }
    return method === 'econt_address' ? SHIPPING_ECONT_ADDRESS_STOTINKI : SHIPPING_ECONT_STOTINKI;
  }
}
