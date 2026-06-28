import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { type Database, orders, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { OrdersService } from './orders.service';
import { StripeService, type CheckoutLine } from '../stripe/stripe.service';
import { EcontService } from '../econt/econt.service';
import { SpeedyService } from '../speedy/speedy.service';
import { OrderConfirmationService } from '../order-email/order-confirmation.service';
import { CreateOrderDto } from './dto/create-order.dto';
import {
  localFeeStotinki,
  econtFallbackFee,
  applyFreeThreshold,
  freeThresholdStotinki,
  econtMode,
  speedyEnabled,
  codEnabled,
  carrierPolicy,
  comparisonActive,
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
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly ordersService: OrdersService,
    private readonly stripe: StripeService,
    private readonly econt: EcontService,
    private readonly speedy: SpeedyService,
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
    preloadedTenant?: Parameters<OrdersService['create']>[2],
  ): Promise<{ order: PlacedOrder; subtotal: number; shipping: number; grandTotal: number }> {
    // Order intake — snapshot, row-lock the slot, 409 on overflow, status pending.
    const order = await this.ordersService.create(slug, dto, preloadedTenant);
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
        // Stripe pre-flight fields…
        stripeAccountId: tenants.stripeAccountId,
        stripeChargesEnabled: tenants.stripeChargesEnabled,
        // …plus everything OrdersService.create needs, so intake reuses this one read.
        id: tenants.id,
        farmLat: tenants.farmLat,
        farmLng: tenants.farmLng,
        subscriptionStatus: tenants.subscriptionStatus,
        settings: tenants.settings,
        deliveryEnabled: tenants.deliveryEnabled,
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

    // 1. Order intake + shipping folded into the total (tenant + cfg reused, no re-read).
    const { order, shipping, grandTotal } = await this.createAndFold(slug, dto, cfg, tenant);

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
      id?: string;
      tenantId: string | null;
      deliveryType: 'pickup' | 'address' | 'econt' | 'econt_address' | null;
      /** Chosen carrier for courier methods. Accepted values: 'econt' | 'speedy'. Free-form DB text. */
      carrier?: string | null;
      customerName: string | null;
      customerPhone: string | null;
      econtOffice: string | null;
      deliveryAddress: string | null;
      deliveryCity: string | null;
      /** Payment method — used to determine the COD surcharge for live courier quotes. */
      paymentMethod?: 'online' | 'cod' | null;
      /** Order total in stotinki — passed as the COD amount when paymentMethod is 'cod'. */
      totalStotinki?: number | null;
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

    const door = method === 'econt_address';
    // COD surcharge: applies only when the customer pays cash on delivery. Non-COD
    // orders pass 0 so the carrier quote reflects the bare shipping cost.
    const cod = order.paymentMethod === 'cod' && order.totalStotinki ? order.totalStotinki : 0;

    // 'cheapest' policy — a door order left without a carrier (orders.service defers
    // the pick) is priced on BOTH live carriers here; the cheaper one wins and is
    // persisted so fulfillment dispatches to it. Falls through to the normal path
    // when neither carrier returns a price.
    if (
      door &&
      order.carrier == null &&
      carrierPolicy(cfg) === 'cheapest' &&
      comparisonActive(cfg) &&
      order.tenantId &&
      order.deliveryCity
    ) {
      const picked = await this.pickCheaperDoorCarrier(order, cod);
      if (picked) {
        if (order.id) {
          await this.db.update(orders).set({ carrier: picked.carrier }).where(eq(orders.id, order.id));
        }
        order.carrier = picked.carrier;
        return applyFreeThreshold(picked.fee, subtotal, freeThresholdStotinki(cfg));
      }
    }

    // Speedy door delivery → live Speedy quote (city name → siteId), COD-aware.
    // Falls back to the Econt door flat fee if Speedy is unreachable or returns null.
    let fee: number;
    if (door && order.carrier === 'speedy' && speedyEnabled(cfg) && order.tenantId && order.deliveryCity) {
      fee = (await this.quoteSpeedyDoor(order.tenantId, order.deliveryCity, cod)) ?? econtFallbackFee(cfg, true);
    } else if (econtMode(cfg) === 'auto' && order.tenantId) {
      // Econt automatic mode — live courier quote, fall back to configured flat fee.
      const live = await this.econt.estimateShipping(
        order.tenantId,
        order,
        order.items.map((i) => ({ name: i.productName, qty: i.quantity })),
        undefined,
        cod,
      );
      fee = live ?? econtFallbackFee(cfg, door);
    } else {
      // Econt manual mode (farm ships itself) or Econt off — always flat fee, no API call.
      fee = econtFallbackFee(cfg, door);
    }
    return applyFreeThreshold(fee, subtotal, freeThresholdStotinki(cfg));
  }

  /**
   * Price a door order on BOTH carriers and return the cheaper available one.
   * Each leg degrades to null independently; ties (and a single available carrier)
   * keep Econt-first. Returns null only when neither carrier prices the parcel,
   * letting the caller fall back to the normal single-carrier path.
   */
  private async pickCheaperDoorCarrier(
    order: Parameters<CheckoutService['shippingStotinki']>[0],
    cod: number,
  ): Promise<{ carrier: 'econt' | 'speedy'; fee: number } | null> {
    const [econtFee, speedyFee] = await Promise.all([
      this.econt
        .estimateShipping(
          order.tenantId!,
          order,
          order.items.map((i) => ({ name: i.productName, qty: i.quantity })),
          undefined,
          cod,
        )
        .catch(() => null),
      this.quoteSpeedyDoor(order.tenantId!, order.deliveryCity!, cod),
    ]);
    if (econtFee == null && speedyFee == null) return null;
    if (speedyFee != null && (econtFee == null || speedyFee < econtFee)) {
      return { carrier: 'speedy', fee: speedyFee };
    }
    return { carrier: 'econt', fee: econtFee! };
  }

  /**
   * Live Speedy door quote (city → siteId → estimate), COD-aware.
   * Returns null on any failure — caller falls back to the configured flat fee.
   */
  private async quoteSpeedyDoor(
    tenantId: string,
    deliveryCity: string,
    codAmountStotinki: number,
  ): Promise<number | null> {
    try {
      const sites = await this.speedy.searchSites(tenantId, deliveryCity);
      const siteId = sites[0]?.id;
      if (!siteId) return null;
      return await this.speedy.estimateShipping(tenantId, {
        siteId,
        weightGrams: undefined,
        codAmountStotinki,
      });
    } catch (err) {
      this.logger.warn(
        `[speedy] checkout quote failed for ${tenantId}/${deliveryCity}, using fallback: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
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
