import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, eq, ne, gte, lte, sql, getTableColumns, inArray } from 'drizzle-orm';
import { type Database, deliverySlots, orders, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { CreateSlotDto } from './dto/create-slot.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';
import { SlotRule, slotRuleSlots, normalizeRule, migrateRule, clampCapacity } from './slot-rule';

/** A delivery slot plus its live `booked` count (non-cancelled orders). */
type SlotWithBooked = typeof deliverySlots.$inferSelect & { booked: number };

/**
 * Public-facing slot shape for the storefront picker. Internal columns
 * (`tenantId`, `isActive`, `createdAt`) are dropped. `startTime`/`endTime` are
 * `null` for day-rows (the common case since migration 0081 — a slot is a
 * whole delivery day, no time window); non-null only for legacy pre-0081 rows
 * that still carry hours. Only slots with remaining capacity (booked <
 * capacity) are returned. `remaining` = free spots left, BUT only for
 * multi-capacity slots (>1) — a single-capacity slot sends null so the
 * storefront shows no "N places left" noise and the raw capacity number is
 * still never exposed for the common case.
 */
export interface PublicSlot {
  id: string;
  date: string; // YYYY-MM-DD
  startTime: string | null; // HH:MM, null for day-rows
  endTime: string | null; // HH:MM, null for day-rows
  customerNote: string | null;
  /** Free spots left on a multi-capacity slot (>=1), or null for capacity-1 slots. */
  remaining: number | null;
}

/** Columns the storefront may read for a slot. driverNote is intentionally absent. */
export const PUBLIC_SLOT_COLUMNS = [
  'id',
  'date',
  'startTime',
  'endTime',
  'customerNote',
  'remaining',
] as const;

@Injectable()
export class SlotsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly publicCache: PublicCacheService,
  ) {}

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
      .orderBy(deliverySlots.date);
  }

  /** Single day-row, or bulk across a date range + weekday pattern. */
  async create(tenantId: string, dto: CreateSlotDto) {
    const base = {
      tenantId,
      capacity: clampCapacity(dto.capacity),
      customerNote: dto.customerNote ?? null,
      driverNote: dto.driverNote ?? null,
    };

    if (dto.dateTo && dto.weekdays?.length) {
      const dates = expandDates(dto.date, dto.dateTo, dto.weekdays);
      if (!dates.length) {
        throw new BadRequestException('Няма дати, отговарящи на избраните дни');
      }
      // Bulk: a date that already has a day-row keeps it untouched — silently
      // skipped rather than erroring out the whole range.
      const existingRows = await this.db
        .select({ date: deliverySlots.date })
        .from(deliverySlots)
        .where(and(eq(deliverySlots.tenantId, tenantId), inArray(deliverySlots.date, dates)));
      const existingDates = new Set(existingRows.map((r) => r.date));
      const toInsert = dates.filter((d) => !existingDates.has(d));
      if (!toInsert.length) return [];
      return this.db
        .insert(deliverySlots)
        .values(toInsert.map((date) => ({ ...base, date })))
        .returning();
    }

    // One day-row per (tenant, date) — a second create() on an already-open day
    // must not silently double the day up; the farmer edits the existing row's
    // capacity via update() instead.
    const [existing] = await this.db
      .select({ id: deliverySlots.id })
      .from(deliverySlots)
      .where(and(eq(deliverySlots.tenantId, tenantId), eq(deliverySlots.date, dto.date)))
      .limit(1);
    if (existing) {
      throw new BadRequestException('Този ден вече е отворен — редактирай капацитета му');
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
    for (const k of ['capacity', 'customerNote', 'driverNote'] as const) {
      if (dto[k] !== undefined) patch[k] = k === 'capacity' ? clampCapacity(dto.capacity) : dto[k];
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
    // Verify ownership first (tenant-scoped) so a busy-slot 400 can't leak another
    // tenant's data — a foreign id just 404s.
    const [slot] = await this.db
      .select({
        id: deliverySlots.id,
        date: deliverySlots.date,
        generated: deliverySlots.generated,
      })
      .from(deliverySlots)
      .where(and(eq(deliverySlots.id, id), eq(deliverySlots.tenantId, tenantId)))
      .limit(1);
    if (!slot) throw new NotFoundException('Слотът не е намерен');

    // Refuse to delete a slot that still holds a live (non-cancelled) order —
    // silently dropping a customer's booked delivery is not this button's job
    // (mirrors closeDay). The farmer cancels or moves the order first. A raw delete
    // here would also blow up on the orders.slot_id FK with a 500. Cancelled orders
    // are detached automatically by the FK's ON DELETE SET NULL, so the delete below
    // can't FK-fail.
    const [live] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.slotId, id), ne(orders.status, 'cancelled')));
    if ((live?.n ?? 0) > 0) {
      throw new BadRequestException(
        'Слотът има активна поръчка — отменете или преместете поръчката, преди да изтриете слота',
      );
    }

    await this.db
      .delete(deliverySlots)
      .where(and(eq(deliverySlots.id, id), eq(deliverySlots.tenantId, tenantId)));
    // A deleted generated slot must not be recreated by the rule on the next run.
    if (slot.generated) await this.addSkipDate(tenantId, slot.date);
    return { id: slot.id };
  }

  /**
   * Close one calendar day ("няма да доставям на 15.06"): delete every slot on
   * that date that has no live order, and add the date to the rule's skipDates
   * so the generator never recreates it. Slots holding live orders are KEPT —
   * silently dropping a customer's booked delivery is not this button's job;
   * the farmer resolves those orders first, then the day can be fully closed.
   * The farmer can still add one-off manual slots on a closed day (e.g. "ще
   * доставям, но в други часове").
   */
  async closeDay(
    tenantId: string,
    date: string,
  ): Promise<{ date: string; removed: number; kept: number }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Невалидна дата');
    const removed = await this.db
      .delete(deliverySlots)
      .where(
        and(
          eq(deliverySlots.tenantId, tenantId),
          eq(deliverySlots.date, date),
          sql`not exists (select 1 from ${orders} o where o.slot_id = ${deliverySlots.id} and o.status <> 'cancelled')`,
        ),
      )
      .returning({ id: deliverySlots.id });
    const [keptRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliverySlots)
      .where(and(eq(deliverySlots.tenantId, tenantId), eq(deliverySlots.date, date)));
    // Only mark skipDates when a rule actually exists — jsonb_set would otherwise
    // plant a partial slotRule blob on a farm that never configured one.
    if (await this.getRule(tenantId)) await this.addSkipDate(tenantId, date);
    return { date, removed: removed.length, kept: keptRow?.count ?? 0 };
  }

  /** Reopen a closed day: pull it from skipDates and let the rule refill it now. */
  async openDay(tenantId: string, date: string): Promise<{ date: string; created: number }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Невалидна дата');
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(
          coalesce(${tenants.settings}, '{}'::jsonb),
          array['slotRule','skipDates'],
          coalesce(${tenants.settings} -> 'slotRule' -> 'skipDates', '[]'::jsonb) - ${date}::text,
          true
        )`,
      })
      .where(eq(tenants.id, tenantId));
    const created = await this.materializeRule(tenantId, this.bgToday(), true);
    return { date, created };
  }

  /**
   * Public: slots for a storefront slug that still have remaining capacity.
   * Returns the trimmed {@link PublicSlot} shape — internal columns and the
   * tenant id are never exposed to the storefront.
   */
  async findPublicBySlug(
    slug: string,
    opts: { date?: string; from?: string; to?: string } = {},
  ): Promise<PublicSlot[]> {
    // Shared Redis slug→tenant resolver (deliveryEnabled rides on TenantMeta) — no
    // Postgres tenant lookup on this hot, short-TTL checkout path.
    const tenant = await this.publicCache.resolveTenant(this.db, slug);
    // Farm hasn't enabled self-delivery → storefront offers no slots.
    if (!tenant.deliveryEnabled) return [];

    const { date, from, to } = opts;
    const filters = [eq(deliverySlots.tenantId, tenant.id), eq(deliverySlots.isActive, true)];
    if (date) {
      // Single-day (legacy `?date=`) request.
      filters.push(eq(deliverySlots.date, date));
    } else {
      // Ranged (or open) request: always bound below by today so the query can't
      // return the farm's entire (ever-growing) slot history. The picker sends one
      // ranged request for its whole window instead of one-request-per-day.
      // A caller-supplied `from` can only narrow this floor, never widen it below
      // today — otherwise an older `from` (or a UTC/Sofia calendar-date mismatch
      // right around midnight) would leak past slot history on this public,
      // unauthenticated endpoint. YYYY-MM-DD strings compare lexically, so a plain
      // string max is enough.
      const floor = this.bgToday();
      filters.push(gte(deliverySlots.date, from && from > floor ? from : floor));
      if (to) filters.push(lte(deliverySlots.date, to));
    }

    const rows = await this.db
      .select({
        id: deliverySlots.id,
        date: deliverySlots.date,
        // pg `time` serializes as HH:MM:SS — trim to HH:MM for the UI. NULL on a
        // day-row (no time window) substrings to NULL, which is exactly what we want.
        startTime: sql<string | null>`substring(${deliverySlots.timeFrom}::text from 1 for 5)`,
        endTime: sql<string | null>`substring(${deliverySlots.timeTo}::text from 1 for 5)`,
        customerNote: deliverySlots.customerNote,
        // Free spots left — only for multi-capacity slots (>1); single-capacity
        // slots send null so the picker shows no count and the raw capacity of a
        // normal one-order slot is never disclosed.
        remaining: sql<number | null>`case when ${deliverySlots.capacity} > 1
          then (${deliverySlots.capacity} - count(${orders.id}))::int
          else null end`,
      })
      .from(deliverySlots)
      .leftJoin(
        orders,
        and(eq(orders.slotId, deliverySlots.id), ne(orders.status, 'cancelled')),
      )
      .where(and(...filters))
      .groupBy(deliverySlots.id, deliverySlots.capacity)
      // A slot shows while its live order count is below its capacity.
      .having(sql`count(${orders.id}) < ${deliverySlots.capacity}`)
      .orderBy(deliverySlots.date);

    // Today is never pickable — the farm needs a full day's lead time to plan
    // the day's route/prep, so the last chance to book a day's slot is the day
    // before it.
    const today = this.bgToday();
    return rows.filter((r) => r.date !== today);
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
    return r ? migrateRule(r as Partial<SlotRule>) : null;
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
    const [row] = await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['slotRule'], ${JSON.stringify(
          rule,
        )}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId))
      .returning({ slug: tenants.slug });

    // The public `tenant:{slug}` cache bakes `ownSlots` (the checkout self-delivery
    // schedule text + active flag) from slotRule — bust it or the storefront shows
    // the OLD delivery day/active-state for up to PUBLIC_CACHE_TTL after a save.
    if (row) await this.publicCache.del(publicCacheKeys.tenant(row.slug));

    // A rule edit that only changes capacity (or anything else) must still reach
    // future days: delete-then-rebuild is how that propagates, since
    // materializeRule only fills gaps rather than updating existing rows. A
    // future generated row that already holds a live order is NOT deleted (see
    // deleteFutureUnbookedGenerated's `not exists ... orders` guard) — its
    // capacity is left as-is; the farmer edits that one day manually if needed.
    await this.deleteFutureUnbookedGenerated(tenantId, this.bgToday());
    await this.materializeRule(tenantId, this.bgToday(), true); // force rebuild
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
   * (diffs against ALL existing rows in the window — a manual day-row suppresses
   * the rule's row for that date). Returns count inserted.
   * MUST NOT run on the public read path.
   */
  async materializeRule(tenantId: string, today = this.bgToday(), force = false): Promise<number> {
    const rule = await this.getRule(tenantId);
    if (!rule || !rule.active) return 0;
    // Already topped-up today and not a forced rebuild → the horizon dates are
    // identical within the same calendar day, so nothing can be missing. Skip the
    // existing-slots diff query. This path runs on EVERY admin slots/delivery page
    // load (via findAll); the short-circuit saves a query per load. saveRule passes
    // force=true (it just deleted future generated slots and must recreate them).
    if (!force && rule.lastMaterializedDate === today) return 0;
    const wanted = slotRuleSlots(rule, today);
    if (!wanted.length) return 0;

    const existing = await this.db
      .select({
        date: deliverySlots.date,
      })
      .from(deliverySlots)
      .where(
        and(
          eq(deliverySlots.tenantId, tenantId),
          gte(deliverySlots.date, wanted[0].date),
          lte(deliverySlots.date, wanted[wanted.length - 1].date),
        ),
      );
    // One GenSlot per date now (no more per-window sub-slots), so the diff keys
    // on date alone — and against ANY row on the date, not just generated ones:
    // a manual (generated=false) day-row suppresses the rule's row for that date,
    // preserving the one-day-row-per-(tenant,date) invariant that create()'s
    // duplicate guard establishes. A rule edit that changes a day's capacity is
    // handled by the force-rebuild path (saveRule deletes future unbooked
    // generated rows first), not by this diff.
    const have = new Set(existing.map((r) => r.date));
    const missing = wanted.filter((w) => !have.has(w.date));
    if (missing.length) {
      await this.db.insert(deliverySlots).values(
        missing.map((w) => ({
          tenantId,
          date: w.date,
          generated: true,
          capacity: w.capacity,
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
  async materializeAllRules(): Promise<void> {
    const rows = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`${tenants.settings} -> 'slotRule' ->> 'active' = 'true'`);
    // Process in bounded-concurrency chunks: materialization is independent per
    // tenant, so a handful run together (faster than strictly sequential) without
    // flooding the connection pool. allSettled keeps one tenant's bad rule from
    // aborting the rest.
    const CHUNK = 10;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await Promise.allSettled(rows.slice(i, i + CHUNK).map((t) => this.materializeRule(t.id)));
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
