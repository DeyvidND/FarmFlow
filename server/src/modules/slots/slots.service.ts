import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, ne, gte, lte, sql, getTableColumns } from 'drizzle-orm';
import { type Database, deliverySlots, orders, tenants } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CreateSlotDto } from './dto/create-slot.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';
import { SlotRule, slotRuleDates, normalizeRule } from './slot-rule';

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
  customerNote: string | null;
}

/** Columns the storefront may read for a slot. driverNote is intentionally absent. */
export const PUBLIC_SLOT_COLUMNS = [
  'id',
  'date',
  'startTime',
  'endTime',
  'remaining',
  'customerNote',
] as const;

@Injectable()
export class SlotsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  /**
   * Slots for the tenant with a computed `booked` (count of non-cancelled orders
   * on each slot) via a single LEFT JOIN — no N+1. Optional [from, to] date range.
   */
  async findAll(tenantId: string, from?: string, to?: string): Promise<SlotWithBooked[]> {
    await this.materializeRule(tenantId); // idempotent top-up so the rule's slots show
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
      customerNote: dto.customerNote ?? null,
      driverNote: dto.driverNote ?? null,
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
    // Explicit allow-list: a partial slot edit must not inject recurrence-only
    // keys (date range / weekdays) or the generated flag into the row.
    const patch: Record<string, unknown> = {};
    for (const k of ['timeFrom', 'timeTo', 'maxOrders', 'customerNote', 'driverNote'] as const) {
      if (dto[k] !== undefined) patch[k] = dto[k];
    }
    const [row] = await this.db
      .update(deliverySlots)
      .set(patch)
      .where(and(eq(deliverySlots.id, id), eq(deliverySlots.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Слотът не е намерен');
    return row;
  }

  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    const [row] = await this.db
      .delete(deliverySlots)
      .where(and(eq(deliverySlots.id, id), eq(deliverySlots.tenantId, tenantId)))
      .returning({
        id: deliverySlots.id,
        date: deliverySlots.date,
        generated: deliverySlots.generated,
      });
    if (!row) throw new NotFoundException('Слотът не е намерен');
    // A deleted generated slot must not be recreated by the rule on the next run.
    if (row.generated) await this.addSkipDate(tenantId, row.date);
    return { id: row.id };
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
        customerNote: deliverySlots.customerNote,
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

  // ---- Recurring slot rule (settings.slotRule) ----

  /** Today in Europe/Sofia as YYYY-MM-DD (matches the slots-page day grouping). */
  private bgToday(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Sofia',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  /** The tenant's stored rule, or null. */
  async getRule(tenantId: string): Promise<SlotRule | null> {
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const r = (row?.settings as Record<string, unknown> | null)?.slotRule;
    return (r as SlotRule) ?? null;
  }

  /**
   * Validate + persist the rule (preserving skipDates), then rebuild future
   * unbooked generated slots and materialize the horizon. Returns the saved rule.
   */
  async saveRule(tenantId: string, input: Partial<SlotRule>): Promise<SlotRule> {
    const prev = await this.getRule(tenantId);
    let rule: SlotRule;
    try {
      rule = normalizeRule(input, prev);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Невалидно правило');
    }
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['slotRule'], ${JSON.stringify(
          rule,
        )}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));

    await this.deleteFutureUnbookedGenerated(tenantId, this.bgToday());
    await this.materializeRule(tenantId);
    return rule;
  }

  /** Delete future generated slots that have no live order, so a rule edit can rebuild them. */
  private async deleteFutureUnbookedGenerated(tenantId: string, today: string): Promise<void> {
    await this.db.delete(deliverySlots).where(
      and(
        eq(deliverySlots.tenantId, tenantId),
        eq(deliverySlots.generated, true),
        gte(deliverySlots.date, today),
        sql`not exists (select 1 from ${orders} o where o.slot_id = ${deliverySlots.id} and o.status <> 'cancelled')`,
      ),
    );
  }

  /**
   * Insert any missing generated slots for the rule within its horizon. Idempotent
   * (diffs against existing generated rows in the window). Returns count inserted.
   * MUST NOT run on the public read path.
   */
  async materializeRule(tenantId: string, today = this.bgToday()): Promise<number> {
    const rule = await this.getRule(tenantId);
    if (!rule || !rule.active) return 0;
    const dates = slotRuleDates(rule, today);
    if (!dates.length) return 0;

    const existing = await this.db
      .select({ date: deliverySlots.date })
      .from(deliverySlots)
      .where(
        and(
          eq(deliverySlots.tenantId, tenantId),
          eq(deliverySlots.generated, true),
          gte(deliverySlots.date, dates[0]),
          lte(deliverySlots.date, dates[dates.length - 1]),
        ),
      );
    const have = new Set(existing.map((r) => r.date));
    const missing = dates.filter((d) => !have.has(d));
    if (missing.length) {
      await this.db.insert(deliverySlots).values(
        missing.map((date) => ({
          tenantId,
          date,
          timeFrom: rule.timeFrom,
          timeTo: rule.timeTo,
          maxOrders: rule.maxOrders,
          generated: true,
          customerNote: rule.customerNote ?? null,
          driverNote: rule.driverNote ?? null,
        })),
      );
    }
    if (rule.lastMaterializedDate !== today) {
      await this.db
        .update(tenants)
        .set({
          settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['slotRule','lastMaterializedDate'], to_jsonb(${today}::text), true)`,
        })
        .where(eq(tenants.id, tenantId));
    }
    return missing.length;
  }

  /** Append a date to the rule's skipDates so the generator won't recreate it. */
  private async addSkipDate(tenantId: string, date: string): Promise<void> {
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(
          coalesce(${tenants.settings}, '{}'::jsonb),
          array['slotRule','skipDates'],
          coalesce(${tenants.settings} -> 'slotRule' -> 'skipDates', '[]'::jsonb) || to_jsonb(${date}::text),
          true
        )`,
      })
      .where(eq(tenants.id, tenantId));
  }

  /** Daily 06:30 Europe/Sofia: roll every active rule's horizon forward. */
  @Cron('30 6 * * *', { timeZone: 'Europe/Sofia' })
  async materializeAllRules(): Promise<void> {
    const rows = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`${tenants.settings} -> 'slotRule' ->> 'active' = 'true'`);
    for (const t of rows) {
      try {
        await this.materializeRule(t.id);
      } catch {
        // one tenant's bad rule must not stop the others
      }
    }
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
