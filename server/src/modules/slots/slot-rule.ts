/**
 * The single recurring self-delivery rule, stored at settings.slotRule. Pure
 * date math + validation — no db. The generator (slots.service) turns the
 * GenSlots this produces into concrete `generated` day-rows: ONE slot row per
 * delivery date, whose `capacity` is the day's order ceiling. Time windows are
 * gone — the farmer plans the day as a whole and the route optimizer picks the
 * driving order.
 */
/** A day stops being pickable (storefront) and bookable (order creation) as
 *  soon as it starts — the last chance to book Thursday is Wednesday. The farm
 *  needs a full day's lead time to plan the route/prep. */

export interface SlotDay {
  dow: number; // 0=Sun..6=Sat
  capacity: number; // max orders that day
}

export interface SlotRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  days: SlotDay[]; // weekdays mode — per-day capacity
  intervalDays: number; // >=1, for repeat:'interval'
  intervalCapacity: number; // interval mode — one capacity
  anchorDate: string; // YYYY-MM-DD; interval counts from here; also a lower bound
  customerNote?: string;
  driverNote?: string;
  horizonDays: number; // how far ahead to keep filled
  skipDates: string[]; // dates the farmer closed — never regenerate
  lastMaterializedDate?: string;
}

/** One concrete delivery day the rule wants to exist. */
export interface GenSlot {
  date: string; // YYYY-MM-DD
  capacity: number;
}

/** Add `n` days to an ISO date (UTC-stable, no TZ drift). */
export function isoAddDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isoMax = (a: string, b: string) => (a >= b ? a : b);

const hhmmToMin = (t: string) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);

/** Clamp an incoming capacity to an integer in [1,500]; undefined/0/negative → 1. */
export function clampCapacity(n: number | undefined): number {
  const v = Math.floor(n ?? 1);
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(500, v);
}

/** A day is full when its live booked count reaches its (clamped) capacity. */
export function slotIsFull(booked: number, capacity: number): boolean {
  return booked >= clampCapacity(capacity);
}

/** Why a slot can't accept a *public* booking, or null when it can (capacity is
 *  checked separately by the caller once it has the live booked count). `today` is
 *  BG-local YYYY-MM-DD. Today is never bookable (the farm needs a day's lead time).
 *  A hidden slot (`is_active=false` — e.g. a day that only holds rescheduled orders,
 *  or a day the farmer closed) is never publicly bookable when `requireActive` is
 *  set; admin paths pass `requireActive=false` so they can still reassign onto it. */
export function slotUnavailableReason(
  slot: { date: string; isActive: boolean | null },
  opts: { today: string; requireActive: boolean },
): 'today' | 'inactive' | null {
  if (slot.date === opts.today) return 'today';
  // Mirror findPublicBySlug's `is_active = true` filter: only an explicitly active
  // slot is publicly bookable (null/false are hidden).
  if (opts.requireActive && slot.isActive !== true) return 'inactive';
  return null;
}

/** Does the recurring rule genuinely offer this exact date? Weekday/interval
 *  membership + anchor lower-bound + skipDates, independent of the materialization
 *  horizon. Used to decide whether a reschedule target is a real offered day (leave
 *  it public) or just a holding day for moved orders (hide it). Inactive rule →
 *  false. `date` is YYYY-MM-DD. */
export function ruleProducesDate(rule: SlotRule, date: string): boolean {
  if (!rule.active) return false;
  if (rule.anchorDate && date < rule.anchorDate) return false;
  if ((rule.skipDates ?? []).includes(date)) return false;
  if (rule.repeat === 'weekdays') {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    return (rule.days ?? []).some((d) => d.dow === dow);
  }
  // interval mode: date must sit exactly on an anchor + k·intervalDays step.
  const ms = Date.parse(`${date}T00:00:00Z`) - Date.parse(`${rule.anchorDate}T00:00:00Z`);
  if (!Number.isFinite(ms) || ms < 0) return false;
  const n = Math.max(1, Math.floor(rule.intervalDays || 1));
  return Math.round(ms / 86_400_000) % n === 0;
}

/** Windowed-era day shape (pre day-capacity): hours per weekday. */
interface WindowedDay {
  dow: number;
  timeFrom?: string;
  timeTo?: string;
}
/** Every historical rule shape this code has ever stored. */
interface AnyStoredRule extends Partial<Omit<SlotRule, 'days'>> {
  days?: (SlotDay | WindowedDay)[];
  // windowed era:
  intervalWindow?: { timeFrom?: string; timeTo?: string };
  slotMinutes?: number;
  defaultCapacity?: number;
  // legacy (global window) era:
  weekdays?: number[];
  timeFrom?: string;
  timeTo?: string;
  maxOrders?: number;
}

/** How many whole `slotMinutes` chunks fit a window; 1 when unset/too short. */
function windowSubslots(win: { timeFrom?: string; timeTo?: string }, slotMinutes: number): number {
  if (!slotMinutes || slotMinutes <= 0) return 1;
  if (!win.timeFrom || !win.timeTo) return 1;
  const span = hhmmToMin(win.timeTo) - hhmmToMin(win.timeFrom);
  return span >= slotMinutes ? Math.floor(span / slotMinutes) : 1;
}

/**
 * Upgrade any stored rule to the day-capacity shape. Windowed rules convert
 * honestly: a day that produced K sub-slots of capacity C becomes capacity K×C.
 * Idempotent — a current rule passes through unchanged. Null in → null out.
 */
export function migrateRule(raw: unknown): SlotRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as AnyStoredRule;

  const isCurrent =
    Array.isArray(r.days) &&
    r.days.every((d) => typeof (d as SlotDay).capacity === 'number') &&
    typeof r.intervalCapacity === 'number' &&
    r.intervalWindow === undefined &&
    r.slotMinutes === undefined;
  if (isCurrent) return r as SlotRule;

  const slotMinutes = Math.max(0, Math.floor(r.slotMinutes ?? 0));
  const perSlotCap = clampCapacity(r.defaultCapacity);

  // Windowed days (or legacy weekdays[] + global window) → per-day capacity.
  const sourceDays: WindowedDay[] = Array.isArray(r.days)
    ? (r.days as WindowedDay[])
    : (r.weekdays ?? []).map((dow) => ({ dow, timeFrom: r.timeFrom, timeTo: r.timeTo }));
  const days: SlotDay[] = sourceDays.map((d) => ({
    dow: d.dow,
    capacity:
      typeof (d as SlotDay).capacity === 'number'
        ? clampCapacity((d as SlotDay).capacity)
        : clampCapacity(windowSubslots(d, slotMinutes) * perSlotCap),
  }));

  const intervalCapacity =
    typeof r.intervalCapacity === 'number'
      ? clampCapacity(r.intervalCapacity)
      : clampCapacity(windowSubslots(r.intervalWindow ?? {}, slotMinutes) * perSlotCap);

  return {
    active: r.active !== false,
    repeat: r.repeat === 'interval' ? 'interval' : 'weekdays',
    days,
    intervalDays: Math.max(1, Math.floor(r.intervalDays ?? 1)),
    intervalCapacity,
    anchorDate: r.anchorDate ?? '',
    customerNote: r.customerNote,
    driverNote: r.driverNote,
    horizonDays: r.horizonDays ?? 28,
    skipDates: r.skipDates ?? [],
    lastMaterializedDate: r.lastMaterializedDate,
  };
}

/**
 * The delivery days the rule should produce within
 * [max(today, anchor) … today+horizon], minus skipDates. One GenSlot per date.
 * Returns [] for an inactive rule.
 */
export function slotRuleSlots(rule: SlotRule, today: string): GenSlot[] {
  if (!rule.active) return [];
  const start = isoMax(today, rule.anchorDate);
  const end = isoAddDays(today, Math.max(0, rule.horizonDays));
  if (start > end) return [];
  const skip = new Set(rule.skipDates ?? []);
  const out: GenSlot[] = [];

  if (rule.repeat === 'weekdays') {
    const byDow = new Map<number, number>();
    for (const d of rule.days ?? []) byDow.set(d.dow, clampCapacity(d.capacity));
    if (byDow.size === 0) return [];
    for (let iso = start; iso <= end; iso = isoAddDays(iso, 1)) {
      const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
      const cap = byDow.get(dow);
      if (cap !== undefined && !skip.has(iso)) out.push({ date: iso, capacity: cap });
    }
  } else {
    const cap = clampCapacity(rule.intervalCapacity);
    const n = Math.max(1, Math.floor(rule.intervalDays || 1));
    let iso = rule.anchorDate;
    let guard = 0;
    while (iso < start && guard++ < 4000) iso = isoAddDays(iso, n);
    for (; iso <= end; iso = isoAddDays(iso, n)) {
      if (!skip.has(iso)) out.push({ date: iso, capacity: cap });
    }
  }
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate + clamp an incoming rule, preserving server-owned fields (skipDates)
 * from the previous stored rule. Accepts older shapes too (auto-migrated).
 * Throws Error('<bg message>') on invalid input; the service maps it to
 * BadRequestException.
 */
export function normalizeRule(input: unknown, prev?: SlotRule | null): SlotRule {
  const migrated = migrateRule(input);
  if (!migrated) throw new Error('Невалидно правило');
  const repeat = migrated.repeat === 'interval' ? 'interval' : 'weekdays';
  const anchorDate = migrated.anchorDate ?? '';
  if (!ISO.test(anchorDate)) throw new Error('Невалидна начална дата');

  // Dedupe by dow (last wins), clamp capacities, week-sort.
  const byDow = new Map<number, SlotDay>();
  for (const d of migrated.days ?? []) {
    if (!Number.isInteger(d?.dow) || d.dow < 0 || d.dow > 6) continue;
    byDow.set(d.dow, { dow: d.dow, capacity: clampCapacity(d.capacity) });
  }
  const days = [...byDow.values()].sort((a, b) => a.dow - b.dow);
  if (repeat === 'weekdays' && days.length === 0) {
    throw new Error('Избери поне един ден от седмицата');
  }

  return {
    active: migrated.active !== false,
    repeat,
    days,
    intervalDays: Math.max(1, Math.floor(migrated.intervalDays ?? 1)),
    intervalCapacity: clampCapacity(migrated.intervalCapacity),
    anchorDate,
    customerNote: migrated.customerNote?.slice(0, 280) || undefined,
    driverNote: migrated.driverNote?.slice(0, 500) || undefined,
    horizonDays: Math.min(60, Math.max(1, Math.floor(migrated.horizonDays ?? 28))),
    skipDates: prev?.skipDates ?? [],
    lastMaterializedDate: undefined,
  };
}
