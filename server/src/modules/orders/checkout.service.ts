import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray } from 'drizzle-orm';
import { type Database, products, orders, tenants } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { OrdersService } from './orders.service';
import { StripeService, type CheckoutLine } from '../stripe/stripe.service';
import { CreateOrderDto } from './dto/create-order.dto';

// Shipping rule (mirrors the storefront `lib/shipping.ts`): free over the
// threshold, otherwise a flat fee per delivery method.
const FREE_SHIPPING_THRESHOLD_STOTINKI = 4000;
const SHIPPING_ADDRESS_STOTINKI = 490;
const SHIPPING_ECONT_STOTINKI = 350;

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
    private readonly config: ConfigService,
  ) {}

  async create(slug: string, dto: CreateOrderDto): Promise<CheckoutResult> {
    // 1. Order intake — snapshot, row-lock the slot, 409 on overflow, status pending.
    const order = await this.ordersService.create(slug, dto);

    // 2. Fold shipping into the order total so the admin record matches the charge.
    const subtotal = order.items.reduce((sum, i) => sum + i.priceStotinki * i.quantity, 0);
    const shipping = this.shippingStotinki(order.deliveryType, subtotal);
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

  private shippingStotinki(deliveryType: 'address' | 'econt' | null, subtotal: number): number {
    if (subtotal >= FREE_SHIPPING_THRESHOLD_STOTINKI) return 0;
    return deliveryType === 'econt' ? SHIPPING_ECONT_STOTINKI : SHIPPING_ADDRESS_STOTINKI;
  }
}
