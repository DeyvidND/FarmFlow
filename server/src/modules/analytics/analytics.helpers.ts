import { createHash } from 'crypto';

/** Cookieless visitor identity. sha256(ip + ua + daySalt + tenant + secret).
 *  The raw IP is only passed in transiently to compute this — callers never
 *  persist it. `day` (BG 'YYYY-MM-DD') rotates the value daily so the same
 *  person is a different hash tomorrow (no cross-day tracking).
 *  Fields are `|`-joined; a crafted UA containing `|` could in theory collide
 *  two distinct visitors onto one hash — accepted tradeoff (undercounts a
 *  unique by a negligible amount, never a privacy leak in the other direction). */
export function visitorHash(
  ip: string,
  ua: string,
  day: string,
  tenantId: string,
  secret: string,
): string {
  return createHash('sha256').update(`${ip}|${ua}|${day}|${tenantId}|${secret}`).digest('hex');
}

const MOBILE_RE = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|BlackBerry/i;

/** Coarse device class from the User-Agent. Best-effort: modern iPadOS Safari
 *  reports a desktop-style UA, so some tablets count as desktop. Empty/unknown
 *  → 'desktop'. */
export function deviceFromUA(ua: string): 'mobile' | 'desktop' {
  return MOBILE_RE.test(ua) ? 'mobile' : 'desktop';
}

// Known crawlers + headless signatures. Not exhaustive — a best-effort filter so
// bot traffic doesn't pollute the funnel. Missing/empty UA is treated as a bot.
const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora|pinterest|headless|phantom|lighthouse|gtmetrix|pingdom|uptime|curl|wget|python-requests|axios|node-fetch/i;

/** True when the UA looks like a bot/crawler/monitor, or is empty. */
export function isBot(ua: string): boolean {
  if (!ua || !ua.trim()) return true;
  return BOT_RE.test(ua);
}

/** Host of a referrer URL, or null if empty/unparseable. Same-site filtering is
 *  the caller's job (it knows the storefront host). */
export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).host || null;
  } catch {
    return null;
  }
}

export type FunnelKey =
  | 'page_view'
  | 'product_view'
  | 'add_to_cart'
  | 'checkout_start'
  | 'purchase';

export interface FunnelStep {
  key: FunnelKey;
  label: string;
  visitors: number;
}

/** The 5 funnel steps in order, with BG labels. Counts come from a
 *  {eventType → distinctVisitors} map; missing steps default to 0. */
const FUNNEL_ORDER: { key: FunnelKey; label: string }[] = [
  { key: 'page_view', label: 'Влезли в сайта' },
  { key: 'product_view', label: 'Разгледали продукт' },
  { key: 'add_to_cart', label: 'Добавили в кошница' },
  { key: 'checkout_start', label: 'Започнали поръчка' },
  { key: 'purchase', label: 'Купили' },
];

export function buildFunnel(counts: Partial<Record<FunnelKey, number>>): FunnelStep[] {
  return FUNNEL_ORDER.map(({ key, label }) => ({ key, label, visitors: counts[key] ?? 0 }));
}

/** Below this many visitors in the window the funnel/sources are noise. */
export const ANALYTICS_SPARSE_MIN = 30;

/** Purchase conversion rate, rounded to one decimal. 0 when there are no
 *  visitors to convert (avoids NaN/Infinity from a divide-by-zero). */
export function conversionPct(purchasers: number, visitors: number): number {
  return visitors > 0 ? Math.round((purchasers / visitors) * 1000) / 10 : 0;
}

export interface WeekdayStat {
  label: string;
  visitors: number;
  purchasers: number;
  conversionPct: number;
}

/** One grouped row from the weekday aggregation query, before reindexing.
 *  `pgDow` is Postgres's `extract(dow ...)` value: 0=Sunday..6=Saturday. */
export interface WeekdayRow {
  pgDow: number;
  visitors: number;
  purchasers: number;
}

/** BG short weekday labels, Monday-first (matches the `DOW_SHORT` convention
 *  already used in stats-client.tsx). */
const DOW_LABELS = ['Пон', 'Вто', 'Сря', 'Чет', 'Пет', 'Съб', 'Нед'];

/** Postgres's extract(dow) is 0=Sunday..6=Saturday. This is the Monday-first
 *  reindex order: output position i pulls from raw dow value PG_DOW_ORDER[i]. */
const PG_DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Reindexes raw Postgres dow-grouped rows into a fixed 7-entry Monday-first
 *  array, filling any day with no matching row as zero. Array position is the
 *  day (same fixed-order convention as `buildFunnel`) — no numeric day field
 *  is exposed to callers. */
export function buildWeekdayPattern(rows: WeekdayRow[]): WeekdayStat[] {
  const byDow = new Map(rows.map((r) => [r.pgDow, r]));
  return PG_DOW_ORDER.map((pgDow, i) => {
    const r = byDow.get(pgDow);
    const visitors = r?.visitors ?? 0;
    const purchasers = r?.purchasers ?? 0;
    return { label: DOW_LABELS[i], visitors, purchasers, conversionPct: conversionPct(purchasers, visitors) };
  });
}
