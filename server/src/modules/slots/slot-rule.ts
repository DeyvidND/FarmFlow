/**
 * The single recurring self-delivery rule, stored at settings.slotRule. Pure
 * date math + validation — no db. The generator (slots.service) turns the slots
 * this produces into concrete `generated` slot rows.
 *
 * weekdays mode carries a per-weekday window (its own hours + capacity), so a
 * farmer can deliver Mon 10–12 cap 5 but Wed 16–18 cap 3, and skip the rest.
 * interval mode ("every N days") has no per-day concept, so it uses one window.
 */
export interface SlotWindow {
  timeFrom: string; // HH:MM
  timeTo: string; // HH:MM
  maxOrders: number;
}

export interface SlotDay extends SlotWindow {
  dow: number; // 0=Sun..6=Sat
}

export interface SlotRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  days: SlotDay[]; // weekdays mode — one window per picked weekday
  intervalDays: number; // >=1, for repeat:'interval'
  intervalWindow: SlotWindow; // interval mode — single window
  anchorDate: string; // YYYY-MM-DD; interval counts from here; also a lower bound
  customerNote?: string;
  driverNote?: string;
  horizonDays: number; // how far ahead to keep filled
  skipDates: string[]; // dates the farmer deleted — never regenerate
  lastMaterializedDate?: string;
}

/** One concrete slot the rule wants to exist on a date. */
export interface GenSlot {
  date: string; // YYYY-MM-DD
  timeFrom: string; // HH:MM
  timeTo: string; // HH:MM
  maxOrders: number;
}

/** Add `n` days to an ISO date (UTC-stable, no TZ drift). */
export function isoAddDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isoMax = (a: string, b: string) => (a >= b ? a : b);

/**
 * The legacy rule shape (single global window across all weekdays). Stored rules
 * created before per-weekday windows still have this shape in settings.slotRule.
 */
interface LegacyRule {
  weekdays?: number[];
  timeFrom?: string;
  timeTo?: string;
  maxOrders?: number;
}

/**
 * Upgrade a stored rule to the current shape. A legacy rule (no `days`) is
 * converted: its global window becomes every weekday's window, and the interval
 * window. Idempotent — a current rule passes through unchanged. Returns the input
 * unchanged when it is null/undefined.
 */
export function migrateRule(raw: (Partial<SlotRule> & LegacyRule) | null | undefined): SlotRule | null {
  if (!raw) return null;
  if (Array.isArray(raw.days) && raw.intervalWindow) return raw as SlotRule;
  const win: SlotWindow = {
    timeFrom: raw.timeFrom ?? '10:00',
    timeTo: raw.timeTo ?? '12:00',
    maxOrders: typeof raw.maxOrders === 'number' ? raw.maxOrders : 5,
  };
  const days: SlotDay[] = Array.isArray(raw.days)
    ? raw.days
    : (raw.weekdays ?? []).map((dow) => ({ dow, ...win }));
  return { ...raw, days, intervalWindow: raw.intervalWindow ?? win } as SlotRule;
}

/**
 * The concrete slots the rule should produce within
 * [max(today, anchor) … today+horizon], minus skipDates. One slot per date.
 * Bounded to 366 results. Returns [] for an inactive rule.
 */
export function slotRuleSlots(rule: SlotRule, today: string): GenSlot[] {
  if (!rule.active) return [];
  const start = isoMax(today, rule.anchorDate);
  const end = isoAddDays(today, Math.max(0, rule.horizonDays));
  if (start > end) return [];
  const skip = new Set(rule.skipDates ?? []);
  const out: GenSlot[] = [];

  if (rule.repeat === 'weekdays') {
    const byDow = new Map<number, SlotWindow>();
    for (const d of rule.days ?? []) byDow.set(d.dow, d);
    if (byDow.size === 0) return [];
    for (let iso = start; iso <= end; iso = isoAddDays(iso, 1)) {
      const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
      const win = byDow.get(dow);
      if (win && !skip.has(iso)) {
        out.push({ date: iso, timeFrom: win.timeFrom, timeTo: win.timeTo, maxOrders: win.maxOrders });
      }
      if (out.length >= 366) break;
    }
  } else {
    const win = rule.intervalWindow;
    const n = Math.max(1, Math.floor(rule.intervalDays || 1));
    let iso = rule.anchorDate;
    let guard = 0;
    while (iso < start && guard++ < 4000) iso = isoAddDays(iso, n);
    for (; iso <= end; iso = isoAddDays(iso, n)) {
      if (!skip.has(iso)) {
        out.push({ date: iso, timeFrom: win.timeFrom, timeTo: win.timeTo, maxOrders: win.maxOrders });
      }
      if (out.length >= 366) break;
    }
  }
  return out;
}

const HHMM = /^\d{2}:\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Validate + clamp one window. Throws Error('<bg message>') on invalid input. */
function normalizeWindow(input: Partial<SlotWindow> | undefined, where: string): SlotWindow {
  const timeFrom = input?.timeFrom ?? '';
  const timeTo = input?.timeTo ?? '';
  const maxOrders = Math.floor(input?.maxOrders ?? 0);
  if (!HHMM.test(timeFrom) || !HHMM.test(timeTo)) throw new Error(`Часът трябва да е ЧЧ:ММ${where}`);
  if (timeTo <= timeFrom) throw new Error(`Краят трябва да е след началото${where}`);
  if (maxOrders < 1) throw new Error(`Капацитетът трябва да е поне 1${where}`);
  return { timeFrom, timeTo, maxOrders };
}

const BG_WD = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

/**
 * Validate + clamp an incoming rule, preserving server-owned fields (skipDates)
 * from the previous stored rule. Accepts the legacy shape too (auto-migrated).
 * Throws Error('<bg message>') on invalid input; the service maps it to
 * BadRequestException.
 */
export function normalizeRule(input: Partial<SlotRule> & LegacyRule, prev?: SlotRule | null): SlotRule {
  const migrated = migrateRule(input) as SlotRule;
  const repeat = migrated.repeat === 'interval' ? 'interval' : 'weekdays';
  const intervalDays = Math.max(1, Math.floor(migrated.intervalDays ?? 1));
  const anchorDate = migrated.anchorDate ?? '';
  if (!ISO.test(anchorDate)) throw new Error('Невалидна начална дата');

  // Per-weekday windows: dedupe by dow (last wins), validate each.
  const byDow = new Map<number, SlotDay>();
  for (const d of migrated.days ?? []) {
    if (!Number.isInteger(d?.dow) || d.dow < 0 || d.dow > 6) continue;
    const win = normalizeWindow(d, ` (${BG_WD[d.dow]})`);
    byDow.set(d.dow, { dow: d.dow, ...win });
  }
  const days = [...byDow.values()].sort((a, b) => a.dow - b.dow);
  const intervalWindow = normalizeWindow(migrated.intervalWindow, '');

  if (repeat === 'weekdays' && days.length === 0) {
    throw new Error('Избери поне един ден от седмицата');
  }

  return {
    active: migrated.active !== false,
    repeat,
    days,
    intervalDays,
    intervalWindow,
    anchorDate,
    customerNote: migrated.customerNote?.slice(0, 280) || undefined,
    driverNote: migrated.driverNote?.slice(0, 500) || undefined,
    horizonDays: Math.min(60, Math.max(1, Math.floor(migrated.horizonDays ?? 28))),
    skipDates: prev?.skipDates ?? [],
    lastMaterializedDate: undefined,
  };
}
