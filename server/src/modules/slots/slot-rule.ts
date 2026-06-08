/**
 * The single recurring self-delivery rule, stored at settings.slotRule. Pure
 * date math + validation — no db. The generator (slots.service) turns the dates
 * this produces into concrete `generated` slot rows.
 */
export interface SlotRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  weekdays: number[]; // 0=Sun..6=Sat, for repeat:'weekdays'
  intervalDays: number; // >=1, for repeat:'interval'
  anchorDate: string; // YYYY-MM-DD; interval counts from here; also a lower bound
  timeFrom: string; // HH:MM
  timeTo: string; // HH:MM
  maxOrders: number;
  customerNote?: string;
  driverNote?: string;
  horizonDays: number; // how far ahead to keep filled
  skipDates: string[]; // dates the farmer deleted — never regenerate
  lastMaterializedDate?: string;
}

/** Add `n` days to an ISO date (UTC-stable, no TZ drift). */
export function isoAddDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isoMax = (a: string, b: string) => (a >= b ? a : b);

/**
 * Dates the rule should have slots on, within [max(today, anchor) … today+horizon],
 * minus skipDates. Bounded to 366 results. Returns [] for an inactive rule.
 */
export function slotRuleDates(rule: SlotRule, today: string): string[] {
  if (!rule.active) return [];
  const start = isoMax(today, rule.anchorDate);
  const end = isoAddDays(today, Math.max(0, rule.horizonDays));
  if (start > end) return [];
  const skip = new Set(rule.skipDates ?? []);
  const out: string[] = [];

  if (rule.repeat === 'weekdays') {
    const want = new Set(rule.weekdays ?? []);
    if (want.size === 0) return [];
    for (let iso = start; iso <= end; iso = isoAddDays(iso, 1)) {
      const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
      if (want.has(dow) && !skip.has(iso)) out.push(iso);
      if (out.length >= 366) break;
    }
  } else {
    const n = Math.max(1, Math.floor(rule.intervalDays || 1));
    let iso = rule.anchorDate;
    let guard = 0;
    while (iso < start && guard++ < 4000) iso = isoAddDays(iso, n);
    for (; iso <= end; iso = isoAddDays(iso, n)) {
      if (!skip.has(iso)) out.push(iso);
      if (out.length >= 366) break;
    }
  }
  return out;
}

const HHMM = /^\d{2}:\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate + clamp an incoming rule, preserving server-owned fields (skipDates)
 * from the previous stored rule. Throws Error('<bg message>') on invalid input;
 * the service maps it to BadRequestException.
 */
export function normalizeRule(input: Partial<SlotRule>, prev?: SlotRule | null): SlotRule {
  const repeat = input.repeat === 'interval' ? 'interval' : 'weekdays';
  const weekdays = Array.from(
    new Set((input.weekdays ?? []).filter((w) => Number.isInteger(w) && w >= 0 && w <= 6)),
  );
  const intervalDays = Math.max(1, Math.floor(input.intervalDays ?? 1));
  const anchorDate = ISO.test(input.anchorDate ?? '') ? (input.anchorDate as string) : '';
  const timeFrom = input.timeFrom ?? '';
  const timeTo = input.timeTo ?? '';
  const maxOrders = Math.floor(input.maxOrders ?? 0);

  if (repeat === 'weekdays' && weekdays.length === 0) {
    throw new Error('Избери поне един ден от седмицата');
  }
  if (!ISO.test(anchorDate)) throw new Error('Невалидна начална дата');
  if (!HHMM.test(timeFrom) || !HHMM.test(timeTo)) throw new Error('Часът трябва да е ЧЧ:ММ');
  if (timeTo <= timeFrom) throw new Error('Краят трябва да е след началото');
  if (maxOrders < 1) throw new Error('Капацитетът трябва да е поне 1');

  return {
    active: input.active !== false,
    repeat,
    weekdays,
    intervalDays,
    anchorDate,
    timeFrom,
    timeTo,
    maxOrders,
    customerNote: input.customerNote?.slice(0, 280) || undefined,
    driverNote: input.driverNote?.slice(0, 500) || undefined,
    horizonDays: Math.min(60, Math.max(1, Math.floor(input.horizonDays ?? 28))),
    skipDates: prev?.skipDates ?? [],
    lastMaterializedDate: undefined,
  };
}
