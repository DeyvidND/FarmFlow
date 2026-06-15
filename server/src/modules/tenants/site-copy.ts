// server/src/modules/tenants/site-copy.ts
import { copySlotKeys } from './copy-slots.catalog';

export interface PublicFaqItem { q: string; a: string; }

/** Clean an incoming copy map: keep only known slot keys, trim, drop empties.
 *  (Empty/blank override = "use the storefront default", so it isn't stored.) */
export function cleanCopy(
  theme: string | null | undefined,
  raw: unknown,
): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const allowed = copySlotKeys(theme);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(k)) continue;
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t) out[k] = t;
  }
  return out;
}

/** Project a stored copy map to its public shape (same cleaning, theme-aware). */
export function buildPublicCopy(
  theme: string | null | undefined,
  raw: unknown,
): Record<string, string> {
  return cleanCopy(theme, raw);
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

/** Project a stored FAQ array to its public shape (same normalization). */
export const buildPublicFaq = normalizeFaq;
