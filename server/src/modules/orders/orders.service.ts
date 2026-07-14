import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, gte, ilike, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  type Database,
  orders,
  orderItems,
  products,
  productVariants,
  productAvailabilityWindows,
  deliverySlots,
  tenants,
  farmers,
  shipments,
  orderFulfillments,
} from '@fermeribg/db';
import type { Product, ProductVariant } from '@fermeribg/types';
import { effectivePriceStotinki } from '../products/promo.util';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { MapsService } from '../../common/maps/maps.service';
import { bgToday, bgDayBounds, bgDate, bgAddDays } from '../../common/time/bg-time';
import { buildKeysetPage, clampLimit, cursorTs, KEYSET_TS } from '../../common/pagination/keyset';
import { decodeCursor } from '../../common/pagination/cursor';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UpdateCodOutcomeDto } from './dto/update-cod-outcome.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { RescheduleOrdersDto } from './dto/reschedule-orders.dto';
import { OrderConfirmationService } from '../order-email/order-confirmation.service';
import { EcontService } from '../econt/econt.service';
import { CarrierFulfillmentService } from './carrier-fulfillment.service';
import { CodRiskService } from '../cod-risk/cod-risk.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { CommissionService } from '../vendor-finance/commission.service';
import { buildPublicMethods, carrierPolicy, codEnabled, courierDoorEnabled, econtMode, speedyEnabled, type DeliveryConfig } from './delivery-pricing';
import { farmerCourierReady, farmerDeliveryNamespace } from './courier-eligibility';
import { scheduledForDay } from './order-scheduling';
import { subtotalStotinki, recomputeTotalStotinki } from './order-total.util';
import { decideDecrement, decideDecrementPooled, restoreRemaining } from '../availability/availability.util';
import { slotIsFull, slotUnavailableReason, migrateRule, ruleProducesDate } from '../slots/slot-rule';

type OrderRow = typeof orders.$inferSelect;
type ItemRow = typeof orderItems.$inferSelect;
type SlotTimes = { slotFrom: string | null; slotTo: string | null; slotDate: string | null };
type OrderWithItems = OrderRow & SlotTimes & { items: ItemRow[] };

/** A drizzle transaction handle (same query surface as the db). */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** One validated, stock-reserved, priced cart line ready to insert as an
 *  order_item — plus the owning farmer (from the product), needed to split a
 *  courier cart per farmer. `farmerId` is stripped before the order_items insert. */
interface PreparedItem {
  productId: string;
  productName: string;
  quantity: number;
  priceStotinki: number;
  variantId: string | null;
  variantLabel: string | null;
  farmerId: string | null;
}

const orderWithSlot = {
  ...getTableColumns(orders),
  slotFrom: deliverySlots.timeFrom,
  slotTo: deliverySlots.timeTo,
  // Delivery day for local-delivery orders (the chosen slot's date) — surfaced so
  // the Orders screen can show "ден + час", not just the time window.
  slotDate: deliverySlots.date,
};

/** One movable order for the "Премести на друг ден" tool (own-delivery orders on a future day). */
export interface ReschedulableOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  totalStotinki: number;
  status: string;
  slotDate: string;
  /** Delivery coordinates (null when the address was never geocoded). */
  deliveryLat: string | null;
  deliveryLng: string | null;
}

export type PaymentStatus = 'paid' | 'pending_online' | 'cash';

/** Admin-facing order shape: raw Stripe ids dropped, payment state derived. */
export type SerializedOrder = Omit<
  OrderWithItems,
  'stripeCheckoutSessionId' | 'stripePaymentIntentId' | 'tenantId'
> & { paymentStatus: PaymentStatus };

/**
 * Map a raw order row to the admin API shape: derive a coarse `paymentStatus`
 * the farmer UI can badge, and drop the raw Stripe identifiers (the client never
 * needs the intent/session ids). `paidAt` flows through (JSON → ISO string).
 */
export function serializeOrder(o: OrderWithItems): SerializedOrder {
  const { stripeCheckoutSessionId, stripePaymentIntentId, tenantId, ...rest } = o;
  const paymentStatus: PaymentStatus = o.paidAt
    ? 'paid'
    : stripeCheckoutSessionId
      ? 'pending_online'
      : 'cash';
  return { ...rest, paymentStatus };
}

/** Order statuses that count as a real «payment» on the Плащания screen:
 *  everything the farmer has confirmed (money in hand, due at delivery, or
 *  paid by card), excluding still-pending and cancelled orders. */
export const PAYMENT_COUNTED_STATUSES = [
  'confirmed',
  'preparing',
  'out_for_delivery',
  'delivered',
] as const;

/** Short TTL for the payments totals/first-page cache. Farmer order writes bust
 *  it immediately; a card payment landing via the Stripe webhook (cross-module,
 *  not busted here) self-heals within this window. */
const PAYMENTS_CACHE_TTL = 60;

/** How the customer chose to pay — наложен платеж (cash on delivery) vs card. */
export type PaymentChannel = 'cod' | 'online';

/** One order as shown on the Плащания screen (both COD and card channels). */
export interface PaymentOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  totalStotinki: number;
  status: string;
  deliveryType: string;
  paymentMethod: PaymentChannel;
  /** Derived: paid (card captured) / pending_online (card unpaid) / cash (COD). */
  paymentStatus: PaymentStatus;
  /** True once the money is in hand — COD delivered, or card paid. */
  collected: boolean;
  /** BG calendar day of delivery (slot day; creation day for slotless orders). */
  day: string;
  createdAt: string | null;
  paidAt: string | null;
  slotFrom: string | null;
  slotTo: string | null;
  /** COD money outcome (null = not yet resolved). */
  codOutcome: 'received' | 'refused' | null;
  /** Free-text reason captured on a manual «refused» mark. */
  codOutcomeReason: string | null;
}

/** Tenant-wide payment totals (every counted order), independent of search/page. */
export interface PaymentTotals {
  /** COD due + card received (minor units, EUR cents). */
  totalStotinki: number;
  count: number;
  /** Total counted orders across both channels — the «Всичко» tab badge. */
  allCount: number;
  /** Наложен платеж: every counted order (money due/collected). */
  codTotalStotinki: number;
  codCount: number;
  /** Card: only paid orders (money actually received). */
  cardTotalStotinki: number;
  cardCount: number;
}

/** One row of the per-channel aggregate that {@link paymentTotals} folds. */
export interface PaymentAggRow {
  paymentMethod: PaymentChannel;
  count: number;
  totalStotinki: number;
  paidCount: number;
  paidTotalStotinki: number;
}

/** A page of the payments list: totals (only on the first page) + rows + cursor. */
export interface PaymentsPage {
  /** Present on the first page (no cursor); null on «load more» fetches. */
  totals: PaymentTotals | null;
  orders: PaymentOrder[];
  /** Opaque keyset cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
}

export type PaymentMethodFilter = 'all' | 'cod';

/** Raw row shape the payments query feeds into {@link buildPaymentsSummary}. */
export interface PaymentRow {
  day: string;
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  totalStotinki: number;
  status: string;
  deliveryType: string;
  paymentMethod: PaymentChannel;
  createdAt: Date | string | null;
  paidAt: Date | string | null;
  slotFrom: string | null;
  slotTo: string | null;
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
}

const toIso = (v: Date | string | null): string | null =>
  v == null ? null : new Date(v).toISOString();

/**
 * Map one DB row to the screen shape, deriving payment status + collected. Pure
 * (no DB) so it's unit-testable. The query already filters to counted statuses
 * and orders by (createdAt, id) desc — the client groups by delivery day.
 */
export function toPaymentOrder(r: PaymentRow): PaymentOrder {
  const paid = r.paidAt != null;
  const paymentStatus: PaymentStatus = paid
    ? 'paid'
    : r.paymentMethod === 'online'
      ? 'pending_online'
      : 'cash';
  return {
    id: r.id,
    orderNumber: r.orderNumber,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    customerEmail: r.customerEmail,
    totalStotinki: r.totalStotinki,
    status: r.status,
    deliveryType: r.deliveryType,
    paymentMethod: r.paymentMethod,
    paymentStatus,
    collected: r.paymentMethod === 'cod' ? r.codOutcome === 'received' : paid,
    day: r.day,
    createdAt: toIso(r.createdAt),
    paidAt: toIso(r.paidAt),
    slotFrom: r.slotFrom,
    slotTo: r.slotTo,
    codOutcome: r.codOutcome,
    codOutcomeReason: r.codOutcomeReason,
  };
}

/** One of the farmer's own product lines on an order. */
export interface FarmerOrderItem {
  productId: string;
  productName: string;
  quantity: number;
  priceStotinki: number;
}

/** Raw shape assembled for one order on the «Моите поръчки» screen, before
 *  mapping to the API shape. `items` holds only THIS farmer's own lines —
 *  a co-producer's lines never appear here, only the `shared` flag notes
 *  that the order also has them. */
export interface FarmerOrderRow {
  day: string;
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  status: string;
  deliveryType: string;
  paymentMethod: PaymentChannel;
  createdAt: Date | string | null;
  slotFrom: string | null;
  slotTo: string | null;
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
  /** True when the order also contains another producer's items — mutation
   *  actions are disabled client-side (and would 403 server-side via the
   *  same ownership gate as updateStatusForFarmer). */
  shared: boolean;
  items: FarmerOrderItem[];
}

/** One order on the «Моите поръчки» screen — every status, unlike Плащания. */
export interface FarmerOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  status: string;
  deliveryType: string;
  paymentMethod: PaymentChannel;
  day: string;
  createdAt: string | null;
  slotFrom: string | null;
  slotTo: string | null;
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
  shared: boolean;
  /** This farmer's own subtotal on the order (their items only). */
  subtotalStotinki: number;
  items: FarmerOrderItem[];
}

export interface FarmerOrdersPage {
  orders: FarmerOrder[];
  nextCursor: string | null;
}

/** Task #14: a farmer's self-tracked prep state for one of tomorrow's orders.
 *  'pending' (default, nothing marked) → 'in_production' → 'fulfilled'. */
export type FulfillmentState = 'pending' | 'in_production' | 'fulfilled';

export interface TomorrowOrderItem {
  productId: string;
  productName: string;
  quantity: number;
}

/** One of tomorrow's orders on the «Утре» panel — this farmer's own items only. */
export interface TomorrowOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  deliveryType: string;
  day: string;
  slotFrom: string | null;
  slotTo: string | null;
  fulfillmentState: FulfillmentState;
  items: TomorrowOrderItem[];
}

/** The «Подготовка» feed for one farmer on one day: per-order rows (the source of
 *  truth for "готово") plus the day's counts. The product view is derived from
 *  `orders` on the frontend. */
export interface PrepSummary {
  date: string;
  confirmedOrders: number;
  pendingOrders: number;
  orders: TomorrowOrder[];
}

/** Map one assembled row to the API shape. Pure (no DB) so it's unit-testable,
 *  mirroring {@link toPaymentOrder}. */
export function toFarmerOrder(r: FarmerOrderRow): FarmerOrder {
  return {
    id: r.id,
    orderNumber: r.orderNumber,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    customerEmail: r.customerEmail,
    status: r.status,
    deliveryType: r.deliveryType,
    paymentMethod: r.paymentMethod,
    day: r.day,
    createdAt: toIso(r.createdAt),
    slotFrom: r.slotFrom,
    slotTo: r.slotTo,
    codOutcome: r.codOutcome,
    codOutcomeReason: r.codOutcomeReason,
    shared: r.shared,
    subtotalStotinki: r.items.reduce((sum, it) => sum + it.quantity * it.priceStotinki, 0),
    items: r.items,
  };
}

/**
 * Fold the per-channel SQL aggregate into screen totals. Pure (no DB). COD counts
 * every due order (rows.count is not filtered — a refused order stays listed on
 * the Плащания screen with its «Отказана» badge); card counts only paid orders
 * (money actually received). Task #8: `rows[].totalStotinki` for the COD channel
 * is now produced by a SUM that already excludes `codOutcome='refused'` rows (see
 * paymentTotalsCached / paymentsForFarmer) — that money was returned at the door
 * and must not inflate the «Общо»/«Наложен платеж» tiles, even though the order's
 * status never left the counted set (only a cancel, not a refusal, flips status).
 */
export function paymentTotals(rows: PaymentAggRow[]): PaymentTotals {
  let codTotalStotinki = 0;
  let codCount = 0;
  let cardTotalStotinki = 0;
  let cardCount = 0;
  let allCount = 0;
  for (const r of rows) {
    allCount += r.count;
    if (r.paymentMethod === 'cod') {
      codTotalStotinki += r.totalStotinki;
      codCount += r.count;
    } else {
      cardTotalStotinki += r.paidTotalStotinki;
      cardCount += r.paidCount;
    }
  }
  return {
    totalStotinki: codTotalStotinki + cardTotalStotinki,
    count: codCount + cardCount,
    allCount,
    codTotalStotinki,
    codCount,
    cardTotalStotinki,
    cardCount,
  };
}

export interface ProductionItem {
  productName: string;
  totalQty: number;
  orderCount: number;
  farmerId: string | null;
  farmerName: string | null;
}

export interface ProductionSummary {
  date: string;
  confirmedOrders: number;
  /** Orders still pending (unconfirmed) for the day — they are NOT in the prep
   *  list yet, so the UI nudges the farmer to confirm them. */
  pendingOrders: number;
  multiFarmer: boolean;
  items: ProductionItem[];
}

/** Safe, public-facing order recap for the storefront confirmation page —
 *  no phone/email/tenant ids; keyed by the order's (unguessable) UUID. */
export interface PublicOrderSummary {
  id: string;
  orderNumber: number | null;
  status: string;
  paidAt: string | null;
  totalStotinki: number;
  deliveryType: 'pickup' | 'address' | 'econt' | 'econt_address' | 'courier';
  econtOffice: string | null;
  slot: { date: string; startTime: string; endTime: string } | null;
  items: { name: string; quantity: number; priceStotinki: number }[];
  createdAt: string | null;
}

/** A product with live variants must be ordered through a variant: a line that
 *  omits `variantId` for such a product would charge the synced base price and
 *  decrement no variant stock (undercharge + stock bypass). True = reject. */
export function requiresVariantSelection(productHasVariants: boolean, variantId?: string): boolean {
  return productHasVariants && !variantId;
}

/** Resolve one order line's unit price + display label, applying the product's
 *  active promo. When a variant is chosen the variant price/label win; otherwise
 *  the product's price and "name + weight" snapshot are used. Pure (now passed in). */
export function resolveLineUnit(
  product: Pick<Product, 'priceStotinki' | 'name' | 'weight' | 'salePercent' | 'saleEndsAt' | 'salePriceStotinki'>,
  variant: Pick<ProductVariant, 'id' | 'label' | 'priceStotinki' | 'salePriceStotinki'> | null,
  now: Date,
): { unitStotinki: number; label: string; variantId: string | null; variantLabel: string | null } {
  const base = variant ? variant.priceStotinki : product.priceStotinki;
  // A fixed promo price wins — a variant's own when a variant is chosen, else the
  // product-level fixed price; otherwise the active % applies. Mirrors
  // buildPublicProduct so the price charged equals the price shown on the storefront.
  const unitStotinki =
    variant && variant.salePriceStotinki != null
      ? variant.salePriceStotinki
      : !variant && product.salePriceStotinki != null
        ? product.salePriceStotinki
        : effectivePriceStotinki(base, product.salePercent, product.saleEndsAt, now);
  return variant
    ? {
        unitStotinki,
        label: [product.name, variant.label].filter(Boolean).join(' '),
        variantId: variant.id,
        variantLabel: variant.label,
      }
    : {
        unitStotinki,
        label: [product.name, product.weight].filter(Boolean).join(' '),
        variantId: null,
        variantLabel: null,
      };
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly maps: MapsService,
    private readonly orderEmail: OrderConfirmationService,
    private readonly econt: EcontService,
    private readonly cache: PublicCacheService,
    private readonly carrierFulfillment: CarrierFulfillmentService,
    private readonly codRisk: CodRiskService,
    private readonly catalogCache: CatalogCacheService,
    // DORMANT commission ledger. @Optional() keeps the existing OrdersService
    // test harnesses valid; in the app the module is always wired.
    @Optional() private readonly commission?: CommissionService,
  ) {}

  /**
   * Reject a delivery/payment method the farm has switched off. The storefront
   * already hides disabled methods; this is the server-side backstop so a crafted
   * request can't place an order through a method the farm doesn't offer (which
   * would otherwise record the order + charge a default fallback fee).
   */
  private assertMethodAllowed(
    settings: unknown,
    deliveryEnabled: boolean,
    deliveriesPackageEnabled: boolean,
    method: 'pickup' | 'address' | 'econt' | 'econt_address' | 'courier',
    paymentMethod: 'online' | 'cod',
  ): void {
    const cfg = (settings as { delivery?: DeliveryConfig } | null)?.delivery ?? null;
    const methods = buildPublicMethods(cfg);
    // Courier (Econt/Speedy) delivery requires the super-admin „пакет Доставки".
    // When the package is off the farm offers ONLY pickup + self-delivery,
    // regardless of its stored carrier config — mirrors the storefront cache gate
    // so a crafted checkout can't bypass the entitlement and create a courier order.
    const courierOk = deliveriesPackageEnabled;
    const allowed: Record<string, boolean> = {
      pickup: methods.pickup,
      // Self-delivery availability is the SAME signal the storefront gates on:
      // `deliveryEnabled` (the slot picker master switch) AND the ownSlots method
      // flag. A farm with deliveryEnabled=false offers no local delivery even if
      // ownSlots defaults on.
      address: deliveryEnabled && methods.ownSlots,
      econt: courierOk && methods.econtOffice,
      // Door delivery is allowed when Econt address is on OR Speedy is configured.
      econt_address: courierOk && courierDoorEnabled(cfg),
      // Per-farmer courier is NEVER a single-order intake method: it must split the
      // cart into one COD order per farmer via createCourierOrders. Reject it here so
      // a courier POST to the single-order path can't create an unsplit order (no
      // farmer_id, folded fee). CheckoutService routes delivery_type='courier' to the
      // split path before intake is ever reached.
      courier: false,
    };
    if (!allowed[method]) {
      throw new BadRequestException('Избраният начин на доставка не е наличен.');
    }
    if (paymentMethod === 'cod' && !codEnabled(cfg)) {
      throw new BadRequestException('Плащането с наложен платеж не е налично.');
    }
  }

  /**
   * Admin list: tenant-scoped, newest first, keyset-paginated, items batched
   * (no N+1). Status/search filtering is client-side over accumulated pages, so
   * the server only paginates (no per-request filters here).
   */
  /**
   * One numbered page of the Поръчки screen. The panel renders a numbered footer and
   * searches/filters over the whole order set, so this paginates by page number
   * (offset) with a total count — instead of the keyset «load more» used elsewhere —
   * and pushes the status filter + free-text search into SQL (was: the client drained
   * every page on mount and filtered in memory). Newest-first (createdAt, id).
   */
  async findAll(
    tenantId: string,
    opts: {
      page?: number;
      limit?: number;
      status?: 'pending' | 'confirmed' | 'delivered' | 'cancelled';
      q?: string;
      /** Delivery-day filter (YYYY-MM-DD); scopes via `scheduledForDay`. Omit = all days. */
      date?: string;
    } = {},
  ): Promise<{ items: SerializedOrder[]; total: number }> {
    const lim = clampLimit(opts.limit);
    const page = opts.page && opts.page > 0 ? Math.floor(opts.page) : 1;
    const offset = (page - 1) * lim;
    const q = (opts.q ?? '').trim();
    const conds = [eq(orders.tenantId, tenantId)];

    // Subscription gating: an inactive tenant only sees the last 7 days of orders.
    const [t] = await this.db
      .select({ status: tenants.subscriptionStatus })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (t?.status === 'inactive') {
      conds.push(sql`${orders.createdAt} >= now() - interval '7 days'`);
    }

    if (opts.status) conds.push(eq(orders.status, opts.status));
    if (q) conds.push(this.paymentSearchCond(q));
    // Optional delivery-day scope — slot day, creation-day fallback for slotless
    // orders (same rule as production / payments / digests). References
    // deliverySlots.date, so both queries below must carry the slots leftJoin.
    if (opts.date) conds.push(scheduledForDay(opts.date));
    const where = and(...conds)!;

    // Count + page run concurrently. The count drives the numbered footer; both share
    // the same predicate, served by the (tenant_id, status) / (tenant_id, created_at) idx.
    const [countRow, rows] = await Promise.all([
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(orders)
        .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
        .where(where),
      this.db
        .select(orderWithSlot)
        .from(orders)
        .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
        .where(where)
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(lim)
        .offset(offset),
    ]);

    const items = (await this.attachItems(rows)).map(serializeOrder);
    return { items, total: countRow[0]?.n ?? 0 };
  }

  /**
   * One page of the farmer's Плащания screen: confirmed-and-beyond orders across
   * both channels (наложен платеж + card), tagged with the delivery day (slot day;
   * creation day for slotless orders — same rule as production / digests) and the
   * customer's contact details. Keyset-paginated newest-first (createdAt, id),
   * optional method filter (Всичко / наложен платеж) and free-text search over
   * name / phone / email / order number.
   *
   * Tenant-wide totals come back only on the first page (no cursor) — «load more»
   * fetches reuse them. The first, unfiltered page of each method plus the totals
   * are Redis-cached (short TTL, busted on order writes); searched and deeper
   * pages always hit Postgres (bounded by the page LIMIT + tenant/status index).
   */
  async payments(
    tenantId: string,
    opts: { method?: PaymentMethodFilter; q?: string; cursor?: string; limit?: number } = {},
  ): Promise<PaymentsPage> {
    const method: PaymentMethodFilter = opts.method === 'cod' ? 'cod' : 'all';
    const q = (opts.q ?? '').trim();
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;

    // Totals are global (ignore search/page) — only fetched for the first page.
    const totals = cur ? null : await this.paymentTotalsCached(tenantId);

    // The first, unfiltered, default-size page of a method is the hot path → cache
    // it. A custom limit (or search / cursor) bypasses the cache so its key never
    // has to encode the page size.
    const listCacheable = !q && !cur && opts.limit == null;
    const listKey = `payments:list:${tenantId}:${method}`;
    if (listCacheable) {
      const hit = await this.cache.get<Omit<PaymentsPage, 'totals'>>(listKey);
      if (hit) return { totals, ...hit };
    }

    const conds = [
      eq(orders.tenantId, tenantId),
      inArray(orders.status, [...PAYMENT_COUNTED_STATUSES]),
    ];
    if (method === 'cod') conds.push(eq(orders.paymentMethod, 'cod'));
    if (q) conds.push(this.paymentSearchCond(q));
    if (cur) {
      // Keyset «older than cursor». `orders.created_at` is `timestamp` (no tz), so
      // binding a JS Date would let Postgres tz-shift the param vs the naive column
      // (breaking the boundary when the DB session tz isn't UTC). The cursor's
      // timestamp is already a micro-precision, tz-naive string (see cursorTs);
      // cast it to a naive `timestamp` + the id to `uuid` so the row-value compare
      // matches the column types exactly.
      conds.push(
        sql`(${orders.createdAt}, ${orders.id}) < (${cur.createdAt}::timestamp, ${cur.id}::uuid)`,
      );
    }

    // Delivery day: the slot's date, falling back to the BG-local creation date.
    const day = sql<string>`coalesce(${deliverySlots.date}, ${bgDate(orders.createdAt)})`;
    const rows = await this.db
      .select({
        day,
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        customerEmail: orders.customerEmail,
        totalStotinki: orders.totalStotinki,
        status: orders.status,
        deliveryType: orders.deliveryType,
        paymentMethod: orders.paymentMethod,
        createdAt: orders.createdAt,
        paidAt: orders.paidAt,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
        codOutcome: orders.codOutcome,
        codOutcomeReason: orders.codOutcomeReason,
        // Micro-precision boundary for the cursor; stripped by buildKeysetPage.
        [KEYSET_TS]: cursorTs(orders.createdAt),
      })
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(and(...conds)!)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(lim + 1);

    const { items, nextCursor } = buildKeysetPage(
      rows as Array<PaymentRow & { [KEYSET_TS]: string }>,
      lim,
    );
    const listPart = { orders: items.map(toPaymentOrder), nextCursor };
    if (listCacheable) await this.cache.set(listKey, listPart, PAYMENTS_CACHE_TTL);
    return { totals, ...listPart };
  }

  /**
   * Producer-scoped Плащания: the same {@link PaymentsPage} shape as
   * {@link payments}, but every order's money is the producer's OWN line-item
   * subtotal (sum of their items' qty × price on that order), NOT the full order
   * total. Mirrors `statsForFarmer`'s line-item attribution: source the list from
   * `orderItems ⋈ orders ⋈ products` and keep only items whose product belongs to
   * `farmerId`. An order containing two of the producer's items appears ONCE
   * (GROUP BY orders.id) and is counted once in the totals (distinct orders.id).
   *
   * NOT cached — producers are low-traffic, and skipping the cache avoids new bust
   * keys (one per farmer × method) plus the risk of a stale producer view. The
   * owner path keeps its short-TTL cache.
   */
  async paymentsForFarmer(
    tenantId: string,
    farmerId: string,
    opts: { method?: PaymentMethodFilter; q?: string; cursor?: string; limit?: number } = {},
  ): Promise<PaymentsPage> {
    const method: PaymentMethodFilter = opts.method === 'cod' ? 'cod' : 'all';
    const q = (opts.q ?? '').trim();
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;

    // This producer's line revenue on each order (minor units, EUR cents).
    const lineRev = sql<number>`sum(${orderItems.quantity} * ${orderItems.priceStotinki})::int`;

    const conds = [
      eq(orders.tenantId, tenantId),
      eq(products.farmerId, farmerId),
      inArray(orders.status, [...PAYMENT_COUNTED_STATUSES]),
    ];
    if (method === 'cod') conds.push(eq(orders.paymentMethod, 'cod'));
    if (q) conds.push(this.paymentSearchCond(q));
    if (cur) {
      // Same naive-timestamp + uuid cast as the owner method — keyset «older than
      // cursor» on (created_at, id), tz-agnostic regardless of the PG session tz.
      // cur.createdAt is the micro-precision string from cursorTs (see owner method).
      conds.push(
        sql`(${orders.createdAt}, ${orders.id}) < (${cur.createdAt}::timestamp, ${cur.id}::uuid)`,
      );
    }

    // Delivery day: the slot's date, falling back to the BG-local creation date.
    const day = sql<string>`coalesce(${deliverySlots.date}, ${bgDate(orders.createdAt)})`;
    const rows = await this.db
      .select({
        day,
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        customerEmail: orders.customerEmail,
        // Producer subtotal — the sum of THIS farmer's line items on the order,
        // not orders.totalStotinki (which includes other producers + delivery fee).
        totalStotinki: lineRev,
        status: orders.status,
        deliveryType: orders.deliveryType,
        paymentMethod: orders.paymentMethod,
        createdAt: orders.createdAt,
        paidAt: orders.paidAt,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
        codOutcome: orders.codOutcome,
        codOutcomeReason: orders.codOutcomeReason,
        // Micro-precision boundary for the cursor; stripped by buildKeysetPage.
        // to_char(orders.createdAt) is functionally dependent on the grouped
        // orders.createdAt below, so it needs no separate GROUP BY entry.
        [KEYSET_TS]: cursorTs(orders.createdAt),
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(and(...conds)!)
      // One row per order (each of the producer's items folds into the subtotal).
      // The non-aggregated selected columns are all functionally dependent on
      // orders.id, so they go in the GROUP BY alongside it.
      .groupBy(
        orders.id,
        orders.orderNumber,
        orders.customerName,
        orders.customerPhone,
        orders.customerEmail,
        orders.status,
        orders.deliveryType,
        orders.paymentMethod,
        orders.createdAt,
        orders.paidAt,
        orders.codOutcome,
        orders.codOutcomeReason,
        deliverySlots.date,
        deliverySlots.timeFrom,
        deliverySlots.timeTo,
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(lim + 1);

    const { items, nextCursor } = buildKeysetPage(
      rows as Array<PaymentRow & { [KEYSET_TS]: string }>,
      lim,
    );

    // Totals: same line-item join, grouped by channel. count(distinct orders.id) so
    // a single order with two of the producer's items counts once; the card paid
    // split filters on orders.paidAt (money actually received). Not cached.
    // Totals are global (ignore search/page) — only computed on the first page; a
    // «load more» fetch (cur set) would otherwise run this full-history aggregate
    // and then discard the result unused.
    // Task #8 fix: exclude refused COD money from the sum (mirrors
    // paymentTotalsCached above) — a refused наложен платеж order stays in a
    // counted status (only a cancel, not a refusal, flips status), so it must
    // not keep inflating this producer's due/collected total.
    // (Same test-DB-harness caveat as paymentTotalsCached above: this FILTER's
    // DB-level behaviour is not exercised by a spec here.)
    const aggRows = cur
      ? []
      : await this.db
          .select({
            paymentMethod: orders.paymentMethod,
            count: sql<number>`count(distinct ${orders.id})::int`,
            totalStotinki: sql<number>`coalesce(sum(${orderItems.quantity} * ${orderItems.priceStotinki}) filter (where ${orders.codOutcome} is distinct from 'refused'), 0)::int`,
            paidCount: sql<number>`count(distinct ${orders.id}) filter (where ${orders.paidAt} is not null)::int`,
            paidTotalStotinki: sql<number>`coalesce(sum(${orderItems.quantity} * ${orderItems.priceStotinki}) filter (where ${orders.paidAt} is not null), 0)::int`,
          })
          .from(orderItems)
          .innerJoin(orders, eq(orders.id, orderItems.orderId))
          .innerJoin(products, eq(products.id, orderItems.productId))
          .where(
            and(
              eq(orders.tenantId, tenantId),
              eq(products.farmerId, farmerId),
              inArray(orders.status, [...PAYMENT_COUNTED_STATUSES]),
            ),
          )
          .groupBy(orders.paymentMethod);
    const totals = cur ? null : paymentTotals(aggRows as PaymentAggRow[]);

    return { totals, orders: items.map(toPaymentOrder), nextCursor };
  }

  /**
   * Every order containing at least one of this farmer's own products, across
   * ALL statuses (pending/cancelled included) — the «Моите поръчки» screen's
   * data source. Unlike {@link paymentsForFarmer} this is a fulfillment view,
   * not a money view: it carries per-item detail (not just a subtotal) and a
   * `shared` flag for orders that also have another producer's items, so the
   * client can explain why the mark-delivered/cod-outcome actions are hidden
   * instead of the caller hitting a silent 403 from updateStatusForFarmer.
   */
  async ordersForFarmer(
    tenantId: string,
    farmerId: string,
    opts: {
      status?: 'pending' | 'confirmed' | 'preparing' | 'out_for_delivery' | 'delivered' | 'cancelled';
      q?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<FarmerOrdersPage> {
    const q = (opts.q ?? '').trim();
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;

    const conds = [eq(orders.tenantId, tenantId), eq(products.farmerId, farmerId)];
    if (opts.status) conds.push(eq(orders.status, opts.status));
    if (q) conds.push(this.paymentSearchCond(q));
    if (cur) {
      conds.push(
        sql`(${orders.createdAt}, ${orders.id}) < (${cur.createdAt}::timestamp, ${cur.id}::uuid)`,
      );
    }

    // True when the order also has a line item belonging to a DIFFERENT farmer.
    const shared = sql<boolean>`exists (
      select 1 from ${orderItems} oi2
      inner join ${products} p2 on p2.id = oi2.product_id
      where oi2.order_id = ${orders.id} and p2.farmer_id is distinct from ${farmerId}
    )`;

    const day = sql<string>`coalesce(${deliverySlots.date}, ${bgDate(orders.createdAt)})`;
    const rows = await this.db
      .select({
        day,
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        customerEmail: orders.customerEmail,
        status: orders.status,
        deliveryType: orders.deliveryType,
        paymentMethod: orders.paymentMethod,
        createdAt: orders.createdAt,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
        codOutcome: orders.codOutcome,
        codOutcomeReason: orders.codOutcomeReason,
        shared,
        [KEYSET_TS]: cursorTs(orders.createdAt),
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(and(...conds)!)
      .groupBy(
        orders.id,
        orders.orderNumber,
        orders.customerName,
        orders.customerPhone,
        orders.customerEmail,
        orders.status,
        orders.deliveryType,
        orders.paymentMethod,
        orders.createdAt,
        orders.codOutcome,
        orders.codOutcomeReason,
        deliverySlots.date,
        deliverySlots.timeFrom,
        deliverySlots.timeTo,
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(lim + 1);

    const { items: pageRows, nextCursor } = buildKeysetPage(
      rows as Array<Omit<FarmerOrderRow, 'items'> & { [KEYSET_TS]: string }>,
      lim,
    );
    if (pageRows.length === 0) return { orders: [], nextCursor };

    const orderIds = pageRows.map((r) => r.id);
    const itemRows = await this.db
      .select({
        orderId: orderItems.orderId,
        productId: orderItems.productId,
        productName: products.name,
        quantity: orderItems.quantity,
        priceStotinki: orderItems.priceStotinki,
      })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(inArray(orderItems.orderId, orderIds), eq(products.farmerId, farmerId)));

    const itemsByOrder = new Map<string, FarmerOrderItem[]>();
    for (const it of itemRows as Array<{
      orderId: string;
      productId: string;
      productName: string;
      quantity: number;
      priceStotinki: number;
    }>) {
      const list = itemsByOrder.get(it.orderId) ?? [];
      list.push({
        productId: it.productId,
        productName: it.productName,
        quantity: it.quantity,
        priceStotinki: it.priceStotinki,
      });
      itemsByOrder.set(it.orderId, list);
    }

    const fullRows: FarmerOrderRow[] = pageRows.map((r) => ({
      ...r,
      items: itemsByOrder.get(r.id) ?? [],
    }));

    return { orders: fullRows.map(toFarmerOrder), nextCursor };
  }

  /** «Подготовка» feed for one farmer on one day. Orders are the source of truth
   *  for prep progress; the product view aggregates them client-side. `date`
   *  defaults to tomorrow (the main prep horizon). */
  async prepSummary(tenantId: string, farmerId: string, date?: string): Promise<PrepSummary> {
    const day = date ?? bgAddDays(bgToday(), 1);
    const [orders, pendingOrders] = await Promise.all([
      this.prepOrders(tenantId, farmerId, day),
      this.pendingCountForFarmer(tenantId, farmerId, day),
    ]);
    return { date: day, confirmedOrders: orders.length, pendingOrders, orders };
  }

  /**
   * Task #14: one day's confirmed orders containing this farmer's own
   * products, with each order's self-tracked fulfilment state
   * (order_fulfillments; no row yet ⇒ 'pending') and the customer's contact —
   * so the farmer's «Подготовка» panel shows exactly whom to call about a gap.
   * Mirrors ordersForFarmer's per-farmer item attribution: this farmer's own
   * lines only — a co-producer's lines on a shared order never appear here.
   * `date` defaults to tomorrow (the main prep horizon).
   */
  async prepOrders(tenantId: string, farmerId: string, date?: string): Promise<TomorrowOrder[]> {
    const targetDay = date ?? bgAddDays(bgToday(), 1);
    const day = sql<string>`coalesce(${deliverySlots.date}, ${bgDate(orders.createdAt)})`;
    const rows = await this.db
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        customerEmail: orders.customerEmail,
        deliveryType: orders.deliveryType,
        day,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
        state: orderFulfillments.state,
        productId: orderItems.productId,
        productName: products.name,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .leftJoin(
        orderFulfillments,
        and(eq(orderFulfillments.orderId, orders.id), eq(orderFulfillments.farmerId, farmerId)),
      )
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'confirmed'),
          eq(products.farmerId, farmerId),
          scheduledForDay(targetDay),
        )!,
      )
      .orderBy(orders.createdAt);

    const byOrder = new Map<string, TomorrowOrder>();
    for (const r of rows as Array<{
      orderId: string;
      orderNumber: number | null;
      customerName: string | null;
      customerPhone: string | null;
      customerEmail: string | null;
      deliveryType: string;
      day: string;
      slotFrom: string | null;
      slotTo: string | null;
      state: FulfillmentState | null;
      productId: string | null;
      productName: string | null;
      quantity: number;
    }>) {
      let o = byOrder.get(r.orderId);
      if (!o) {
        o = {
          id: r.orderId,
          orderNumber: r.orderNumber,
          customerName: r.customerName,
          customerPhone: r.customerPhone,
          customerEmail: r.customerEmail,
          deliveryType: r.deliveryType,
          day: r.day,
          slotFrom: r.slotFrom,
          slotTo: r.slotTo,
          fulfillmentState: r.state ?? 'pending',
          items: [],
        };
        byOrder.set(r.orderId, o);
      }
      if (r.productId) {
        o.items.push({ productId: r.productId, productName: r.productName ?? '—', quantity: r.quantity });
      }
    }
    return [...byOrder.values()];
  }

  /** Pending (unconfirmed) orders on `day` that contain this farmer's items — they
   *  aren't in the prep feed yet, so the UI nudges the farmer to confirm them.
   *  Needs the deliverySlots leftJoin for scheduledForDay. */
  private async pendingCountForFarmer(
    tenantId: string,
    farmerId: string,
    day: string,
  ): Promise<number> {
    const [{ pending }] = await this.db
      .select({ pending: sql<number>`count(distinct ${orders.id})::int` })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'pending'),
          eq(products.farmerId, farmerId),
          scheduledForDay(day),
        )!,
      );
    return pending ?? 0;
  }

  /**
   * Task #14: set this farmer's self-tracked fulfilment state for one of
   * tomorrow's orders. Upsert on (order_id, farmer_id) — a re-mark updates in
   * place. Ownership check requires only that AT LEAST ONE line item on the
   * order belongs to this farmer (unlike updateStatusForFarmer/
   * setCodOutcomeForFarmer, which require the WHOLE order be the farmer's own)
   * — fulfilment state carries no money/status side-effect, so on a shared
   * order each producer safely marks their own slice independently via their
   * own order_fulfillments row.
   */
  async setFulfillment(
    orderId: string,
    tenantId: string,
    farmerId: string,
    state: FulfillmentState,
  ): Promise<{ orderId: string; farmerId: string; state: FulfillmentState }> {
    const [owns] = await this.db
      .select({ id: orderItems.id, status: orders.status })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(
        and(eq(orders.id, orderId), eq(orders.tenantId, tenantId), eq(products.farmerId, farmerId)),
      )
      .limit(1);
    if (!owns) throw new ForbiddenException('Нямате достъп до тази поръчка.');
    if (!PAYMENT_COUNTED_STATUSES.includes(owns.status as (typeof PAYMENT_COUNTED_STATUSES)[number])) {
      throw new BadRequestException('Поръчката вече не е активна.');
    }

    await this.db
      .insert(orderFulfillments)
      .values({ tenantId, orderId, farmerId, state })
      .onConflictDoUpdate({
        target: [orderFulfillments.orderId, orderFulfillments.farmerId],
        set: { state, updatedAt: new Date() },
      });
    return { orderId, farmerId, state };
  }

  /** Tenant-wide payment totals, Redis-cached (busted on order writes).
   *
   * Task #8 fix: a COD order the customer REFUSED at the door
   * (`codOutcome='refused'`) never leaves its counted status (it stays
   * confirmed/delivered — only a cancel flips status, and a refusal is not a
   * cancel), so it was still being summed into `totalStotinki` as money
   * due/collected even though that money will never arrive. `totalStotinki`
   * now excludes refused COD rows from the SUM (they stay in `count` — the
   * row is still listed on the Плащания screen with its «Отказана» badge,
   * it just contributes 0 to the money tiles). `codOutcome` is only ever set
   * on `payment_method='cod'` rows (see setCodOutcome's method guard), so
   * `IS DISTINCT FROM 'refused'` is a no-op for the online group.
   * (No test-DB harness exists in this repo, so this FILTER's actual exclusion
   * behaviour at the DB level isn't exercised by a spec — see orders.payments.
   * spec.ts's header note. The JS-side fold that consumes this aggregate IS
   * covered there.) */
  private async paymentTotalsCached(tenantId: string): Promise<PaymentTotals> {
    const key = `payments:totals:${tenantId}`;
    const hit = await this.cache.get<PaymentTotals>(key);
    if (hit) return hit;
    const aggRows = await this.db
      .select({
        paymentMethod: orders.paymentMethod,
        count: sql<number>`count(*)::int`,
        totalStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.codOutcome} is distinct from 'refused'), 0)::int`,
        paidCount: sql<number>`count(*) filter (where ${orders.paidAt} is not null)::int`,
        paidTotalStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.paidAt} is not null), 0)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.status, [...PAYMENT_COUNTED_STATUSES]),
        ),
      )
      .groupBy(orders.paymentMethod);
    const totals = paymentTotals(aggRows as PaymentAggRow[]);
    await this.cache.set(key, totals, PAYMENTS_CACHE_TTL);
    return totals;
  }

  /** Free-text WHERE over name / email / phone (digits) / order number. */
  private paymentSearchCond(q: string): SQL {
    const like = `%${q}%`;
    const digits = q.replace(/\D/g, '');
    const ors: (SQL | undefined)[] = [
      ilike(orders.customerName, like),
      ilike(orders.customerEmail, like),
    ];
    if (digits) {
      ors.push(
        sql`regexp_replace(coalesce(${orders.customerPhone}, ''), '[^0-9]', '', 'g') like ${`%${digits}%`}`,
      );
      const n = Number(digits);
      if (Number.isSafeInteger(n) && n > 0) ors.push(eq(orders.orderNumber, n));
    }
    return or(...ors)!;
  }

  /** Drop the cached payment totals + first pages for a tenant after an order write. */
  private async bustPayments(tenantId: string): Promise<void> {
    await this.cache.del(
      `payments:totals:${tenantId}`,
      `payments:list:${tenantId}:all`,
      `payments:list:${tenantId}:cod`,
    );
  }

  async findOne(id: string, tenantId: string): Promise<SerializedOrder> {
    const [row] = await this.db
      .select(orderWithSlot)
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Поръчката не е намерена');
    const [withItems] = await this.attachItems([row]);
    return serializeOrder(withItems);
  }

  /**
   * Owner-side full order edit. Sets whatever scalar fields the patch carries
   * (re-geocoding a changed address), reassigns the slot with a one-per-slot
   * capacity check, and (Task 3) replaces the line items. Rejects on closed
   * orders and on item edits of a card-paid order. Returns the serialized order.
   */
  async updateOrder(id: string, tenantId: string, dto: UpdateOrderDto): Promise<SerializedOrder> {
    const [current] = await this.db
      .select(orderWithSlot)
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!current) throw new NotFoundException('Поръчката не е намерена');

    // Guard: once money is collected the item total (and the commission accrual
    // snapshotted at collection) is fixed — no item changes. Card: paidAt is set.
    // COD: outcome 'received' is the collected-money signal that accrues commission
    // (it never sets paidAt); editing items after it would recompute the total but
    // leave the accrual's gross snapshot stale (accrueForOrder is onConflictDoNothing).
    if (dto.items && (current.paidAt || current.codOutcome === 'received')) {
      throw new BadRequestException(
        'Поръчка с прибрано плащане — артикулите не могат да се променят.',
      );
    }

    // Geocode a changed address OUTSIDE the transaction (no network under a lock).
    // Local delivery needs coords for the route; Econt-door/courier need a city.
    const geocodes = current.deliveryType === 'address';
    const needsCity = current.deliveryType === 'econt_address' || current.deliveryType === 'courier';
    const addressChanged =
      dto.deliveryAddress !== undefined && dto.deliveryAddress !== current.deliveryAddress;
    let newLat: string | null | undefined;
    let newLng: string | null | undefined;
    let newCity: string | null | undefined;
    if (addressChanged && (geocodes || needsCity)) {
      if (dto.deliveryAddress) {
        const [tenant] = await this.db
          .select({ farmLat: tenants.farmLat, farmLng: tenants.farmLng })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);
        const fLat = tenant?.farmLat == null ? null : Number(tenant.farmLat);
        const fLng = tenant?.farmLng == null ? null : Number(tenant.farmLng);
        const bias = fLat != null && fLng != null ? { lat: fLat, lng: fLng } : undefined;
        if (geocodes) {
          // Geocode lookup attempted — a miss (or Maps disabled) must clear the
          // OLD pin, never silently leave it standing under the NEW address text.
          const geo = await this.maps.geocode(dto.deliveryAddress, bias);
          newLat = geo ? String(geo.lat) : null;
          newLng = geo ? String(geo.lng) : null;
        } else {
          newCity = (await this.maps.geocodeCity(dto.deliveryAddress, bias)) ?? null;
        }
      } else {
        // Address cleared — the OLD coordinates/city must not survive an emptied address.
        if (geocodes) {
          newLat = null;
          newLng = null;
        }
        if (needsCity) newCity = null;
      }
    }

    let variantStockTouched = false;
    await this.db.transaction(async (tx) => {
      // Slot reassign — only when slotId is present in the patch and differs.
      if (dto.slotId !== undefined && dto.slotId !== current.slotId && dto.slotId !== null) {
        await this.lockAndCheckSlot(tx, tenantId, dto.slotId, id);
      }

      // Scalar fields: only those present in the patch.
      const set: Partial<typeof orders.$inferInsert> = {};
      if (dto.customerName !== undefined) set.customerName = dto.customerName;
      if (dto.customerPhone !== undefined) set.customerPhone = dto.customerPhone;
      if (dto.customerEmail !== undefined) set.customerEmail = dto.customerEmail;
      if (dto.deliveryAddress !== undefined) set.deliveryAddress = dto.deliveryAddress;
      if (dto.deliveryNote !== undefined) set.deliveryNote = dto.deliveryNote;
      if (dto.econtOffice !== undefined) set.econtOffice = dto.econtOffice;
      if (dto.notes !== undefined) set.notes = dto.notes;
      if (dto.slotId !== undefined && dto.slotId !== current.slotId) set.slotId = dto.slotId;
      if (newLat !== undefined) set.deliveryLat = newLat;
      if (newLng !== undefined) set.deliveryLng = newLng;
      if (newCity !== undefined) set.deliveryCity = newCity;

      // Items replacement — restore old stock, re-reserve new, swap rows, recompute
      // total (preserving the folded-in delivery fee). Slot is handled above, so we
      // pass slotId=null to reserveCartItems (its slot block is skipped for null).
      if (dto.items) {
        const oldItems = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));

        // Grandfather lines that are UNCHANGED (same product+variant+quantity as
        // before) AND whose product has since gone inactive/deleted. Without this,
        // one discontinued product sitting untouched in the cart blocks the WHOLE
        // edit — reserveCartItems below re-validates + re-reserves every line on
        // every items patch, active or not. Active-product lines are entirely
        // unaffected: they still flow through the full release+reserve+re-price
        // pass exactly as before, so nothing changes for the common case.
        const dtoProductIds = [...new Set(dto.items.map((i) => i.productId))];
        const dtoProds = dtoProductIds.length
          ? await tx.select().from(products).where(and(eq(products.tenantId, tenantId), inArray(products.id, dtoProductIds)))
          : [];
        const dtoById = new Map(dtoProds.map((p) => [p.id, p]));
        const itemKey = (o: { productId: string | null; variantId: string | null; quantity: number }) =>
          `${o.productId ?? ''}:${o.variantId ?? ''}:${o.quantity}`;
        const oldByKey = new Map(oldItems.map((o) => [itemKey(o), o]));

        const grandfathered: typeof oldItems = [];
        const toSubmit: typeof dto.items = [];
        for (const it of dto.items) {
          const p = dtoById.get(it.productId);
          const existing = oldByKey.get(itemKey({ productId: it.productId, variantId: it.variantId ?? null, quantity: it.quantity }));
          if (existing && (!p || !p.isActive)) {
            grandfathered.push(existing);
          } else {
            toSubmit.push(it);
          }
        }
        const grandfatheredIds = new Set(grandfathered.map((o) => o.id));
        const releasedItems = oldItems.filter((o) => !grandfatheredIds.has(o.id));

        await this.restoreAvailabilityWindows(tx, tenantId, releasedItems);
        const oldTouched = await this.restoreVariantStock(tx, releasedItems);

        const carrierDelivery =
          current.deliveryType === 'econt' ||
          current.deliveryType === 'econt_address' ||
          current.deliveryType === 'courier';
        const { items: prepared, variantStockTouched: newTouched } = toSubmit.length
          ? await this.reserveCartItems(tx, tenantId, toSubmit, null, carrierDelivery)
          : { items: [] as PreparedItem[], variantStockTouched: false };
        variantStockTouched = oldTouched || newTouched;
        const newLines = prepared.map(({ farmerId: _f, ...line }) => line);
        // Kept rows are re-inserted verbatim (their locked-in price/name/variant
        // snapshot untouched) — only `id`/`orderId` are dropped since every edit
        // already deletes + re-inserts the whole order_items set (fresh ids).
        const keptLines = grandfathered.map(({ id: _id, orderId: _oid, ...line }) => line);

        await tx.delete(orderItems).where(eq(orderItems.orderId, id));
        await tx.insert(orderItems).values([...keptLines, ...newLines].map((l) => ({ ...l, orderId: id })));

        const prevSubtotal = subtotalStotinki(oldItems);
        const newSubtotal = subtotalStotinki(grandfathered) + subtotalStotinki(prepared);
        set.totalStotinki = recomputeTotalStotinki(current.totalStotinki, prevSubtotal, newSubtotal);
      }

      if (Object.keys(set).length > 0) {
        await tx.update(orders).set(set).where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)));
      }
    });

    await this.bustPayments(tenantId);
    // Cached public catalog bakes soldOut from variant stock — a variant crossing
    // to/from 0 here would otherwise show wrong for up to the catalog TTL.
    if (variantStockTouched) await this.catalogCache.invalidate(tenantId);
    return this.findOne(id, tenantId);
  }

  /**
   * Own-delivery orders that can be moved: address delivery, still live
   * (pending/confirmed) — including ones stuck on a PAST slot date (never
   * fulfilled), so they can be caught up onto a future day. The client
   * groups these by `slotDate` into the source-day picker + checkbox list.
   */
  async reschedulable(tenantId: string): Promise<ReschedulableOrder[]> {
    const rows = await this.db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        totalStotinki: orders.totalStotinki,
        status: orders.status,
        slotDate: deliverySlots.date,
        deliveryLat: orders.deliveryLat,
        deliveryLng: orders.deliveryLng,
      })
      .from(orders)
      .innerJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.deliveryType, 'address'),
          inArray(orders.status, ['pending', 'confirmed']),
        ),
      )
      .orderBy(deliverySlots.date, orders.orderNumber);
    return rows as ReschedulableOrder[];
  }

  /**
   * Bulk-move own-delivery orders onto `toDate`. Finds-or-creates the target-day
   * slot; a freshly created one is `isActive=false` so it never surfaces on the
   * storefront picker (the farmer sees it; shoppers don't). Deliberately skips the
   * capacity + same-day guards that `lockAndCheckSlot` enforces — the farmer is
   * intentionally loading their own day. Emails each moved order's buyer.
   */
  async rescheduleOrders(
    tenantId: string,
    dto: RescheduleOrdersDto,
  ): Promise<{ moved: number; toDate: string }> {
    const { orderIds, toDate } = dto;
    if (toDate < bgToday()) {
      throw new BadRequestException('Не може да преместиш поръчки в минал ден.');
    }

    const moved: { id: string; fromDate: string | null }[] = [];
    let targetSlotId: string | undefined;
    await this.db.transaction(async (tx) => {
      // Serialize concurrent reschedules targeting the same (tenant, date) — a
      // SELECT...FOR UPDATE below can't lock a target-slot row that doesn't exist
      // yet, so two concurrent calls creating the SAME new day would otherwise both
      // insert a duplicate delivery_slots row (there's no unique DB constraint on
      // (tenant_id, date) to fall back on). Salt 1 keeps this in its own lock
      // namespace, separate from the per-tenant order-number lock (salt 0) above.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ${toDate}, 1))`);

      // Read the candidate rows INSIDE the transaction (after the advisory lock) so
      // the movable-order snapshot can't go stale between the read and the UPDATE
      // below — e.g. a concurrent cancel changing status after an outside-tx read
      // would otherwise silently re-slot a no-longer-movable order.
      const rows = await tx
        .select({
          id: orders.id,
          status: orders.status,
          deliveryType: orders.deliveryType,
          slotId: orders.slotId,
          fromDate: deliverySlots.date,
        })
        .from(orders)
        .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
        .where(and(eq(orders.tenantId, tenantId), inArray(orders.id, orderIds)))
        .limit(orderIds.length);

      const movable = rows.filter(
        (r) => r.deliveryType === 'address' && (r.status === 'pending' || r.status === 'confirmed'),
      );
      if (!movable.length) {
        throw new BadRequestException('Няма поръчки за преместване.');
      }

      // find-or-create the target-day slot (one row per (tenant, date), like SlotsService.create).
      const [existing] = await tx
        .select({ id: deliverySlots.id })
        .from(deliverySlots)
        .where(and(eq(deliverySlots.tenantId, tenantId), eq(deliverySlots.date, toDate)))
        .for('update')
        .limit(1);
      targetSlotId = existing?.id;
      if (!targetSlotId) {
        const [created] = await tx
          .insert(deliverySlots)
          .values({
            tenantId,
            date: toDate,
            isActive: false, // hidden from the storefront picker (findPublicBySlug filters isActive)
            generated: false,
            capacity: Math.max(1, movable.length),
            driverNote: 'Преместени поръчки',
          })
          .returning({ id: deliverySlots.id });
        targetSlotId = created.id;
      }

      for (const r of movable) {
        if (r.slotId === targetSlotId) continue; // already on the target day
        // Atomic claim, same pattern as updateStatus's into-cancelled transition
        // above: the pre-read `movable` snapshot can go stale between the SELECT
        // and this UPDATE (a concurrent status change could un-movable-ize the
        // row in between). Re-check status/deliveryType IN the UPDATE's WHERE and
        // gate on RETURNING actually matching a row — that's evaluated against the
        // row's current state at write time, not the earlier read.
        const claimed = await tx
          .update(orders)
          .set({ slotId: targetSlotId })
          .where(
            and(
              eq(orders.id, r.id),
              eq(orders.tenantId, tenantId),
              inArray(orders.status, ['pending', 'confirmed']),
              eq(orders.deliveryType, 'address'),
            ),
          )
          .returning({ id: orders.id });
        if (!claimed.length) continue; // raced by a concurrent status change — no longer movable
        moved.push({ id: r.id, fromDate: r.fromDate ?? null });
      }
    });

    // A moved-orders day must not become publicly bookable: reschedule is a routing/
    // fulfillment step, not a storefront offer. A freshly created target is already
    // is_active=false, but a REUSED existing slot (e.g. a day the farmer once opened,
    // or an earlier move-day) may still be active — hide it unless the recurring rule
    // genuinely produces this date (a real offered day stays public). The order keeps
    // its slot for the route/prep; findPublicBySlug only surfaces is_active rows.
    if (targetSlotId && moved.length) {
      const rule = await this.getSlotRule(tenantId);
      if (!rule || !ruleProducesDate(rule, toDate)) {
        await this.db
          .update(deliverySlots)
          .set({ isActive: false })
          .where(and(eq(deliverySlots.id, targetSlotId), eq(deliverySlots.tenantId, tenantId)));
      }
    }

    await this.bustPayments(tenantId);

    // Fire-and-forget per moved order (sendMoved self-guards when the buyer has no email).
    for (const m of moved) {
      void this.orderEmail.sendMoved(m.id, m.fromDate, toDate);
    }
    return { moved: moved.length, toDate };
  }

  /** The tenant's recurring slot rule (settings.slotRule) or null — read-only helper
   *  for reschedule's "is this date a genuinely offered day?" check. Mirrors
   *  SlotsService.getRule without pulling in a cross-module dependency. */
  private async getSlotRule(tenantId: string) {
    const [t] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return migrateRule((t?.settings as { slotRule?: unknown } | null)?.slotRule ?? null);
  }

  /** Cancelling frees slot capacity automatically (booked is computed from non-cancelled orders). */
  async updateStatus(id: string, tenantId: string, dto: UpdateOrderStatusDto): Promise<OrderRow> {
    // Capture the prior status so we email the buyer only on the first
    // transition into `confirmed` (re-confirming an already-confirmed order, or
    // a Stripe order the webhook already confirmed, won't re-notify).
    const [prev] = await this.db
      .select({ status: orders.status })
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .limit(1);
    // Task #9/#10: delivered_at tracks the day the order was ACTUALLY delivered,
    // kept in lockstep with `status`. Set once on the first transition into
    // 'delivered' (idempotent — re-marking an already-delivered order must not
    // bump the day); cleared if status ever moves back out of 'delivered' (an
    // operator correction) so a stale delivered_at never survives the revert.
    const statusUpdate: { status: OrderRow['status']; deliveredAt?: Date | null } = {
      status: dto.status as OrderRow['status'],
    };
    if (dto.status === 'delivered' && prev?.status !== 'delivered') {
      statusUpdate.deliveredAt = new Date();
    } else if (dto.status !== 'delivered' && prev?.status === 'delivered') {
      statusUpdate.deliveredAt = null;
    }
    const [row] = await this.db
      .update(orders)
      .set(statusUpdate)
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Поръчката не е намерена');
    if (dto.status === 'confirmed' && prev?.status !== 'confirmed') {
      void this.orderEmail.sendForOrder(id);
      // Idempotent dispatcher: routes to Speedy or Econt based on orders.carrier.
      // Only fires when the carrier has auto-create enabled. Covers COD/cash orders
      // (Econt/Speedy), which never reach the Stripe paid-webhook.
      void this.carrierFulfillment.autoCreateForOrder(id);
    }
    // First transition into `cancelled`: return each item's reserved stock to its
    // active availability window (best-effort — only while the window is still
    // active; expired windows are left as-is). The into-cancelled transition is
    // claimed atomically inside the tx so two concurrent cancels can't both restore.
    let variantStockTouched = false;
    if (dto.status === 'cancelled' && prev?.status !== 'cancelled') {
      await this.db.transaction(async (tx) => {
        // Atomic claim: lock the order row and flip its status to 'cancelled' ONLY
        // if it is not already cancelled, in one statement. RETURNING tells us
        // whether THIS tx performed the into-cancelled transition. A racing second
        // cancel blocks on the row lock, then matches zero rows (already cancelled)
        // and returns empty → it skips the restore. This — not the pre-update
        // `prev` read, which both racers can observe as non-cancelled — is the gate.
        const claimed = await tx
          .update(orders)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(orders.id, id),
              eq(orders.tenantId, tenantId),
              ne(orders.status, 'cancelled'),
            ),
          )
          .returning({ id: orders.id, paymentMethod: orders.paymentMethod, codOutcome: orders.codOutcome });
        if (!claimed.length) return; // another concurrent cancel already restored

        // Cancelling a наложен-платеж order also closes its money outcome, so the
        // Плащания screen doesn't need a second, separate «Отказана» click. Not a
        // fraud signal — an operator cancel (wrong address, out of stock, etc.) is
        // not the customer's fault — so this skips codRisk.recordManualRefusal,
        // unlike the manual setCodOutcome() path.
        const [claim] = claimed;
        if (claim.paymentMethod === 'cod' && claim.codOutcome !== 'refused') {
          await tx
            .update(orders)
            .set({
              codOutcome: 'refused',
              codOutcomeAt: new Date(),
              codOutcomeReason: null,
              codOutcomeSource: 'auto-cancel',
            })
            .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)));
        }

        const items = await tx
          .select()
          .from(orderItems)
          .where(eq(orderItems.orderId, id));
        await this.restoreAvailabilityWindows(tx, tenantId, items);
        variantStockTouched = await this.restoreVariantStock(tx, items);
      });
      // Cancelled order collects no money — void its (dormant) commission entries.
      // Fire-and-forget: the ledger must never block or fail an order write.
      void this.commission?.voidForOrder(id, tenantId);
    }
    // Status change moves the order in/out of the counted set (and flips collected
    // for COD) — refresh the Плащания cache.
    await this.bustPayments(tenantId);
    // Restoring variant stock can flip a cached soldOut back to available —
    // storefront must not keep serving the stale sold-out state.
    if (variantStockTouched) await this.catalogCache.invalidate(tenantId);
    return row;
  }

  /**
   * Producer-scoped status change: a sub-account (role='farmer') may mark its OWN
   * COD order as «delivered» (= cash received) from the Плащания screen. Two
   * server-side gates, defence-in-depth:
   *  1. Transition guard — only `delivered` is allowed; confirming/cancelling and
   *     any other transition stay owner-only (a producer can't reopen or void).
   *  2. Ownership (IDOR) — EVERY line item on the order must belong to this
   *     producer, scoped to the tenant. Marking the order «delivered» flips the
   *     COD-collected state for the WHOLE order (see the `collected` derivation),
   *     so on a shared multi-producer order one producer must not be able to mark
   *     a co-producer's portion as collected — that stays owner-only. A producer
   *     may only close out an order that is entirely their own.
   * Once both pass it delegates to the shared {@link updateStatus} (cache bust,
   * stock restore on cancel — moot here — and the same NotFound handling).
   */
  async updateStatusForFarmer(
    id: string,
    tenantId: string,
    farmerId: string,
    dto: UpdateOrderStatusDto,
  ): Promise<OrderRow> {
    if (dto.status !== 'delivered') {
      throw new ForbiddenException('Производител може само да отбележи поръчка като доставена.');
    }
    const lineItems = await this.db
      .select({ farmerId: products.farmerId })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)));
    // No line items resolved → order isn't in this tenant / not theirs at all.
    if (lineItems.length === 0) throw new ForbiddenException('Нямате достъп до тази поръчка.');
    // Any item belonging to another producer → this is a shared order; only the
    // shop owner may mark it delivered, to avoid collecting on a co-producer's behalf.
    if (lineItems.some((li) => li.farmerId !== farmerId)) {
      throw new ForbiddenException(
        'Споделена поръчка с друг производител — само собственикът може да я отбележи като доставена.',
      );
    }
    return this.updateStatus(id, tenantId, dto);
  }

  /** Set a COD order's money outcome (received / refused / pending). Manual path
   *  used by pickup + own-delivery orders and by a courier-order override. Strike on
   *  the NULL→refused transition only (idempotent re-marks add no strike).
   *  `outcome: 'pending'` REVERTS a resolved outcome back to «Очаквано» (Task #3) —
   *  undoing the side-effects the original mark caused: the commission ledger is
   *  voided (no money has actually been collected yet) and, if the order was
   *  manually refused, the cod-risk strike it recorded is reversed. */
  async setCodOutcome(
    id: string,
    tenantId: string,
    dto: UpdateCodOutcomeDto,
  ): Promise<OrderRow> {
    const [prev] = await this.db
      .select({
        id: orders.id,
        tenantId: orders.tenantId,
        paymentMethod: orders.paymentMethod,
        codOutcome: orders.codOutcome,
        customerPhone: orders.customerPhone,
      })
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!prev) throw new NotFoundException('Поръчката не е намерена');
    if (prev.paymentMethod !== 'cod') {
      throw new BadRequestException('Само поръчки с наложен платеж имат статус на плащане.');
    }

    if (dto.outcome === 'pending') {
      const revertSet = {
        codOutcome: null,
        codOutcomeAt: null,
        codOutcomeReason: null,
        codOutcomeSource: 'manual' as const,
      };
      let row: OrderRow | undefined;
      if (prev.codOutcome === 'refused') {
        // Condition the UPDATE on the order still being 'refused': two concurrent
        // reverts of the same refused order both read the same STALE `prev` above,
        // so without this guard both would call `undoManualRefusal` and double-
        // decrement a shared phone's cod-risk strike. With the guard, only the
        // request that actually flips refused→pending gets a non-empty
        // `.returning()` back and is allowed to undo the strike; the loser sees
        // an empty array (the other request already won) and skips it silently.
        const [updated] = await this.db
          .update(orders)
          .set(revertSet)
          .where(
            and(
              eq(orders.id, id),
              eq(orders.tenantId, tenantId),
              eq(orders.codOutcome, 'refused'),
            ),
          )
          .returning();
        if (updated) {
          row = updated;
          try {
            await this.codRisk.undoManualRefusal(prev as typeof orders.$inferSelect);
          } catch {
            /* best-effort: leave the revert recorded even if the strike undo fails */
          }
        } else {
          // Lost the race — a concurrent request already reverted this order out
          // of 'refused' (and already undid the strike). Nothing left to do here
          // except hand back the now-current row instead of a misleading 404.
          const [current] = await this.db
            .select()
            .from(orders)
            .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
            .limit(1);
          row = current;
        }
      } else {
        // Was 'received' or null — no strike was ever recorded, so there is no
        // race to guard against; keep the plain unconditional update.
        const [updated] = await this.db
          .update(orders)
          .set(revertSet)
          .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
          .returning();
        row = updated;
      }
      if (!row) throw new NotFoundException('Поръчката не е намерена');
      // No money has been collected once reverted to pending — void the (dormant)
      // commission accrual. Fire-and-forget: must never block the outcome write.
      void this.commission?.voidForOrder(id, tenantId);
      await this.bustPayments(tenantId);
      return row;
    }

    const [row] = await this.db
      .update(orders)
      .set({
        codOutcome: dto.outcome,
        codOutcomeAt: new Date(),
        codOutcomeReason: dto.outcome === 'refused' ? (dto.reason ?? null) : null,
        codOutcomeSource: 'manual',
      })
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Поръчката не е намерена');
    // Strike ONLY on the NULL→refused transition — never on a refused→refused
    // re-mark, and never on a received→refused change (that money was already
    // marked collected once; it does not add a second fraud signal). Best-effort:
    // a cod-risk failure must not fail the outcome write.
    if (dto.outcome === 'refused' && prev.codOutcome === null) {
      try {
        await this.codRisk.recordManualRefusal(row);
      } catch {
        /* best-effort: leave the outcome recorded even if the strike fails */
      }
    }
    // COD money outcome IS the collected-money signal the (dormant) commission
    // ledger accrues on: received → accrue (revives a voided re-mark), refused →
    // void. Fire-and-forget — must never block the outcome write.
    if (dto.outcome === 'received') void this.commission?.accrueForOrder(id, tenantId);
    else void this.commission?.voidForOrder(id, tenantId);
    await this.bustPayments(tenantId);
    return row;
  }

  /** Producer-scoped variant: a sub-account may set the outcome only on an order
   *  that is entirely their own (same IDOR gate as updateStatusForFarmer). */
  async setCodOutcomeForFarmer(
    id: string,
    tenantId: string,
    farmerId: string,
    dto: UpdateCodOutcomeDto,
  ): Promise<OrderRow> {
    const lineItems = await this.db
      .select({ farmerId: products.farmerId })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)));
    if (lineItems.length === 0) throw new ForbiddenException('Нямате достъп до тази поръчка.');
    if (lineItems.some((li) => li.farmerId !== farmerId)) {
      throw new ForbiddenException('Споделена поръчка — само собственикът може да отбележи плащането.');
    }
    return this.setCodOutcome(id, tenantId, dto);
  }

  /**
   * Daily prep list: aggregate confirmed orders for a date into per-product
   * totals (sum qty, distinct order count), most-to-prepare first. One grouped
   * query for the rows + one scalar for the confirmed-order count (no N+1).
   */
  async production(tenantId: string, date?: string): Promise<ProductionSummary> {
    const day = date ?? bgToday();
    // A slotted order counts on its delivery-slot day, not its creation day —
    // the same rule as the daily digests (see scheduledForDay). Slotless orders
    // (market pickup) fall back to creation day. Needs the deliverySlots leftJoin.
    const onDay = and(
      eq(orders.tenantId, tenantId),
      eq(orders.status, 'confirmed'),
      scheduledForDay(day),
    )!;

    // Pending (unconfirmed) orders for the same day — these aren't in the prep
    // list, so the UI warns the farmer to confirm them.
    const pendingOnDay = and(
      eq(orders.tenantId, tenantId),
      eq(orders.status, 'pending'),
      scheduledForDay(day),
    )!;

    // The four reads are independent — run concurrently (one admin page load).
    const [rows, [{ count }], [{ pending }], [tenant]] = await Promise.all([
      this.db
        .select({
          productName: orderItems.productName,
          totalQty: sql<number>`sum(${orderItems.quantity})::int`,
          orderCount: sql<number>`count(distinct ${orderItems.orderId})::int`,
          farmerId: products.farmerId,
          farmerName: farmers.name,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
        .leftJoin(products, eq(orderItems.productId, products.id))
        .leftJoin(farmers, eq(products.farmerId, farmers.id))
        .where(onDay)
        .groupBy(orderItems.productName, products.farmerId, farmers.name)
        .orderBy(sql`sum(${orderItems.quantity}) desc`, orderItems.productName),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
        .where(onDay),
      this.db
        .select({ pending: sql<number>`count(*)::int` })
        .from(orders)
        .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
        .where(pendingOnDay),
      this.db
        .select({ multiFarmer: tenants.multiFarmer })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
    ]);

    return {
      date: day,
      confirmedOrders: count,
      pendingOrders: pending,
      multiFarmer: tenant?.multiFarmer ?? false,
      items: rows.map((r) => ({
        productName: r.productName ?? '',
        totalQty: r.totalQty,
        orderCount: r.orderCount,
        farmerId: r.farmerId ?? null,
        farmerName: r.farmerName ?? null,
      })),
    };
  }

  /** Bulk confirm all pending orders (optionally for a single day). */
  async confirmPending(tenantId: string, date?: string): Promise<{ confirmed: number }> {
    const conds = [eq(orders.tenantId, tenantId), eq(orders.status, 'pending')];
    if (date) {
      const { from, to } = bgDayBounds(date);
      conds.push(gte(orders.createdAt, from), lt(orders.createdAt, to));
    }
    const rows = await this.db
      .update(orders)
      .set({ status: 'confirmed' })
      .where(and(...conds))
      .returning({ id: orders.id });
    // Each row was pending → confirmed (one-time): notify each buyer + (for Econt
    // orders on an auto-create farm) generate the waybill. Drained with a small
    // concurrency cap (detached) so a large bulk confirm doesn't open N SMTP/Econt
    // connections at once.
    void this.drainConfirmEffects(rows.map((r) => r.id));
    // Newly-confirmed orders enter the counted set — refresh the Плащания cache.
    if (rows.length) await this.bustPayments(tenantId);
    return { confirmed: rows.length };
  }

  /** Run per-order post-confirm side effects with bounded concurrency. Detached
   *  and best-effort: a single failure must not abort the rest. */
  private async drainConfirmEffects(ids: string[]): Promise<void> {
    const CONCURRENCY = 4;
    let i = 0;
    const worker = async () => {
      while (i < ids.length) {
        const id = ids[i++];
        try {
          await this.orderEmail.sendForOrder(id);
        } catch {
          /* email is best-effort */
        }
        try {
          await this.carrierFulfillment.autoCreateForOrder(id);
        } catch {
          /* waybill is best-effort */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  }

  /**
   * Lock a delivery slot row and enforce its capacity + same-day cutoff.
   * Shared by intake (reserveCartItems) and the order-edit slot reassign —
   * `excludeOrderId` lets an edit's own order not count against its own slot.
   */
  private async lockAndCheckSlot(
    tx: Tx,
    tenantId: string,
    slotId: string,
    excludeOrderId?: string,
    // Public storefront intake passes true: a hidden slot (is_active=false — a day
    // that only holds rescheduled orders, or one the farmer closed) must never
    // accept a public booking, even if a stale/crafted client submits its id.
    // Admin paths (order edit) pass false so they can still reassign onto such a slot.
    requireActive = false,
  ): Promise<{ date: string; capacity: number }> {
    const [slot] = await tx
      .select()
      .from(deliverySlots)
      .where(and(eq(deliverySlots.id, slotId), eq(deliverySlots.tenantId, tenantId)))
      .for('update')
      .limit(1);
    if (!slot) throw new BadRequestException('Слотът не е намерен');

    // Backstop for a stale checkout page open past the picker's same-day cutoff
    // (SlotsService.findPublicBySlug hides today's slots entirely + only ever returns
    // is_active rows; this rejects the booking too, in case an old tab/replay still
    // tries it, or submits a hidden slot's id).
    const reason = slotUnavailableReason(slot, { today: bgToday(), requireActive });
    if (reason === 'today') {
      throw new BadRequestException('Слотът вече не е достъпен за днес');
    }
    if (reason === 'inactive') {
      throw new BadRequestException('Слотът вече не е достъпен');
    }

    const conds = [eq(orders.slotId, slotId), ne(orders.status, 'cancelled')];
    if (excludeOrderId) conds.push(ne(orders.id, excludeOrderId));
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(...conds));
    if (slotIsFull(count, slot.capacity)) throw new ConflictException('Слотът е запълнен');

    return { date: slot.date, capacity: slot.capacity };
  }

  /**
   * Return each item's reserved stock to its active availability window
   * (best-effort — only while the window is still active; expired windows left
   * as-is). Extracted from the cancel branch so the order-edit path can reuse it.
   * Caller must run this inside an open transaction.
   */
  private async restoreAvailabilityWindows(
    tx: Tx,
    tenantId: string,
    items: { productId: string | null; quantity: number }[],
  ): Promise<void> {
    const today = bgToday();
    const restoreProductIds = items.map((it) => it.productId).filter((p): p is string => !!p);
    if (!restoreProductIds.length) return;
    const activeWindows = await tx
      .select()
      .from(productAvailabilityWindows)
      .where(
        and(
          inArray(productAvailabilityWindows.productId, restoreProductIds),
          eq(productAvailabilityWindows.tenantId, tenantId),
          lte(productAvailabilityWindows.startsAt, today),
          gte(productAvailabilityWindows.endsAt, today),
        ),
      )
      .for('update')
      .orderBy(asc(productAvailabilityWindows.productId));
    const winByProduct = new Map(activeWindows.map((w) => [w.productId, w]));
    for (const it of items) {
      if (!it.productId) continue;
      const win = winByProduct.get(it.productId);
      if (win) win.remaining = restoreRemaining(win, it.quantity);
    }
    for (const w of activeWindows) {
      await tx
        .update(productAvailabilityWindows)
        .set({ remaining: w.remaining })
        .where(eq(productAvailabilityWindows.id, w.id));
    }
  }

  /**
   * Add each variant line's quantity back to its variant stock counter (NULL =
   * unlimited, skipped). Rows locked in id order (deadlock-free). Used by the
   * order-edit and cancel paths — variant stock is decremented by
   * reserveCartItems, so an edit that drops/reduces a variant line, or a
   * cancel of the whole order, must return that stock. Returns whether any
   * finite-stock variant was touched (caller busts catalog:{tid} on true).
   */
  private async restoreVariantStock(
    tx: Tx,
    items: { variantId: string | null; quantity: number }[],
  ): Promise<boolean> {
    const variantIds = items.map((it) => it.variantId).filter((v): v is string => !!v);
    if (!variantIds.length) return false;
    const rows = await tx
      .select()
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds))
      .for('update')
      .orderBy(asc(productVariants.id));
    const byId = new Map(rows.map((v) => [v.id, v]));
    const add = new Map<string, number>();
    for (const it of items) {
      if (it.variantId) add.set(it.variantId, (add.get(it.variantId) ?? 0) + it.quantity);
    }
    for (const v of rows) {
      if (v.stockQuantity == null) continue; // unlimited
      const restored = v.stockQuantity + (add.get(v.id) ?? 0);
      await tx.update(productVariants).set({ stockQuantity: restored }).where(eq(productVariants.id, v.id));
    }
    return rows.some((v) => v.stockQuantity != null);
  }

  /**
   * Validate the cart, reserve stock (availability windows + variant stock), price
   * each line, and — when a slot is given (local delivery) — lock it and enforce
   * the slot's capacity. Runs inside an open transaction; mutates the
   * locked rows (the reservation). Shared by single-order intake ({@link create})
   * and the courier split ({@link createCourierOrders}). Returns the priced lines
   * (with each line's owning farmer) plus the resolved slot times. Throws
   * Bad/Conflict exactly as the inline intake logic did.
   */
  private async reserveCartItems(
    tx: Tx,
    tenantId: string,
    dtoItems: CreateOrderDto['items'],
    slotId: string | null,
    // Carrier (waybill) delivery — Econt/Speedy office or door, or the per-farmer
    // courier split. When true, any pickup-only product (`courierDisabled`) in the
    // cart is rejected: it must never end up on a waybill. Self-delivery + pickup
    // pass false here, so those products still sell through those channels.
    carrierDelivery = false,
    // Public storefront intake passes true so lockAndCheckSlot rejects a hidden
    // (is_active=false) slot. Admin edits leave it false (they may touch such slots).
    requireActiveSlot = false,
  ): Promise<{
    items: PreparedItem[];
    slotFrom: string | null;
    slotTo: string | null;
    slotDate: string | null;
    /** True when any line reserved variant stock — caller busts catalog:{tid} after commit
     *  (cached soldOut would otherwise lag a variant crossing to/from 0 for up to its TTL). */
    variantStockTouched: boolean;
  }> {
    const productIds = dtoItems.map((i) => i.productId);
    const prods = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), inArray(products.id, productIds)));
    const byId = new Map(prods.map((p) => [p.id, p]));

    // Load + lock the chosen variants (ordered by id so concurrent intakes acquire
    // locks in a consistent order — deadlock-free). Soft-deleted variants excluded.
    const variantIds = dtoItems.map((i) => i.variantId).filter((v): v is string => !!v);
    const variantRows = variantIds.length
      ? await tx
          .select()
          .from(productVariants)
          .where(and(inArray(productVariants.id, variantIds), isNull(productVariants.deletedAt)))
          .for('update')
          .orderBy(asc(productVariants.id))
      : [];
    const variantById = new Map(variantRows.map((v) => [v.id, v]));

    // Which ordered products have live variants → a selection is mandatory.
    const orderedIds = dtoItems.map((i) => i.productId);
    const productsWithVariants = new Set(
      (
        await tx
          .select({ pid: productVariants.productId })
          .from(productVariants)
          .where(and(inArray(productVariants.productId, orderedIds), isNull(productVariants.deletedAt)))
      ).map((r) => r.pid),
    );

    for (const it of dtoItems) {
      const p = byId.get(it.productId);
      if (!p || !p.isActive) throw new BadRequestException('Невалиден или неактивен продукт');
      if (requiresVariantSelection(productsWithVariants.has(it.productId), it.variantId)) {
        throw new BadRequestException('Изберете вариант');
      }
      if (it.variantId) {
        const v = variantById.get(it.variantId);
        if (!v || v.productId !== it.productId) throw new BadRequestException('Невалиден вариант');
      }
    }

    // Pickup-only backstop: products flagged `courierDisabled` can't go on a
    // waybill. The storefront already hides courier when such a product is in the
    // cart; re-check server-side so a crafted request can't ship one anyway.
    if (carrierDelivery) {
      const blocked = dtoItems
        .map((it) => byId.get(it.productId))
        .filter((p): p is NonNullable<typeof p> => !!p && p.courierDisabled);
      if (blocked.length) {
        const names = [...new Set(blocked.map((p) => p.name))].join(', ');
        throw new BadRequestException(
          `Тези продукти не се изпращат с куриер (само вземане от място/местна доставка): ${names}`,
        );
      }
    }

    // Companion rule (generalized „кайсии" loss-leader): a product flagged
    // `requiresCompanion` can't be ordered alone. When `companionMinPriceStotinki`
    // is set, the OTHER products in the cart (everything except this flagged
    // product) must TOTAL at least the threshold (EUR cents) — a basket of cheaper
    // goods qualifies, not only a single expensive item. That is the point: cheap
    // „кайсии" pull traffic to the platform but can't leave on their own; the
    // shopper must build a real basket alongside them. When the threshold is unset
    // (0), any one other distinct product suffices. Configurable per product/bundle,
    // enforced for EVERY delivery method (pickup/local/courier), independent of the
    // courier backstop above. byId already holds the full product rows +
    // variantById the chosen variants — no extra query.
    const companionRequirers = dtoItems
      .map((it) => byId.get(it.productId))
      .filter((p): p is NonNullable<typeof p> => !!p && p.requiresCompanion);
    if (companionRequirers.length) {
      const nowC = new Date();
      const unitOf = (it: (typeof dtoItems)[number]): number => {
        const prod = byId.get(it.productId)!;
        const variant = it.variantId ? variantById.get(it.variantId) ?? null : null;
        return resolveLineUnit(prod, variant, nowC).unitStotinki;
      };
      for (const req of companionRequirers) {
        const threshold = req.companionMinPriceStotinki ?? 0;
        // Every cart line for a DIFFERENT product counts toward the companion total.
        const others = dtoItems.filter(
          (it) => it.productId !== req.id && !!byId.get(it.productId),
        );
        const othersTotal = others.reduce((sum, it) => sum + unitOf(it) * it.quantity, 0);
        const satisfied = threshold > 0 ? othersTotal >= threshold : others.length > 0;
        if (!satisfied) {
          if (threshold > 0) {
            const eur = (threshold / 100).toFixed(2).replace('.', ',');
            throw new BadRequestException(
              `„${req.name}" не се доставя самостоятелно — добавете други продукти на обща стойност поне ${eur} €.`,
            );
          }
          throw new BadRequestException(
            `„${req.name}" не се доставя самостоятелно — добавете поне още един продукт по избор.`,
          );
        }
      }
    }

    // Slot (local delivery only): lock the row + enforce the slot's capacity. When
    // slotId is null (courier / non-local) this whole block is skipped.
    // slotFrom/slotTo: day-rows carry no time window anymore (see migration
    // 0081) — lockAndCheckSlot returns date-only now, so these stay null.
    // Any time-window email copy is Task 9's concern.
    let slotFrom: string | null = null;
    let slotTo: string | null = null;
    let slotDate: string | null = null;
    if (slotId) {
      const s = await this.lockAndCheckSlot(tx, tenantId, slotId, undefined, requireActiveSlot);
      slotDate = s.date;
    }

    // Per-item availability-window enforcement (lock all active windows in one
    // ordered statement — deadlock-free). Products with no active window unaffected.
    const today = bgToday();
    const orderedProductIds = dtoItems.map((it) => it.productId);
    const activeWindows = orderedProductIds.length
      ? await tx
          .select()
          .from(productAvailabilityWindows)
          .where(
            and(
              inArray(productAvailabilityWindows.productId, orderedProductIds),
              eq(productAvailabilityWindows.tenantId, tenantId),
              lte(productAvailabilityWindows.startsAt, today),
              gte(productAvailabilityWindows.endsAt, today),
            ),
          )
          .for('update')
          .orderBy(asc(productAvailabilityWindows.productId))
      : [];
    // Pool a product's active windows (there can, in edge cases, be more than one —
    // e.g. a legacy dated window overlapping the open-ended stock window; product_id
    // has no unique constraint). Enforcing against the SUM means a sold-out
    // ("изчерпано", remaining 0) window can't be bypassed via a second window that
    // still has stock — the exact display-vs-order divergence a plain last-wins Map
    // would allow. `winsByProduct` values reference the same window objects as
    // `activeWindows`, so mutating `remaining` below is picked up by the persist loop.
    const winsByProduct = new Map<string, typeof activeWindows>();
    for (const w of activeWindows) {
      if (!w.productId) continue; // windows here are queried by product_id → always set
      const list = winsByProduct.get(w.productId) ?? [];
      list.push(w);
      winsByProduct.set(w.productId, list);
    }
    for (const it of dtoItems) {
      const wins = winsByProduct.get(it.productId) ?? [];
      const decision = decideDecrementPooled(wins, it.quantity);
      if (!decision.ok) {
        const p = byId.get(it.productId);
        throw new ConflictException(`Няма достатъчна наличност: ${p?.name ?? 'продукт'}`);
      }
      if (decision.newRemaining) {
        wins.forEach((w, i) => {
          w.remaining = decision.newRemaining![i];
        });
      }
    }
    for (const w of activeWindows) {
      await tx
        .update(productAvailabilityWindows)
        .set({ remaining: w.remaining })
        .where(eq(productAvailabilityWindows.id, w.id));
    }

    // Variant stock decrement (mirrors the window block; stockQuantity null = unlimited).
    for (const it of dtoItems) {
      if (!it.variantId) continue;
      const v = variantById.get(it.variantId)!;
      const active = v.stockQuantity == null ? null : { remaining: v.stockQuantity };
      const decision = decideDecrement(active, it.quantity);
      if (!decision.ok) throw new ConflictException(`Няма достатъчна наличност: ${v.label}`);
      if (v.stockQuantity != null && decision.newRemaining != null) v.stockQuantity = decision.newRemaining;
    }
    for (const v of variantRows) {
      if (v.stockQuantity != null) {
        await tx.update(productVariants).set({ stockQuantity: v.stockQuantity }).where(eq(productVariants.id, v.id));
      }
    }

    // Promo expiry is coarse (date-level), so a plain wall-clock Date is correct.
    const now = new Date();
    const items: PreparedItem[] = dtoItems.map((it) => {
      const p = byId.get(it.productId)!;
      const variant = it.variantId ? variantById.get(it.variantId)! : null;
      const line = resolveLineUnit(p, variant, now);
      return {
        productId: p.id,
        productName: line.label,
        quantity: it.quantity,
        priceStotinki: line.unitStotinki,
        variantId: line.variantId,
        variantLabel: line.variantLabel,
        farmerId: p.farmerId ?? null,
      };
    });

    return { items, slotFrom, slotTo, slotDate, variantStockTouched: dtoItems.some((it) => !!it.variantId) };
  }

  /**
   * Public intake from a storefront. In one transaction: resolve the tenant,
   * snapshot product name/price, enforce slot capacity with a row lock
   * (double-booking impossible), compute the total, create the pending order.
   */
  async create(
    slug: string,
    dto: CreateOrderDto,
    // The checkout path already resolved the tenant by slug for its Stripe pre-flight —
    // it passes the row here so intake doesn't re-SELECT it. Omitted by other callers.
    preloadedTenant?: Pick<
      typeof tenants.$inferSelect,
      | 'id' | 'farmLat' | 'farmLng' | 'subscriptionStatus' | 'settings' | 'deliveryEnabled'
      | 'deliveriesPackageEnabled'
    >,
    // Cookieless visitor hash computed by CheckoutService from the request's
    // IP+UA — persisted so the server-emitted 'purchase' analytics event can
    // reuse it (see analytics.helpers.visitorHash). Null for callers that don't
    // track (e.g. the bare placeOrder() path — out of scope for this change).
    visitorHash?: string | null,
  ): Promise<OrderWithItems> {
    // Three delivery methods: local farm delivery (slots + route + coords),
    // Econt → office, Econt → home address. Only local delivery consumes a slot
    // and is geocoded for the farm's route; the Econt methods are courier-shipped.
    const method = dto.deliveryType ?? 'address';
    const isLocal = method === 'address';
    const isEcontOffice = method === 'econt';

    // Resolve the tenant (+ farm coords) up front so geocoding can run outside
    // the transaction (no network call while holding row locks).
    const tenant =
      preloadedTenant ??
      (
        await this.db
          .select({
            id: tenants.id,
            farmLat: tenants.farmLat,
            farmLng: tenants.farmLng,
            subscriptionStatus: tenants.subscriptionStatus,
            settings: tenants.settings,
            deliveryEnabled: tenants.deliveryEnabled,
            deliveriesPackageEnabled: tenants.deliveriesPackageEnabled,
          })
          .from(tenants)
          .where(eq(tenants.slug, slug))
          .limit(1)
      )[0];
    if (!tenant) throw new NotFoundException('Фермата не е намерена');

    // Server-side backstop: the chosen delivery + payment methods must actually
    // be enabled for this farm (the storefront only hides them client-side).
    this.assertMethodAllowed(
      tenant.settings,
      tenant.deliveryEnabled,
      tenant.deliveriesPackageEnabled,
      method,
      dto.paymentMethod ?? 'online',
    );

    // Carrier selection: only meaningful for door (econt_address) delivery.
    // If the farm runs both carriers (comparisonActive), the DTO carries the
    // customer's choice; otherwise we default to whichever carrier is live.
    const deliveryCfg = (tenant.settings as { delivery?: DeliveryConfig } | null)?.delivery ?? null;
    let carrier: 'econt' | 'speedy' | null = null;
    if (method === 'econt_address') {
      const policy = carrierPolicy(deliveryCfg);
      if (policy === 'econt' || policy === 'speedy') {
        // Farm forces one carrier — the customer's pick is ignored.
        carrier = policy;
      } else if (policy === 'cheapest') {
        // Leave unresolved: the checkout prices both door carriers and persists
        // the cheaper one before fulfillment dispatches.
        carrier = null;
      } else {
        // 'customer' — the storefront picker's choice, with a live-carrier default.
        carrier = dto.carrier ?? (econtMode(deliveryCfg) === 'auto' ? 'econt' : speedyEnabled(deliveryCfg) ? 'speedy' : 'econt');
      }
      if (carrier === 'speedy' && !speedyEnabled(deliveryCfg)) {
        throw new BadRequestException('Избраният куриер не е наличен.');
      }
      if (carrier === 'econt' && econtMode(deliveryCfg) === 'off') {
        throw new BadRequestException('Избраният куриер не е наличен.');
      }
    }

    // A farm with a lapsed subscription can't take new orders — mirrors the
    // ActiveSubscriptionGuard on the admin side. Grace (`past_due`) still sells;
    // only a fully `inactive` (grace-expired / cancelled) farm is blocked.
    if (tenant.subscriptionStatus === 'inactive') {
      throw new ForbiddenException('Магазинът временно не приема поръчки.');
    }

    // Delivery coordinates: prefer the precise storefront pin; otherwise geocode
    // the typed address, biased to the farm's region so an ambiguous street
    // ("ул. Шипка 5") resolves near the farm, not in Sofia. No-op when maps off.
    let lat = dto.deliveryLat ?? null;
    let lng = dto.deliveryLng ?? null;
    if (isLocal && lat == null && dto.deliveryAddress) {
      const fLat = tenant.farmLat == null ? null : Number(tenant.farmLat);
      const fLng = tenant.farmLng == null ? null : Number(tenant.farmLng);
      const bias = fLat != null && fLng != null ? { lat: fLat, lng: fLng } : undefined;
      // Pass the structured city/postal as Geocoding component filters — they
      // disambiguate same-named streets in different towns better than the bias
      // box alone (the service falls back to country-only if they over-filter).
      const geo = await this.maps.geocode(dto.deliveryAddress, bias, {
        locality: dto.deliveryCity,
        postalCode: dto.deliveryPostal,
      });
      if (geo) {
        lat = geo.lat;
        lng = geo.lng;
      }
    }

    // Econt-to-door needs a structured settlement name for the carrier (the door
    // label — a missing city makes Econt reject mid-call with ExInvalidCity). When
    // the buyer typed the address by hand (no Google Places pick) the storefront
    // can't supply deliveryCity, so derive it by geocoding the typed address,
    // biased to the farm's region. Local delivery doesn't need this — the farm
    // delivers by its own route/coords. (Courier splits via createCourierOrders,
    // which derives the city the same way.)
    let deliveryCity = dto.deliveryCity?.trim() || null;
    if (method === 'econt_address' && !deliveryCity && dto.deliveryAddress) {
      const fLat = tenant.farmLat == null ? null : Number(tenant.farmLat);
      const fLng = tenant.farmLng == null ? null : Number(tenant.farmLng);
      const bias = fLat != null && fLng != null ? { lat: fLat, lng: fLng } : undefined;
      deliveryCity = await this.maps.geocodeCity(dto.deliveryAddress, bias, {
        postalCode: dto.deliveryPostal,
      });
    }

    let variantStockTouched = false;
    const result = await this.db.transaction(async (tx) => {
      // Only local farm delivery consumes a slot; courier/Econt orders never count
      // against the farm's delivery capacity.
      const slotId = isLocal ? dto.slotId ?? null : null;
      // Econt office/door are carrier (waybill) deliveries → enforce the pickup-only
      // block. Local self-delivery (address) + pickup never touch a waybill.
      const carrierDelivery = method === 'econt' || method === 'econt_address';
      const {
        items: prepared,
        slotFrom,
        slotTo,
        slotDate,
        variantStockTouched: touched,
      } = await this.reserveCartItems(tx, tenant.id, dto.items, slotId, carrierDelivery, true);
      variantStockTouched = touched;
      const total = prepared.reduce((s, i) => s + i.priceStotinki * i.quantity, 0);
      // order_items has no farmer_id column — strip it before insert.
      const items = prepared.map(({ farmerId: _f, ...line }) => line);

      // Next per-tenant order number (#1, #2, …). The advisory lock serializes
      // concurrent intakes for this tenant so two orders can't claim the same
      // number; it's released when the transaction commits/rolls back.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenant.id}, 0))`);
      const [{ nextNumber }] = await tx
        .select({ nextNumber: sql<number>`coalesce(max(${orders.orderNumber}), 0) + 1` })
        .from(orders)
        .where(eq(orders.tenantId, tenant.id));

      const [order] = await tx
        .insert(orders)
        .values({
          tenantId: tenant.id,
          orderNumber: nextNumber,
          customerName: dto.customerName,
          customerPhone: dto.customerPhone,
          customerEmail: dto.customerEmail,
          slotId,
          status: 'pending',
          totalStotinki: total,
          deliveryType: method,
          // Address stored for local + Econt-to-address; only Econt-office omits it.
          deliveryAddress: isEcontOffice ? null : dto.deliveryAddress ?? null,
          deliveryCity: isEcontOffice ? null : deliveryCity,
          // Block/entrance detail — local delivery only (Econt keeps it inline in
          // deliveryAddress; office delivery has no street).
          deliveryNote: isLocal ? dto.deliveryNote ?? null : null,
          // Coords are for the farm's own route — local delivery only.
          deliveryLat: isLocal && lat != null ? String(lat) : null,
          deliveryLng: isLocal && lng != null ? String(lng) : null,
          econtOffice: isEcontOffice ? dto.econtOffice ?? null : null,
          // Which courier the customer selected for door delivery (null for non-door).
          carrier,
          // Customer's payment choice; checkout may normalize 'online'→'cod'
          // when the farm has no usable Stripe account.
          paymentMethod: dto.paymentMethod ?? 'online',
          notes: dto.notes ?? null,
          visitorHash: visitorHash ?? null,
        })
        .returning();

      const inserted = await tx
        .insert(orderItems)
        .values(items.map((i) => ({ ...i, orderId: order.id })))
        .returning();

      return { ...order, slotFrom, slotTo, slotDate, items: inserted };
    });
    // Cached public catalog bakes soldOut from variant stock — bust it or a variant
    // that just sold out (or a cancel/restore elsewhere) shows wrong until its TTL.
    if (variantStockTouched) await this.catalogCache.invalidate(tenant.id);
    return result;
  }

  /**
   * Courier checkout: split a (possibly multi-farmer) cart into ONE single-farmer
   * COD order per farmer. All-or-nothing in a single transaction — if any farmer is
   * not courier-ready, or any item lacks a farmer, nothing is created (the stock
   * reservations roll back). No platform delivery fee: each order's total is that
   * farmer's line subtotal. `carrier` stays NULL (the farmer picks it at ship time);
   * `slotId` is null (courier never consumes a slot). Order numbers are assigned
   * sequentially under the per-tenant advisory lock, as in {@link create}.
   */
  async createCourierOrders(
    slug: string,
    dto: CreateOrderDto,
    // Cookieless visitor hash (see create()'s param doc) — same value stamped
    // onto every split leg, so all of a courier checkout's orders resolve to
    // one visitor for the purchase-event emit in CheckoutService.
    visitorHash?: string | null,
  ): Promise<(OrderWithItems & { farmerName: string | null })[]> {
    const [tenant] = await this.db
      .select({
        id: tenants.id,
        subscriptionStatus: tenants.subscriptionStatus,
        settings: tenants.settings,
        farmLat: tenants.farmLat,
        farmLng: tenants.farmLng,
      })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');
    if (tenant.subscriptionStatus === 'inactive') {
      throw new ForbiddenException('Магазинът временно не приема поръчки.');
    }
    // Courier is COD only; the platform never takes courier money by card.
    const cfg = (tenant.settings as { delivery?: DeliveryConfig } | null)?.delivery ?? null;
    if (!codEnabled(cfg)) {
      throw new BadRequestException('Плащането с наложен платеж не е налично.');
    }

    // Each carrier needs a structured settlement name (Speedy searchSites / the
    // farmer's waybill). When the buyer typed the address by hand (no Google pick)
    // the storefront can't supply deliveryCity — derive it by geocoding the typed
    // address, biased to the farm's region, so every split leg carries a routable
    // city. Done once before the transaction (network call kept out of the tx).
    let deliveryCity = dto.deliveryCity?.trim() || null;
    if (!deliveryCity && dto.deliveryAddress) {
      const fLat = tenant.farmLat == null ? null : Number(tenant.farmLat);
      const fLng = tenant.farmLng == null ? null : Number(tenant.farmLng);
      const bias = fLat != null && fLng != null ? { lat: fLat, lng: fLng } : undefined;
      deliveryCity = await this.maps.geocodeCity(dto.deliveryAddress, bias, {
        postalCode: dto.deliveryPostal,
      });
    }

    let variantStockTouched = false;
    const result = await this.db.transaction(async (tx) => {
      const { items: prepared, variantStockTouched: touched } = await this.reserveCartItems(
        tx,
        tenant.id,
        dto.items,
        null,
        true,
      );
      variantStockTouched = touched;

      // Every courier line must resolve to a farmer (the split key).
      if (prepared.some((i) => i.farmerId == null)) {
        throw new BadRequestException('Куриерска доставка изисква продукти с фермер.');
      }

      // Group lines by farmer (Map preserves first-seen order → stable numbering).
      const groups = new Map<string, PreparedItem[]>();
      for (const it of prepared) {
        const fid = it.farmerId!;
        const list = groups.get(fid);
        if (list) list.push(it);
        else groups.set(fid, [it]);
      }
      const farmerIds = [...groups.keys()];

      // Backstop: every farmer in the cart must be courier-ready (carrier
      // connected). The storefront already gates on this; re-check server-side so a
      // crafted request can't create an unshippable courier order.
      const farmerRows = await tx
        .select({ id: farmers.id, name: farmers.name })
        .from(farmers)
        .where(and(eq(farmers.tenantId, tenant.id), inArray(farmers.id, farmerIds)));
      const farmerById = new Map(farmerRows.map((f) => [f.id, f]));
      for (const fid of farmerIds) {
        const f = farmerById.get(fid);
        const ready = !!f && farmerCourierReady(farmerDeliveryNamespace(tenant.settings, fid));
        if (!ready) {
          throw new BadRequestException('Един от фермерите не предлага куриерска доставка.');
        }
      }

      // Sequential per-tenant order numbers (advisory lock as in create()).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenant.id}, 0))`);
      const [{ nextNumber }] = await tx
        .select({ nextNumber: sql<number>`coalesce(max(${orders.orderNumber}), 0) + 1` })
        .from(orders)
        .where(eq(orders.tenantId, tenant.id));

      const out: (OrderWithItems & { farmerName: string | null })[] = [];
      let n = nextNumber;
      for (const fid of farmerIds) {
        const lines = groups.get(fid)!;
        const total = lines.reduce((s, i) => s + i.priceStotinki * i.quantity, 0);
        const [order] = await tx
          .insert(orders)
          .values({
            tenantId: tenant.id,
            farmerId: fid,
            orderNumber: n++,
            customerName: dto.customerName,
            customerPhone: dto.customerPhone,
            customerEmail: dto.customerEmail,
            slotId: null,
            status: 'pending',
            totalStotinki: total, // no platform delivery fee for courier
            deliveryType: 'courier',
            carrier: null, // farmer picks the carrier at ship time
            deliveryAddress: dto.deliveryAddress ?? null,
            deliveryCity,
            deliveryNote: null,
            deliveryLat: null,
            deliveryLng: null,
            econtOffice: null,
            paymentMethod: 'cod',
            notes: dto.notes ?? null,
            visitorHash: visitorHash ?? null,
          })
          .returning();
        const inserted = await tx
          .insert(orderItems)
          .values(lines.map(({ farmerId: _f, ...line }) => ({ ...line, orderId: order.id })))
          .returning();
        // Phase 3: distribution — drop a DRAFT shipment into the farmer's queue.
        // No carrier call (status='draft'); the farmer picks the carrier + finalizes
        // in dostavki later. carrier is OMITTED so it defaults to the 'econt'
        // placeholder (the column is NOT NULL) — 'draft' status is the unshipped
        // marker, not carrier. Idempotent via the shipments_order_unique index.
        await tx
          .insert(shipments)
          .values({
            tenantId: tenant.id,
            orderId: order.id,
            farmerId: fid,
            status: 'draft',
            codAmountStotinki: total,
            deliveryMode: 'address',
          })
          .onConflictDoNothing({ target: shipments.orderId });
        out.push({
          ...order,
          slotFrom: null,
          slotTo: null,
          slotDate: null,
          items: inserted,
          farmerName: farmerById.get(fid)?.name ?? null,
        });
      }
      return out;
    });
    if (variantStockTouched) await this.catalogCache.invalidate(tenant.id);
    return result;
  }

  /**
   * Public order recap for the storefront confirmation page. Gated by the
   * order UUID **and** the storefront slug (you can't read another farm's order
   * through the wrong slug); never exposes phone/email/tenant. Server-fetched,
   * so the page survives a refresh.
   */
  async findPublicOrderSummary(slug: string, id: string): Promise<PublicOrderSummary> {
    const [row] = await this.db
      .select({
        ...getTableColumns(orders),
        slotDate: deliverySlots.date,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
      })
      .from(orders)
      .innerJoin(tenants, eq(orders.tenantId, tenants.id))
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(and(eq(orders.id, id), eq(tenants.slug, slug)))
      .limit(1);
    if (!row) throw new NotFoundException('Поръчката не е намерена');

    const items = await this.db
      .select({
        name: orderItems.productName,
        quantity: orderItems.quantity,
        priceStotinki: orderItems.priceStotinki,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, id));

    const hhmm = (t: string | null) => (t ? t.slice(0, 5) : '');
    return {
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status ?? 'pending',
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      totalStotinki: row.totalStotinki,
      deliveryType: row.deliveryType,
      // Note: customerName/deliveryAddress are intentionally NOT returned — the
      // customer already knows their own name/address, and the recap is reachable
      // by anyone holding the order UUID (it can leak via history/Referer). Don't
      // echo PII we don't need.
      econtOffice: row.econtOffice,
      // Day-rows (post migration 0081) carry a date but no time window — show the
      // date with blank times rather than dropping the slot line entirely.
      slot: row.slotDate
        ? { date: row.slotDate, startTime: hhmm(row.slotFrom), endTime: hhmm(row.slotTo) }
        : null,
      items: items.map((i) => ({
        name: i.name ?? '',
        quantity: i.quantity,
        priceStotinki: i.priceStotinki,
      })),
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    };
  }

  /** Batch-load items for a set of orders and attach them (no N+1). */
  private async attachItems<T extends { id: string }>(
    rows: T[],
  ): Promise<(T & { items: ItemRow[] })[]> {
    if (!rows.length) return [];
    const ids = rows.map((o) => o.id);
    const items = await this.db
      .select()
      .from(orderItems)
      .where(inArray(orderItems.orderId, ids));
    const byOrder = new Map<string, ItemRow[]>();
    for (const it of items) {
      const list = byOrder.get(it.orderId!) ?? [];
      list.push(it);
      byOrder.set(it.orderId!, list);
    }
    return rows.map((o) => ({ ...o, items: byOrder.get(o.id) ?? [] }));
  }
}
