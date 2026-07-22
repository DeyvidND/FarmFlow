import type { FarmerReadiness, FarmerReadinessMissing } from './types';

/** Bulgarian label for each readiness gap, shown on the "Готовност на фермерите"
 *  board next to a farmer's name (spec §5.2 — "назовано какво липсва", not a
 *  percentage). */
export const READINESS_MISSING_LABEL: Record<FarmerReadinessMissing, string> = {
  kind: 'няма избран вид лице',
  name: 'няма име',
  identifier: 'няма ЕИК / Рег.№',
  address: 'няма адрес',
  signature: 'няма подпис',
};

/** Incomplete farmers first (spec §5.2 — "непълните най-отгоре"), then
 *  alphabetically by name within the same readiness state. Does not mutate
 *  its input. */
export function sortReadiness(rows: FarmerReadiness[]): FarmerReadiness[] {
  return [...rows].sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? 1 : -1;
    return a.name.localeCompare(b.name, 'bg');
  });
}
