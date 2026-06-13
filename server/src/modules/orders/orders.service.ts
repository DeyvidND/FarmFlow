import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { and, desc, eq, getTableColumns, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  type Database,
  orders,
  orderItems,
  products,
  deliverySlots,
  tenants,
  farmers,
} from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { MapsService } from '../../common/maps/maps.service';
import { bgToday, bgDayBounds, bgDate } from '../../common/time/bg-time';
import { clampLimit, keysetAfter, type Paginated } from '../../common/pagination/keyset';
import { encodeCursor, decodeCursor } from '../../common/pagination/cursor';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrderConfirmationService } from '../order-email/order-confirmation.service';
import { EcontService } from '../econt/econt.service';
import { buildPublicMethods, codEnabled, type DeliveryConfig } from './delivery-pricing';
import { scheduledForDay } from './order-scheduling';

type OrderRow = typeof orders.$inferSelect;
type ItemRow = typeof orderItems.$inferSelect;
type SlotTimes = { slotFrom: string | null; slotTo: string | null };
type OrderWithItems = OrderRow & SlotTimes & { items: ItemRow[] };

const orderWithSlot = {
  ...getTableColumns(orders),
  slotFrom: deliverySlots.timeFrom,
  slotTo: deliverySlots.timeTo,
};

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

/** Order statuses that count as a real COD «payment» on the Плащания screen:
 *  everything the farmer has confirmed (money in hand or due at delivery),
 *  excluding still-pending and cancelled orders. */
export const COD_COUNTED_STATUSES = [
  'confirmed',
  'preparing',
  'out_for_delivery',
  'delivered',
] as const;

/** One COD order as shown under a day on the payments screen. */
export interface CodPaymentOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  totalStotinki: number;
  status: string;
  deliveryType: string;
  /** True once delivered — money actually collected (vs. expected). */
  collected: boolean;
  createdAt: string | null;
  slotFrom: string | null;
  slotTo: string | null;
}

export interface CodPaymentDay {
  /** BG calendar day of delivery (slot day; creation day for slotless orders). */
  day: string;
  totalStotinki: number;
  count: number;
  orders: CodPaymentOrder[];
}

export interface CodPaymentsSummary {
  /** Grand total over the returned window (minor units, EUR cents). */
  totalStotinki: number;
  count: number;
  /** Newest delivery day first. */
  days: CodPaymentDay[];
}

/** Raw row shape the COD query feeds into {@link groupCodPayments}. */
export interface CodPaymentRow {
  day: string;
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  totalStotinki: number;
  status: string;
  deliveryType: string;
  createdAt: Date | string | null;
  slotFrom: string | null;
  slotTo: string | null;
}

/**
 * Group flat COD order rows into per-day buckets (newest day first), summing the
 * day total + count. Pure (no DB) so it's unit-testable; rows arrive already
 * filtered to counted statuses + paymentMethod='cod'. Within a day the input
 * order is preserved (the query sorts newest-created first).
 */
export function groupCodPayments(rows: CodPaymentRow[]): CodPaymentsSummary {
  const byDay = new Map<string, CodPaymentDay>();
  for (const r of rows) {
    let bucket = byDay.get(r.day);
    if (!bucket) {
      bucket = { day: r.day, totalStotinki: 0, count: 0, orders: [] };
      byDay.set(r.day, bucket);
    }
    bucket.orders.push({
      id: r.id,
      orderNumber: r.orderNumber,
      customerName: r.customerName,
      totalStotinki: r.totalStotinki,
      status: r.status,
      deliveryType: r.deliveryType,
      collected: r.status === 'delivered',
      createdAt: r.createdAt == null ? null : new Date(r.createdAt).toISOString(),
      slotFrom: r.slotFrom,
      slotTo: r.slotTo,
    });
    bucket.totalStotinki += r.totalStotinki;
    bucket.count += 1;
  }
  const days = [...byDay.values()].sort((a, b) =>
    a.day < b.day ? 1 : a.day > b.day ? -1 : 0,
  );
  return {
    totalStotinki: days.reduce((s, d) => s + d.totalStotinki, 0),
    count: days.reduce((s, d) => s + d.count, 0),
    days,
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
  customerName: string | null;
  deliveryType: 'pickup' | 'address' | 'econt' | 'econt_address';
  econtOffice: string | null;
  slot: { date: string; startTime: string; endTime: string } | null;
  items: { name: string; quantity: number; priceStotinki: number }[];
  createdAt: string | null;
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly maps: MapsService,
    private readonly orderEmail: OrderConfirmationService,
    private readonly econt: EcontService,
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
    method: 'pickup' | 'address' | 'econt' | 'econt_address',
    paymentMethod: 'online' | 'cod',
  ): void {
    const cfg = (settings as { delivery?: DeliveryConfig } | null)?.delivery ?? null;
    const methods = buildPublicMethods(cfg);
    const allowed: Record<string, boolean> = {
      pickup: methods.pickup,
      // Self-delivery availability is the SAME signal the storefront gates on:
      // `deliveryEnabled` (the slot picker master switch) AND the ownSlots method
      // flag. A farm with deliveryEnabled=false offers no local delivery even if
      // ownSlots defaults on.
      address: deliveryEnabled && methods.ownSlots,
      econt: methods.econtOffice,
      econt_address: methods.econtAddress,
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
  async findAll(
    tenantId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<Paginated<SerializedOrder>> {
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
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

    if (cur) conds.push(keysetAfter(orders.createdAt, orders.id, cur, 'desc'));

    const rows = await this.db
      .select(orderWithSlot)
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(and(...conds)!)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(lim + 1);

    const hasMore = rows.length > lim;
    const pageRows = hasMore ? rows.slice(0, lim) : rows;
    const items = (await this.attachItems(pageRows)).map(serializeOrder);
    const last = pageRows[pageRows.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last ? encodeCursor({ createdAt: last.createdAt!, id: last.id }) : null,
    };
  }

  /**
   * COD («наложен платеж») money for the farmer's Плащания screen: confirmed-and-
   * beyond orders paid by наложен платеж, grouped by delivery day (slot day;
   * creation day for slotless Econt/pickup orders — same rule as production /
   * digests). Newest day first; capped at the most recent 300 orders. Card
   * (Stripe) payments are surfaced separately by the Stripe summary.
   */
  async codPayments(tenantId: string): Promise<CodPaymentsSummary> {
    // Delivery day: the slot's date, falling back to the BG-local creation date
    // for slotless orders. Mirrors scheduledForDay's day rule.
    const day = sql<string>`coalesce(${deliverySlots.date}, ${bgDate(orders.createdAt)})`;
    const rows = await this.db
      .select({
        day,
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        totalStotinki: orders.totalStotinki,
        status: orders.status,
        deliveryType: orders.deliveryType,
        createdAt: orders.createdAt,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
      })
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.paymentMethod, 'cod'),
          inArray(orders.status, [...COD_COUNTED_STATUSES]),
        ),
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(300);
    return groupCodPayments(rows as CodPaymentRow[]);
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
    const [row] = await this.db
      .update(orders)
      .set({ status: dto.status as OrderRow['status'] })
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Поръчката не е намерена');
    if (dto.status === 'confirmed' && prev?.status !== 'confirmed') {
      void this.orderEmail.sendForOrder(id);
      // Self-gating + idempotent: only fires for Econt orders on a farm with
      // auto-create enabled. Covers COD/cash Econt orders, which never reach the
      // Stripe paid-webhook (its only other trigger).
      void this.econt.autoCreateForOrder(id);
    }
    return row;
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

    // The three reads are independent — run concurrently (one admin page load).
    const [rows, [{ count }], [tenant]] = await Promise.all([
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
        .select({ multiFarmer: tenants.multiFarmer })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
    ]);

    return {
      date: day,
      confirmedOrders: count,
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
          await this.econt.autoCreateForOrder(id);
        } catch {
          /* waybill is best-effort */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  }

  /**
   * Public intake from a storefront. In one transaction: resolve the tenant,
   * snapshot product name/price, enforce slot capacity with a row lock
   * (double-booking impossible), compute the total, create the pending order.
   */
  async create(slug: string, dto: CreateOrderDto): Promise<OrderWithItems> {
    // Three delivery methods: local farm delivery (slots + route + coords),
    // Econt → office, Econt → home address. Only local delivery consumes a slot
    // and is geocoded for the farm's route; the Econt methods are courier-shipped.
    const method = dto.deliveryType ?? 'address';
    const isLocal = method === 'address';
    const isEcontOffice = method === 'econt';

    // Resolve the tenant (+ farm coords) up front so geocoding can run outside
    // the transaction (no network call while holding row locks).
    const [tenant] = await this.db
      .select({
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
    if (!tenant) throw new NotFoundException('Фермата не е намерена');

    // Server-side backstop: the chosen delivery + payment methods must actually
    // be enabled for this farm (the storefront only hides them client-side).
    this.assertMethodAllowed(
      tenant.settings,
      tenant.deliveryEnabled,
      method,
      dto.paymentMethod ?? 'online',
    );
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
      const geo = await this.maps.geocode(dto.deliveryAddress, bias);
      if (geo) {
        lat = geo.lat;
        lng = geo.lng;
      }
    }

    return this.db.transaction(async (tx) => {
      const productIds = dto.items.map((i) => i.productId);
      const prods = await tx
        .select()
        .from(products)
        .where(and(eq(products.tenantId, tenant.id), inArray(products.id, productIds)));
      const byId = new Map(prods.map((p) => [p.id, p]));

      for (const it of dto.items) {
        const p = byId.get(it.productId);
        if (!p || !p.isActive) throw new BadRequestException('Невалиден или неактивен продукт');
      }

      // Only local farm delivery uses a slot; Econt orders are courier-shipped
      // and never count against the farm's delivery capacity.
      const slotId = isLocal ? dto.slotId ?? null : null;
      let slotFrom: string | null = null;
      let slotTo: string | null = null;
      if (slotId) {
        // Lock the slot row so concurrent intakes serialize on it.
        const [slot] = await tx
          .select()
          .from(deliverySlots)
          .where(and(eq(deliverySlots.id, slotId), eq(deliverySlots.tenantId, tenant.id)))
          .for('update')
          .limit(1);
        if (!slot) throw new BadRequestException('Слотът не е намерен');
        slotFrom = slot.timeFrom;
        slotTo = slot.timeTo;

        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(orders)
          .where(and(eq(orders.slotId, slotId), ne(orders.status, 'cancelled')));
        if (count >= slot.maxOrders) throw new ConflictException('Слотът е запълнен');
      }

      let total = 0;
      const items = dto.items.map((it) => {
        const p = byId.get(it.productId)!;
        total += p.priceStotinki * it.quantity;
        return {
          productId: p.id,
          productName: [p.name, p.weight].filter(Boolean).join(' '),
          quantity: it.quantity,
          priceStotinki: p.priceStotinki,
        };
      });

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
          deliveryCity: isEcontOffice ? null : dto.deliveryCity ?? null,
          // Coords are for the farm's own route — local delivery only.
          deliveryLat: isLocal && lat != null ? String(lat) : null,
          deliveryLng: isLocal && lng != null ? String(lng) : null,
          econtOffice: isEcontOffice ? dto.econtOffice ?? null : null,
          // Customer's payment choice; checkout may normalize 'online'→'cod'
          // when the farm has no usable Stripe account.
          paymentMethod: dto.paymentMethod ?? 'online',
          notes: dto.notes ?? null,
        })
        .returning();

      const inserted = await tx
        .insert(orderItems)
        .values(items.map((i) => ({ ...i, orderId: order.id })))
        .returning();

      return { ...order, slotFrom, slotTo, items: inserted };
    });
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
      customerName: row.customerName,
      deliveryType: row.deliveryType,
      // Note: deliveryAddress is intentionally NOT returned — the customer already
      // knows their own address, and the recap is reachable by anyone holding the
      // order UUID (it can leak via history/Referer). Don't echo PII we don't need.
      econtOffice: row.econtOffice,
      slot: row.slotFrom
        ? { date: row.slotDate!, startTime: hhmm(row.slotFrom), endTime: hhmm(row.slotTo) }
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
