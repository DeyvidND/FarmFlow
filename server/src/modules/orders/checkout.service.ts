import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { type Database, orders, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { OrdersService } from './orders.service';
import { StripeService, type CheckoutLine } from '../stripe/stripe.service';
import { EcontService } from '../econt/econt.service';
import { OrderConfirmationService } from '../order-email/order-confirmation.service';
import { CreateOrderDto } from './dto/create-order.dto';
import {
  localFeeStotinki,
  econtFallbackFee,
  applyFreeThreshold,
  freeThresholdStotinki,
  econtMode,
  codEnabled,
  type DeliveryConfig,
} from './delivery-pricing';

export interface CheckoutResult {
  orderId: string;
  /** Stripe-hosted Checkout URL, or `null` for the cash path (go to confirmation). */
  checkoutUrl: string | null;
}

/** The full order row + items as returned by OrdersService.create. */
type PlacedOrder = Awaited<ReturnType<OrdersService['create']>>;

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
    private readonly orderConfirmation: OrderConfirmationService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Create the order and fold the delivery fee into its total. Shared by the
   * Stripe checkout path and the bare `POST /public/:slug/orders` path, so the
   * recorded total ALWAYS includes shipping (never just the subtotal).
   */
  private async createAndFold(
    slug: string,
    dto: CreateOrderDto,
    preloadedCfg?: DeliveryConfig | null,
  ): Promise<{ order: PlacedOrder; subtotal: number; shipping: number; grandTotal: number }> {
    // Order intake — snapshot, row-lock the slot, 409 on overflow, status pending.
    const order = await this.ordersService.create(slug, dto);
    const subtotal = order.items.reduce((sum, i) => sum + i.priceStotinki * i.quantity, 0);
    const shipping = await this.shippingStotinki(order, subtotal, preloadedCfg);
    const grandTotal = subtotal + shipping;
    if (grandTotal !== order.totalStotinki) {
      await this.db
        .update(orders)
        .set({ totalStotinki: grandTotal })
        .where(eq(orders.id, order.id));
      order.totalStotinki = grandTotal;
    }
    return { order, subtotal, shipping, grandTotal };
  }

  /**
   * Place an order via the bare public endpoint — shipping folded into the total,
   * but no Stripe session (that endpoint never returned a checkout URL). Returns
   * the full order so the storefront can render the confirmation page.
   */
  async placeOrder(slug: string, dto: CreateOrderDto): Promise<PlacedOrder> {
    const { order } = await this.createAndFold(slug, dto);
    // Cash path → the order is final now (no online payment to wait for). Tell the
    // buyer we received it; the "confirmed" mail follows when the farm confirms.
    void this.orderConfirmation.sendReceived(order.id);
    return order;
  }

  async create(slug: string, dto: CreateOrderDto): Promise<CheckoutResult> {
    // Resolve the farm ONCE — drives both the pre-flight payment check and the
    // Stripe branch below.
    const [tenant] = await this.db
      .select({
        settings: tenants.settings,
        stripeAccountId: tenants.stripeAccountId,
        stripeChargesEnabled: tenants.stripeChargesEnabled,
      })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    // Card requires a linked account that can actually charge (onboarding complete →
    // charges_enabled), mirroring the storefront gate. An 'online' choice on a
    // not-yet-live account falls back to COD below instead of opening a Checkout
    // Session that Stripe would reject.
    const canCard =
      !!tenant &&
      this.stripe.isEnabledForAccount(tenant.stripeAccountId) &&
      tenant.stripeChargesEnabled;

    // The delivery cfg is already in the settings we just read — reuse it for both the
    // COD pre-flight and the shipping calc below, so loadDelivery doesn't re-query.
    const cfg = (tenant?.settings as { delivery?: DeliveryConfig } | null)?.delivery ?? null;

    // Pre-flight: an 'online' choice on a farm that can't take cards silently
    // falls back to COD — but only if the farm actually offers COD. Reject here
    // (before booking a slot) rather than recording an order the farm can honour
    // by no payment method. (An explicit COD choice is already validated during
    // intake by assertMethodAllowed, so it's not re-checked here.)
    if (dto.paymentMethod !== 'cod' && !canCard) {
      if (!codEnabled(cfg)) {
        throw new BadRequestException('Плащането с наложен платеж не е налично.');
      }
    }

    // 1. Order intake + shipping folded into the total (cfg reused, no extra read).
    const { order, shipping, grandTotal } = await this.createAndFold(slug, dto, cfg);

    const wantsCod = dto.paymentMethod === 'cod';

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
      // Cash path → final now; send the "received" mail (Stripe orders instead get
      // their mail after payment succeeds).
      void this.orderConfirmation.sendReceived(order.id);
      return { orderId: order.id, checkoutUrl: null };
    }

    // 4. Build line items from the intake snapshot — the exact placed-at price
    //    (which also drives order.total and the webhook under-payment guard).
    const lines: CheckoutLine[] = order.items.map((i) => ({
      productName: i.productName ?? '',
      quantity: i.quantity,
      priceStotinki: i.priceStotinki,
    }));

    // 5. Checkout Session on the connected account. Past the COD/no-card branch
    //    `canCard` held, so `stripeAccountId` is a non-null connected account id.
    const base = this.config.get<string>('STOREFRONT_URL')?.trim() || 'http://localhost:3003';
    const session = await this.stripe.createCheckoutSession({
      stripeAccountId: tenant.stripeAccountId!,
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
    // `undefined` = not supplied (load it); `null`/value = use as-is. Lets the card
    // checkout path pass the delivery cfg it already read instead of re-querying.
    preloadedCfg?: DeliveryConfig | null,
  ): Promise<number> {
    const method = order.deliveryType ?? 'address';
    // Market pickup — the customer collects at the stand, no delivery, no fee.
    if (method === 'pickup') return 0;

    // Per-tenant delivery config (settings.delivery). Absent → legacy defaults.
    const cfg =
      preloadedCfg !== undefined
        ? preloadedCfg
        : order.tenantId
          ? await this.loadDelivery(order.tenantId)
          : null;

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
