import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { and, desc, eq, getTableColumns, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import {
  type Database,
  orders,
  orderItems,
  products,
  deliverySlots,
  tenants,
} from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
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

interface OrderFilters {
  date?: string;
  status?: string;
  deliveryType?: string;
  search?: string;
}

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
  status: string;
  paidAt: string | null;
  totalStotinki: number;
  customerName: string | null;
  deliveryType: 'address' | 'econt';
  deliveryAddress: string | null;
  econtOffice: string | null;
  slot: { date: string; startTime: string; endTime: string } | null;
  items: { name: string; quantity: number; priceStotinki: number }[];
  createdAt: string | null;
}

@Injectable()
export class OrdersService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  /** Admin list: tenant-scoped, filterable, newest first, items batched (no N+1). */
  async findAll(tenantId: string, filters: OrderFilters = {}): Promise<OrderWithItems[]> {
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

    if (filters.status) {
      conds.push(eq(orders.status, filters.status as NonNullable<OrderRow['status']>));
    }
    if (filters.deliveryType) {
      conds.push(eq(orders.deliveryType, filters.deliveryType as OrderRow['deliveryType']));
    }
    if (filters.date) conds.push(sql`${orders.createdAt}::date = ${filters.date}`);
    if (filters.search) {
      const q = `%${filters.search}%`;
      const searchCond = or(ilike(orders.customerName, q), sql`${orders.id}::text ilike ${q}`);
      if (searchCond) conds.push(searchCond);
    }

    const rows = await this.db
      .select(orderWithSlot)
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(and(...conds)!)
      .orderBy(desc(orders.createdAt));

    return this.attachItems(rows);
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
    const day = date ?? new Date().toISOString().slice(0, 10);
    const onDay = and(
      eq(orders.tenantId, tenantId),
      eq(orders.status, 'confirmed'),
      sql`${orders.createdAt}::date = ${day}`,
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
    if (date) conds.push(sql`${orders.createdAt}::date = ${date}`);
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
    return this.db.transaction(async (tx) => {
      const [tenant] = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .limit(1);
      if (!tenant) throw new NotFoundException('Фермата не е намерена');

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

      const slotId = dto.slotId ?? null;
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

      const isEcont = dto.deliveryType === 'econt';
      const [order] = await tx
        .insert(orders)
        .values({
          tenantId: tenant.id,
          customerName: dto.customerName,
          customerPhone: dto.customerPhone,
          customerEmail: dto.customerEmail,
          slotId,
          status: 'pending',
          totalStotinki: total,
          deliveryType: dto.deliveryType ?? 'address',
          deliveryAddress: isEcont ? null : dto.deliveryAddress ?? null,
          econtOffice: isEcont ? dto.econtOffice ?? null : null,
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
