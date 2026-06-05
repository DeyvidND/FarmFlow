import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { and, desc, eq, getTableColumns, inArray, ne, sql } from 'drizzle-orm';
import {
  type Database,
  orders,
  orderItems,
  products,
  deliverySlots,
  tenants,
} from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { MapsService } from '../../common/maps/maps.service';
import { bgToday, bgDate } from '../../common/time/bg-time';
import { clampLimit, keysetAfter, type Paginated } from '../../common/pagination/keyset';
import { encodeCursor, decodeCursor } from '../../common/pagination/cursor';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

type OrderRow = typeof orders.$inferSelect;
type ItemRow = typeof orderItems.$inferSelect;
type SlotTimes = { slotFrom: string | null; slotTo: string | null };
type OrderWithItems = OrderRow & SlotTimes & { items: ItemRow[] };

const orderWithSlot = {
  ...getTableColumns(orders),
  slotFrom: deliverySlots.timeFrom,
  slotTo: deliverySlots.timeTo,
};

export interface ProductionItem {
  productName: string;
  totalQty: number;
  orderCount: number;
}

export interface ProductionSummary {
  date: string;
  confirmedOrders: number;
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
  deliveryType: 'address' | 'econt' | 'econt_address';
  deliveryAddress: string | null;
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
  ) {}

  /**
   * Admin list: tenant-scoped, newest first, keyset-paginated, items batched
   * (no N+1). Status/search filtering is client-side over accumulated pages, so
   * the server only paginates (no per-request filters here).
   */
  async findAll(
    tenantId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<Paginated<OrderWithItems>> {
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
    const items = await this.attachItems(pageRows);
    const last = pageRows[pageRows.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last ? encodeCursor({ createdAt: last.createdAt!, id: last.id }) : null,
    };
  }

  async findOne(id: string, tenantId: string): Promise<OrderWithItems> {
    const [row] = await this.db
      .select(orderWithSlot)
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Поръчката не е намерена');
    const [withItems] = await this.attachItems([row]);
    return withItems;
  }

  /** Cancelling frees slot capacity automatically (booked is computed from non-cancelled orders). */
  async updateStatus(id: string, tenantId: string, dto: UpdateOrderStatusDto): Promise<OrderRow> {
    const [row] = await this.db
      .update(orders)
      .set({ status: dto.status as OrderRow['status'] })
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Поръчката не е намерена');
    return row;
  }

  /**
   * Daily prep list: aggregate confirmed orders for a date into per-product
   * totals (sum qty, distinct order count), most-to-prepare first. One grouped
   * query for the rows + one scalar for the confirmed-order count (no N+1).
   */
  async production(tenantId: string, date?: string): Promise<ProductionSummary> {
    const day = date ?? bgToday();
    const onDay = and(
      eq(orders.tenantId, tenantId),
      eq(orders.status, 'confirmed'),
      sql`${bgDate(orders.createdAt)} = ${day}`,
    )!;

    const rows = await this.db
      .select({
        productName: orderItems.productName,
        totalQty: sql<number>`sum(${orderItems.quantity})::int`,
        orderCount: sql<number>`count(distinct ${orderItems.orderId})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(onDay)
      .groupBy(orderItems.productName)
      .orderBy(sql`sum(${orderItems.quantity}) desc`, orderItems.productName);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(onDay);

    return {
      date: day,
      confirmedOrders: count,
      items: rows.map((r) => ({
        productName: r.productName ?? '',
        totalQty: r.totalQty,
        orderCount: r.orderCount,
      })),
    };
  }

  /** Bulk confirm all pending orders (optionally for a single day). */
  async confirmPending(tenantId: string, date?: string): Promise<{ confirmed: number }> {
    const conds = [eq(orders.tenantId, tenantId), eq(orders.status, 'pending')];
    if (date) conds.push(sql`${bgDate(orders.createdAt)} = ${date}`);
    const rows = await this.db
      .update(orders)
      .set({ status: 'confirmed' })
      .where(and(...conds))
      .returning({ id: orders.id });
    return { confirmed: rows.length };
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
      .select({ id: tenants.id, farmLat: tenants.farmLat, farmLng: tenants.farmLng })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');

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
      deliveryAddress: row.deliveryAddress,
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
