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

// Known link-shim / mobile subdomains that are the SAME channel as their
// canonical host — without this, one traffic source fragments into several
// near-identical "Откъде идват" rows (m.facebook.com, l.facebook.com,
// lm.facebook.com all seen live for what is just "Facebook").
const HOST_ALIASES: [RegExp, string][] = [
  [/(^|\.)facebook\.com$/, 'facebook.com'],
  [/(^|\.)instagram\.com$/, 'instagram.com'],
];

/** Host of a referrer URL, or null if empty/unparseable — normalized so the
 *  same real-world channel always maps to one row: leading `www.` stripped,
 *  and known link-shim/mobile subdomains collapsed to their canonical host
 *  (see HOST_ALIASES). Same-site filtering is the caller's job (it knows the
 *  storefront host) — chaika's own beacon also drops same-host referrers
 *  client-side before they're ever sent. */
export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  let host: string;
  try {
    host = new URL(referrer).host;
  } catch {
    return null;
  }
  if (!host) return null;
  host = host.replace(/^www\./, '');
  for (const [re, canonical] of HOST_ALIASES) {
    if (re.test(host)) return canonical;
  }
  return host;
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

/** The 5 funnel steps in order of increasing depth, with BG labels. Exported
 *  so the query layer can build a matching stage-rank CASE expression without
 *  duplicating this order. */
export const FUNNEL_ORDER: { key: FunnelKey; label: string }[] = [
  { key: 'page_view', label: 'Влезли в сайта' },
  { key: 'product_view', label: 'Разгледали продукт' },
  { key: 'add_to_cart', label: 'Добавили в кошница' },
  { key: 'checkout_start', label: 'Започнали поръчка' },
  { key: 'purchase', label: 'Купили' },
];

/** Builds the 5 funnel steps from "deepest stage reached" counts — i.e.
 *  `stageCounts[i]` = number of visitors whose deepest event was AT LEAST
 *  step i (so a visitor who only added to cart, without ever firing
 *  product_view — real traffic, e.g. an add-to-cart button on the shop
 *  listing page — still counts toward "Разгледали продукт"). This makes the
 *  funnel monotonically non-increasing BY CONSTRUCTION: unlike counting each
 *  event type independently (the old approach), a later step can never show
 *  MORE visitors than an earlier one. */
export function buildFunnel(stageCounts: number[]): FunnelStep[] {
  return FUNNEL_ORDER.map(({ key, label }, i) => ({ key, label, visitors: stageCounts[i] ?? 0 }));
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

export interface PageLabel {
  /** Canonical route key — dynamic segments collapsed (e.g. every `/product/:slug`
   *  becomes `/product`), since farmers think in "the product page", not URLs. */
  path: string;
  label: string;
}

/** The chaika storefront's real routes (see `fermerski-pazar-chaika/src/pages`),
 *  matched in order, with the Bulgarian label a farmer actually understands.
 *  Keep in sync with that repo's page list when routes are added/removed. */
const PAGE_ROUTES: { re: RegExp; path: string; label: string }[] = [
  { re: /^\/$/, path: '/', label: 'Начало' },
  { re: /^\/shop\/?$/, path: '/shop', label: 'Магазин' },
  { re: /^\/about\/?$/, path: '/about', label: 'За нас' },
  { re: /^\/articles\/?$/, path: '/articles', label: 'Статии' },
  { re: /^\/articles\/[^/]+\/?$/, path: '/articles', label: 'Статии' },
  { re: /^\/cart\/?$/, path: '/cart', label: 'Количка' },
  { re: /^\/checkout\/?$/, path: '/checkout', label: 'Плащане' },
  { re: /^\/confirmation\/?$/, path: '/confirmation', label: 'Потвърждение на поръчка' },
  { re: /^\/contact\/?$/, path: '/contact', label: 'Контакти' },
  { re: /^\/cookies\/?$/, path: '/cookies', label: 'Бисквитки' },
  { re: /^\/faq\/?$/, path: '/faq', label: 'Въпроси и отговори' },
  { re: /^\/farmer\/[^/]+\/?$/, path: '/farmer', label: 'Профил на фермер' },
  { re: /^\/farmers\/?$/, path: '/farmers', label: 'Фермери' },
  { re: /^\/orders\/?$/, path: '/orders', label: 'Поръчки' },
  { re: /^\/privacy\/?$/, path: '/privacy', label: 'Поверителност' },
  { re: /^\/product\/[^/]+\/?$/, path: '/product', label: 'Продукт' },
  { re: /^\/reviews\/?$/, path: '/reviews', label: 'Отзиви' },
  { re: /^\/terms\/?$/, path: '/terms', label: 'Условия' },
];

/** Maps a raw tracked path to a known storefront route + Bulgarian label, or
 *  null when it isn't a real page a shopper can land on (bot probes, one-off
 *  diagnostics, typos, the 404 page, query-string/hash noise). Query string
 *  and hash are stripped before matching — the route list above is path-only. */
export function labelPage(rawPath: string): PageLabel | null {
  const path = rawPath.split('?')[0].split('#')[0];
  const match = PAGE_ROUTES.find((r) => r.re.test(path));
  return match ? { path: match.path, label: match.label } : null;
}

export interface TopPageRow {
  path: string;
  /** Storefront-supplied label from the event itself (site_events.page_label),
   *  or null for events from a client build that predates this field. */
  pageLabel: string | null;
  views: number;
}

export interface TopPageStat {
  path: string;
  label: string;
  views: number;
}

/** Collapses raw per-event view counts into up to `limit` pages with Bulgarian
 *  labels, dynamic routes (every `/product/:slug`, every `/farmer/:id`) summed
 *  into one bucket. Each storefront self-describes its pages via the
 *  `pageLabel` it sends with the event (see chaika's `Layout.astro`), so this
 *  works for any storefront's own route shape without the backend hardcoding a
 *  route list per site. Falls back to the `labelPage()` path-shape guess only
 *  for events from an older client build that doesn't send `pageLabel` yet;
 *  anything neither self-describes nor matches a known chaika route (bot
 *  probes, diagnostics, the 404 page, query noise) is dropped rather than
 *  shown as a confusing raw URL.
 *
 *  Buckets by the resolved LABEL, not the path — a legacy row for `/` (no
 *  `pageLabel`, resolved via `labelPage` to "Начало") must land in the same
 *  bucket as a new row that explicitly sends `pageLabel: "Начало"`, or the
 *  same real page fragments into two "duplicate" entries the moment a site's
 *  client build starts sending labels while older rows are still in the
 *  window. */
export function buildTopPages(rows: TopPageRow[], limit = 6): TopPageStat[] {
  const totals = new Map<string, TopPageStat>();
  for (const row of rows) {
    const explicit = row.pageLabel?.trim();
    const label = explicit || labelPage(row.path)?.label;
    if (!label) continue;
    const existing = totals.get(label);
    if (existing) existing.views += row.views;
    else totals.set(label, { path: label, label, views: row.views });
  }
  return [...totals.values()].sort((a, b) => b.views - a.views).slice(0, limit);
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
