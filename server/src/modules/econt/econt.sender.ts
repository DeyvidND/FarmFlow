/** Minimal contact shape we read off settings.contact for sender fallback. */
export interface FarmContact { phone?: string | null; address?: string | null }

/** A carrier sender suggestion (name + phone) — matches Econt SenderSuggestion
 *  and the Speedy contract-client slim shape. */
export interface CarrierProfileLite { name: string; phone: string; clientNumber?: string | null }

/** The seeded sender blob written under settings.delivery.<carrier>.sender. */
export interface DerivedSender { name: string; phone: string; mode: 'office' }

/**
 * Derive a default carrier sender from the farm's own data, in precedence order:
 *   1. the carrier's registered profile (name + phone),
 *   2. the farm name + contact phone,
 *   3. the farm name + empty phone.
 * `mode: 'office'` is always returned — the farmer picks the actual drop-off office
 * once in the sender modal (we never guess an office code).
 */
export function deriveSenderFromFarm(
  farmName: string,
  contact: FarmContact | null | undefined,
  profiles: CarrierProfileLite[] | null | undefined,
): DerivedSender {
  const p = (profiles ?? []).find((x) => x && String(x.name ?? '').trim());
  const name = (p?.name && p.name.trim()) || farmName;
  const phone = (p?.phone && p.phone.trim()) || (contact?.phone ?? '').trim() || '';
  return { name, phone, mode: 'office' };
}
