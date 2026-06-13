import type { SiteMarketingDto } from './dto/site-marketing.dto';

/** Per-tenant tracking IDs the storefront injects, one per ad/analytics vendor.
 *  Empty or malformed → null (that vendor stays off). No vendor code is ever
 *  stored — only the IDs; the storefront templates the loader snippet. */
export interface PublicMarketing {
  ga4: string | null; // Google Analytics 4 Measurement ID, e.g. G-XXXXXXX
  googleAds: string | null; // Google Ads conversion ID, e.g. AW-XXXXXXXXX
  // Google Ads purchase-conversion label (the part Google appends after the
  // slash, AW-xxx/<label>). Only meaningful together with googleAds.
  googleAdsLabel: string | null;
  metaPixel: string | null; // Meta (Facebook) Pixel ID — 10-20 digits
  gtm: string | null; // Google Tag Manager container, e.g. GTM-XXXXXXX
  tiktok: string | null; // TikTok Pixel ID — alphanumeric
}

/** Per-vendor ID format. A value that fails its pattern is dropped to null
 *  rather than stored/emitted: a typo can never inject a broken `<script>` on
 *  the storefront, and (since every pattern is alphanumeric + `-`/`_` only) no
 *  value can carry script-breakout characters into the head. */
const PATTERNS: Record<keyof PublicMarketing, RegExp> = {
  ga4: /^G-[A-Z0-9]{4,15}$/i,
  googleAds: /^AW-[0-9]{6,15}$/i,
  googleAdsLabel: /^[A-Za-z0-9_-]{6,40}$/,
  metaPixel: /^[0-9]{10,20}$/,
  gtm: /^GTM-[A-Z0-9]{4,12}$/i,
  tiktok: /^[A-Z0-9]{10,40}$/i,
};

const KEYS = Object.keys(PATTERNS) as (keyof PublicMarketing)[];

/** Trim a value and return it only if it matches its vendor pattern, else null. */
function clean(key: keyof PublicMarketing, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v && PATTERNS[key].test(v) ? v : null;
}

/** Project a raw settings.marketing blob to its public shape. Garbage-in →
 *  all-null (every vendor off). */
export function buildPublicMarketing(raw: unknown): PublicMarketing {
  const m =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out = {} as PublicMarketing;
  for (const key of KEYS) out[key] = clean(key, m[key]);
  return out;
}

/** Normalize an incoming DTO into the object stored at settings.marketing: trim +
 *  validate each field, keep only the valid non-empty ones (full-replace, so a
 *  cleared field drops out). A lone Ads conversion label is dropped — it does
 *  nothing without its Ads id. */
export function normalizeMarketing(dto: SiteMarketingDto): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of KEYS) {
    const v = clean(key, (dto as Record<string, unknown>)[key]);
    if (v) out[key] = v;
  }
  if (out.googleAdsLabel && !out.googleAds) delete out.googleAdsLabel;
  return out;
}
