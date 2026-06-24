import { normalizeBgPhone } from './import.normalize';
import type { NormalizedRow, RowIssue, RowStatus, RowValidation } from './import.types';

/** Deterministic, carrier-agnostic validation. Authoritative for blocking (errors). */
export function validateRow(row: NormalizedRow): RowValidation {
  const issues: RowIssue[] = [];
  const err = (field: string, message: string) => issues.push({ field, message });
  const warn = (field: string, message: string) => issues.push({ field, message });

  let hardError = false;

  if (!row.receiverName.trim()) { err('receiverName', 'Липсва получател'); hardError = true; }
  if (!normalizeBgPhone(row.receiverPhone)) { err('receiverPhone', 'Невалиден телефон'); hardError = true; }

  if (!row.deliveryMode) {
    err('deliveryMode', 'Липсва тип доставка (офис/адрес)');
    hardError = true;
  } else if (row.deliveryMode === 'office') {
    if (!row.office) { err('office', 'Режим офис, но липсва офис'); hardError = true; }
  } else {
    if (!row.city) { err('city', 'Режим адрес, но липсва град'); hardError = true; }
    if (!row.address) { err('address', 'Режим адрес, но липсва адрес'); hardError = true; }
  }

  let soft = false;
  if (row.weightGrams == null) { warn('weightGrams', 'Липсва тегло — ще се ползва по подразбиране'); soft = true; }

  const status: RowStatus = hardError ? 'error' : soft ? 'warn' : 'ok';
  return { status, issues };
}
