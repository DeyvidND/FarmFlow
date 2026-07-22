import type { ConsolidatedProtocolMeta } from '@/lib/types';

/** The В. Транспорт form's fields, in display order. */
export const META_FIELDS = ['vehicle', 'plate', 'driverName', 'startPlace', 'startTime', 'plannedEnd'] as const;
export type MetaField = (typeof META_FIELDS)[number];

/** Bulgarian labels — the form used to render the raw English keys, which is
 *  what operators actually saw on the screen. */
export const META_LABELS: Record<MetaField, string> = {
  vehicle: 'Возило',
  plate: 'Рег. №',
  driverName: 'Приел за транспорт (шофьор)',
  startPlace: 'Тръгва от',
  startTime: 'Час на тръгване',
  plannedEnd: 'Очаквано приключване',
};

export type MetaFormState = Record<MetaField, string>;

/** Controlled-form seed: every field present as a string ('' for absent). */
export function seedMetaForm(meta: ConsolidatedProtocolMeta | undefined): MetaFormState {
  const out = {} as MetaFormState;
  for (const f of META_FIELDS) out[f] = meta?.[f] ?? '';
  return out;
}

/** Field-by-field comparison — never JSON.stringify (key-order made the legal
 *  card's dirty check lie; same trap here). `last === null` = nothing saved
 *  yet, so any content counts as dirty. */
export function isMetaDirty(form: MetaFormState, last: MetaFormState | null): boolean {
  if (last === null) return META_FIELDS.some((f) => form[f] !== '');
  return META_FIELDS.some((f) => form[f] !== last[f]);
}
