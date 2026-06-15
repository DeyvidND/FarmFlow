// server/src/modules/tenants/site-copy.ts
export interface PublicFaqItem { q: string; a: string; }

/** Allowed override-key shape. The storefront's registry decides which keys are
 *  real; the server only guards against absurd/injection-y keys. */
export const SLOT_KEY_RE = /^[a-z0-9._-]{1,80}$/i;

/** Clean an incoming copy map: keep only pattern-valid keys, trim, drop empty. */
export function cleanCopy(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!SLOT_KEY_RE.test(k) || typeof v !== 'string') continue;
    const t = v.trim();
    if (t) out[k] = t;
  }
  return out;
}

export function buildPublicCopy(raw: unknown): Record<string, string> {
  return cleanCopy(raw);
}

/** Normalize an incoming FAQ array: trim q/a, drop fully-empty rows, cap at 50. */
export function normalizeFaq(raw: unknown): PublicFaqItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PublicFaqItem[] = [];
  for (const row of raw.slice(0, 50)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const q = typeof r.q === 'string' ? r.q.trim() : '';
    const a = typeof r.a === 'string' ? r.a.trim() : '';
    if (!q && !a) continue;
    out.push({ q, a });
  }
  return out;
}
export const buildPublicFaq = normalizeFaq;

/** Sanitize the farm's storefront URL — it becomes an iframe src in the admin,
 *  so only http/https absolute URLs are allowed; everything else → ''. */
export function sanitizeSiteUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const v = raw.trim();
  if (!v || v.length > 300) return '';
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

/** True if a key is a structurally valid slot key (used by media upload). */
export function isValidSlotKey(key: string): boolean {
  return SLOT_KEY_RE.test(key);
}
