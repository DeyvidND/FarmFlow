import type { ConsolidatedProtocolOverrides } from '@/lib/types';

/** The three editable cells of a protocol row (Партида / Е-док / Бележка) —
 *  the server whitelists exactly these in decorateWithOverrides. */
export type ConsolidatedOverrideField = 'batch' | 'eDoc' | 'note';

/** Toggle one order's membership in `excludedOrderIds` without disturbing
 *  extraRows/fieldOverrides — the edit screen's checkbox handler calls this
 *  and PATCHes the result, rather than hand-rolling array splicing inline
 *  (which is where an accidental duplicate/loss bug would hide). */
export function buildOverridesToggleExclude(
  current: ConsolidatedProtocolOverrides,
  orderId: string,
  exclude: boolean,
): ConsolidatedProtocolOverrides {
  const set = new Set(current.excludedOrderIds ?? []);
  if (exclude) set.add(orderId);
  else set.delete(orderId);
  return { ...current, excludedOrderIds: [...set] };
}

/** Set (or clear, when the trimmed value is empty) one editable cell of one
 *  row's `fieldOverrides` entry, keyed `f:<farmerId>` / `o:<orderId>`.
 *
 *  Returns the FULL next overrides object: the server's PATCH merge is
 *  shallow at the top level (`{ ...stored, ...patch }`), so `fieldOverrides`
 *  is replaced wholesale — the caller must always send the complete map, not
 *  just the touched entry. Entries that end up empty are dropped so a cleared
 *  input reverts the row to its live value instead of pinning `''`. Never
 *  mutates `current`. */
export function buildOverridesSetFieldOverride(
  current: ConsolidatedProtocolOverrides,
  key: string,
  field: ConsolidatedOverrideField,
  value: string,
): ConsolidatedProtocolOverrides {
  const map = { ...(current.fieldOverrides ?? {}) };
  const entry = { ...(map[key] ?? {}) };
  const trimmed = value.trim();
  if (trimmed === '') delete entry[field];
  else entry[field] = trimmed;
  if (Object.keys(entry).length === 0) delete map[key];
  else map[key] = entry;
  return { ...current, fieldOverrides: map };
}
