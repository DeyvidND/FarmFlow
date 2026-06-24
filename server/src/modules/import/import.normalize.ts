import type { BatchDefaults, Carrier, DeliveryMode, NormalizedRow, RawRow } from './import.types';

const BGN_PER_EUR = 1.95583;

/** Normalize a Bulgarian phone to +359XXXXXXXXX, or null if it isn't one. */
export function normalizeBgPhone(raw: string | undefined | null): string | null {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  let n = digits;
  if (n.startsWith('+359')) n = n.slice(4);
  else if (n.startsWith('00359')) n = n.slice(5);
  else if (n.startsWith('359')) n = n.slice(3);
  else if (n.startsWith('0')) n = n.slice(1);
  else return null;
  // BG mobile national part is 9 digits (e.g. 888123456).
  if (!/^\d{9}$/.test(n)) return null;
  return `+359${n}`;
}

/** Parse a money cell (decimal in the batch currency) into EUR stotinki, or null. */
export function toStotinki(raw: string | undefined | null, currency: 'BGN' | 'EUR'): number | null {
  const s = String(raw ?? '').replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  const eur = currency === 'BGN' ? v / BGN_PER_EUR : v;
  return Math.round(eur * 100);
}

function parseMode(raw: string | undefined): DeliveryMode | null {
  const n = String(raw ?? '').toLowerCase().trim();
  if (['офис', 'office'].includes(n)) return 'office';
  if (['адрес', 'address'].includes(n)) return 'address';
  return null;
}

function parseCarrier(raw: string | undefined, fallback: Carrier): Carrier {
  const n = String(raw ?? '').toLowerCase().trim();
  if (n === 'speedy' || n === 'спиди') return 'speedy';
  if (n === 'econt' || n === 'еконт') return 'econt';
  return fallback;
}

function parseWeightGrams(raw: string | undefined): number | null {
  const s = String(raw ?? '').replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  const kg = Number(s);
  if (!Number.isFinite(kg) || kg <= 0) return null;
  return Math.round(kg * 1000);
}

const blank = (s: string | undefined): string | null => {
  const v = String(s ?? '').trim();
  return v ? v : null;
};

/** Map a raw parsed row to a typed NormalizedRow, applying batch defaults. */
export function normalizeRow(raw: RawRow, rowIndex: number, defaults: BatchDefaults): NormalizedRow {
  return {
    rowIndex,
    receiverName: String(raw.name ?? '').trim(),
    receiverPhone: normalizeBgPhone(raw.phone) ?? String(raw.phone ?? '').trim(),
    deliveryMode: parseMode(raw.mode),
    city: blank(raw.city),
    office: blank(raw.office),
    address: blank(raw.address),
    streetNo: null,
    weightGrams: parseWeightGrams(raw.weight) ?? defaults.weightGrams ?? null,
    contents: blank(raw.contents) ?? defaults.contents ?? null,
    codAmountStotinki: toStotinki(raw.cod, defaults.currency),
    declaredValueStotinki: toStotinki(raw.declared, defaults.currency),
    carrier: parseCarrier(raw.carrier, defaults.carrier),
    raw,
  };
}
