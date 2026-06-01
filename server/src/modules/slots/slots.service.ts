import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, eq, ne, gte, lte, sql, getTableColumns } from 'drizzle-orm';
import { type Database, deliverySlots, orders, tenants } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CreateSlotDto } from './dto/create-slot.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';

/** A delivery slot plus its live `booked` count (non-cancelled orders). */
type SlotWithBooked = typeof deliverySlots.$inferSelect & { booked: number };

/**
 * Public-facing slot shape for the storefront picker. Internal columns
 * (`tenantId`, `maxOrders`, `currentOrders`, `isActive`, `createdAt`) are
 * dropped; times are trimmed `HH:MM` and `remaining` is precomputed.
 */
export interface PublicSlot {
  id: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  remaining: number;
}

@Injectable()
export class SlotsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  /**
   * Slots for the tenant with a computed `booked` (count of non-cancelled orders
   * on each slot) via a single LEFT JOIN — no N+1. Optional [from, to] date range.
   */
  findAll(tenantId: string, from?: string, to?: string): Promise<SlotWithBooked[]> {
    const filters = [eq(deliverySlots.tenantId, tenantId)];
    if (from) filters.push(gte(deliverySlots.date, from));
    if (to) filters.push(lte(deliverySlots.date, to));

    return this.db
      .select({
        ...getTableColumns(deliverySlots),
        booked: sql<number>`count(${orders.id})::int`,
      })
      .from(deliverySlots)
      .leftJoin(
        orders,
        and(eq(orders.slotId, deliverySlots.id), ne(orders.status, 'cancelled')),
      )
      .where(and(...filters))
      .groupBy(deliverySlots.id)
      .orderBy(deliverySlots.date, deliverySlots.timeFrom);
  }

  /** Single slot, or bulk across a date range + weekday pattern. */
  async create(tenantId: string, dto: CreateSlotDto) {
    const base = {
      tenantId,
      timeFrom: dto.timeFrom,
      timeTo: dto.timeTo,
      maxOrders: dto.maxOrders,
    };

    if (dto.dateTo && dto.weekdays?.length) {
      const dates = expandDates(dto.date, dto.dateTo, dto.weekdays);
      if (!dates.length) {
        throw new BadRequestException('Няма дати, отговарящи на избраните дни');
      }
      return this.db
        .insert(deliverySlots)
        .values(dates.map((date) => ({ ...base, date })))
        .returning();
    }

    const [row] = await this.db
      .insert(deliverySlots)
      .values({ ...base, date: dto.date })
      .returning();
    return row;
  }

  async update(id: string, tenantId: string, dto: UpdateSlotDto) {
    const [row] = await this.db
      .update(deliverySlots)
      .set({ ...dto })
      .where(and(eq(deliverySlots.id, id), eq(deliverySlots.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Слотът не е намерен');
    return row;
  }

  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    const [row] = await this.db
      .delete(deliverySlots)
      .where(and(eq(deliverySlots.id, id), eq(deliverySlots.tenantId, tenantId)))
      .returning({ id: deliverySlots.id });
    if (!row) throw new NotFoundException('Слотът не е намерен');
    return row;
  }

  /**
   * Public: slots for a storefront slug that still have remaining capacity.
   * Returns the trimmed {@link PublicSlot} shape — internal columns and the
   * tenant id are never exposed to the storefront.
   */
  async findPublicBySlug(slug: string, date?: string): Promise<PublicSlot[]> {
    const [tenant] = await this.db
      .select({ id: tenants.id, deliveryEnabled: tenants.deliveryEnabled })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');
    // Farm hasn't enabled self-delivery → storefront offers no slots.
    if (!tenant.deliveryEnabled) return [];

    const filters = [eq(deliverySlots.tenantId, tenant.id), eq(deliverySlots.isActive, true)];
    if (date) filters.push(eq(deliverySlots.date, date));

    return this.db
      .select({
        id: deliverySlots.id,
        date: deliverySlots.date,
        // pg `time` serializes as HH:MM:SS — trim to HH:MM for the UI.
        startTime: sql<string>`substring(${deliverySlots.timeFrom}::text from 1 for 5)`,
        endTime: sql<string>`substring(${deliverySlots.timeTo}::text from 1 for 5)`,
        remaining: sql<number>`(${deliverySlots.maxOrders} - count(${orders.id}))::int`,
      })
      .from(deliverySlots)
      .leftJoin(
        orders,
        and(eq(orders.slotId, deliverySlots.id), ne(orders.status, 'cancelled')),
      )
      .where(and(...filters))
      .groupBy(deliverySlots.id)
      .having(sql`${deliverySlots.maxOrders} - count(${orders.id}) > 0`)
      .orderBy(deliverySlots.date, deliverySlots.timeFrom);
  }
}

/** Inclusive list of ISO dates in [from, to] whose weekday is in `weekdays` (0=Sun..6=Sat). */
function expandDates(from: string, to: string, weekdays: number[]): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new BadRequestException('Невалиден диапазон от дати');
  }
  const want = new Set(weekdays);
  const out: string[] = [];
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (want.has(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
    if (out.length > 366) throw new BadRequestException('Диапазонът е твърде голям');
  }
  return out;
}
