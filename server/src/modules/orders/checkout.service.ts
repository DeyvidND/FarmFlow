import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { type Database, orders, tenants } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { OrdersService } from './orders.service';
import { StripeService, type CheckoutLine } from '../stripe/stripe.service';
import { EcontService } from '../econt/econt.service';
import { CreateOrderDto } from './dto/create-order.dto';
import {
  localFeeStotinki,
  econtFallbackFee,
  applyFreeThreshold,
  freeThresholdStotinki,
  econtMode,
  type DeliveryConfig,
} from './delivery-pricing';

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

    // 4. Build line items from the intake snapshot — the exact placed-at price
    //    (which also drives order.total and the webhook under-payment guard).
    const lines: CheckoutLine[] = order.items.map((i) => ({
      productName: i.productName ?? '',
      quantity: i.quantity,
      priceStotinki: i.priceStotinki,
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

    // Per-tenant delivery config (settings.delivery). Absent → legacy defaults.
    const cfg = order.tenantId ? await this.loadDelivery(order.tenantId) : null;

    // Local self-delivery — config base fee (free / flat) + global free-over threshold.
    if (method === 'address') {
      return localFeeStotinki(cfg, subtotal);
    }

    // Econt (office or door). Automatic mode prefers the live courier quote;
    // manual mode (farm ships itself) always uses the configured flat fee — no
    // API call. The global free-over threshold then applies on top.
    const door = method === 'econt_address';
    let fee: number;
    if (econtMode(cfg) === 'auto' && order.tenantId) {
      const live = await this.econt.estimateShipping(
        order.tenantId,
        order,
        order.items.map((i) => ({ name: i.productName, qty: i.quantity })),
      );
      fee = live ?? econtFallbackFee(cfg, door);
    } else {
      fee = econtFallbackFee(cfg, door);
    }
    return applyFreeThreshold(fee, subtotal, freeThresholdStotinki(cfg));
  }

  /** Load the tenant's `settings.delivery` config (null when unset → legacy defaults). */
  private async loadDelivery(tenantId: string): Promise<DeliveryConfig | null> {
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const s = row?.settings as { delivery?: DeliveryConfig } | null;
    return s?.delivery ?? null;
  }
}
