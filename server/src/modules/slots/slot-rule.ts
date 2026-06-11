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
  /**
   * How long one delivery takes, in minutes. When set (>0) each day's window is
   * split into back-to-back slots of this length ("10:00–18:00, 60" → 10–11,
   * 11–12, …), each with the window's own capacity. 0/absent = the whole window
   * is one slot (the original behaviour).
   */
  slotMinutes?: number;
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

const hhmmToMin = (t: string) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
const minToHhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Split a window into back-to-back sub-slots of `slotMinutes`. Only full chunks
 * are produced (a 10:00–11:30 window at 60 min yields just 10–11); a window too
 * short for even one chunk falls back to the whole window, so a misconfigured
 * day still sells. slotMinutes <= 0 → the whole window, unchanged.
 */
export function splitWindow(
  win: SlotWindow,
  slotMinutes: number,
): { timeFrom: string; timeTo: string }[] {
  if (!slotMinutes || slotMinutes <= 0) return [{ timeFrom: win.timeFrom, timeTo: win.timeTo }];
  const from = hhmmToMin(win.timeFrom);
  const to = hhmmToMin(win.timeTo);
  if (to - from < slotMinutes) return [{ timeFrom: win.timeFrom, timeTo: win.timeTo }];
  const out: { timeFrom: string; timeTo: string }[] = [];
  for (let m = from; m + slotMinutes <= to; m += slotMinutes) {
    out.push({ timeFrom: minToHhmm(m), timeTo: minToHhmm(m + slotMinutes) });
  }
  return out;
}

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
 * [max(today, anchor) … today+horizon], minus skipDates. One slot per date per
 * sub-window (slotMinutes splits a day's window into several). Bounded to 1200
 * results — horizon caps at 60 days, so even 15-min slots over a 12h window
 * stay under it for a normal week. Returns [] for an inactive rule.
 */
export function slotRuleSlots(rule: SlotRule, today: string): GenSlot[] {
  if (!rule.active) return [];
  const start = isoMax(today, rule.anchorDate);
  const end = isoAddDays(today, Math.max(0, rule.horizonDays));
  if (start > end) return [];
  const skip = new Set(rule.skipDates ?? []);
  const slotMinutes = Math.max(0, Math.floor(rule.slotMinutes ?? 0));
  const out: GenSlot[] = [];
  const pushDay = (date: string, win: SlotWindow) => {
    for (const part of splitWindow(win, slotMinutes)) {
      out.push({ date, timeFrom: part.timeFrom, timeTo: part.timeTo, maxOrders: win.maxOrders });
    }
  };

  if (rule.repeat === 'weekdays') {
    const byDow = new Map<number, SlotWindow>();
    for (const d of rule.days ?? []) byDow.set(d.dow, d);
    if (byDow.size === 0) return [];
    for (let iso = start; iso <= end; iso = isoAddDays(iso, 1)) {
      const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
      const win = byDow.get(dow);
      if (win && !skip.has(iso)) pushDay(iso, win);
      if (out.length >= 1200) break;
    }
  } else {
    const win = rule.intervalWindow;
    const n = Math.max(1, Math.floor(rule.intervalDays || 1));
    let iso = rule.anchorDate;
    let guard = 0;
    while (iso < start && guard++ < 4000) iso = isoAddDays(iso, n);
    for (; iso <= end; iso = isoAddDays(iso, n)) {
      if (!skip.has(iso)) pushDay(iso, win);
      if (out.length >= 1200) break;
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

const DEFAULT_WINDOW: SlotWindow = { timeFrom: '10:00', timeTo: '12:00', maxOrders: 5 };

/** Like normalizeWindow but returns `fallback` instead of throwing — used for the
 *  mode that isn't active, whose window is stored but isn't the user's choice. */
function safeWindow(input: Partial<SlotWindow> | undefined, fallback: SlotWindow): SlotWindow {
  try {
    return normalizeWindow(input, '');
  } catch {
    return fallback;
  }
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

  const wantWeekdays = repeat === 'weekdays';

  // Per-weekday windows: dedupe by dow (last wins). In weekdays mode each window
  // is the user's active config and must be valid; in interval mode the days are
  // inert, so drop any invalid one instead of failing the whole save.
  const byDow = new Map<number, SlotDay>();
  for (const d of migrated.days ?? []) {
    if (!Number.isInteger(d?.dow) || d.dow < 0 || d.dow > 6) continue;
    if (wantWeekdays) {
      byDow.set(d.dow, { dow: d.dow, ...normalizeWindow(d, ` (${BG_WD[d.dow]})`) });
    } else {
      try {
        byDow.set(d.dow, { dow: d.dow, ...normalizeWindow(d, '') });
      } catch {
        /* inert in interval mode — skip the invalid day rather than reject */
      }
    }
  }
  const days = [...byDow.values()].sort((a, b) => a.dow - b.dow);

  // Interval window: strict when interval is the active mode, tolerant otherwise
  // (a stale/blank window for the inactive mode must not block a weekdays save).
  const intervalWindow = wantWeekdays
    ? safeWindow(migrated.intervalWindow, DEFAULT_WINDOW)
    : normalizeWindow(migrated.intervalWindow, '');

  if (wantWeekdays && days.length === 0) {
    throw new Error('Избери поне един ден от седмицата');
  }

  // Slot length: 0 = off (whole window is one slot); otherwise clamp to a sane
  // range so a typo can't generate thousands of slivers.
  const rawSlotMin = Math.floor(migrated.slotMinutes ?? 0);
  const slotMinutes = rawSlotMin > 0 ? Math.min(480, Math.max(15, rawSlotMin)) : 0;

  // A slot sized to one delivery holds exactly one delivery — with a duration
  // set, capacity per sub-slot is always 1 (the admin hides the field).
  const cap1 = <T extends SlotWindow>(w: T): T => ({ ...w, maxOrders: 1 });
  const finalDays = slotMinutes > 0 ? days.map(cap1) : days;
  const finalIntervalWindow = slotMinutes > 0 ? cap1(intervalWindow) : intervalWindow;

  return {
    active: migrated.active !== false,
    repeat,
    days: finalDays,
    intervalDays,
    intervalWindow: finalIntervalWindow,
    anchorDate,
    slotMinutes,
    customerNote: migrated.customerNote?.slice(0, 280) || undefined,
    driverNote: migrated.driverNote?.slice(0, 500) || undefined,
    horizonDays: Math.min(60, Math.max(1, Math.floor(migrated.horizonDays ?? 28))),
    skipDates: prev?.skipDates ?? [],
    lastMaterializedDate: undefined,
  };
}
