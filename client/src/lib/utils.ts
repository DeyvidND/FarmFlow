import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a value to "6,50 €". Accepts either a euro amount (number) or cents (int). */
export function money(value: number, { fromStotinki = false } = {}): string {
  const eur = fromStotinki ? value / 100 : value;
  return eur.toFixed(2).replace('.', ',') + ' €';
}

/** Format integer cents to "6,50 €". */
export function moneyFromStotinki(cents: number): string {
  return money(cents, { fromStotinki: true });
}

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';

// Keys are in pipeline order — Object.keys drives the „Промени статус" override
// dropdown in order-panel, so keep them ordered pending → … → delivered/cancelled.
export const statusMeta: Record<OrderStatus, { label: string; cls: OrderStatus }> = {
  pending: { label: 'Очаква потвърждение', cls: 'pending' },
  confirmed: { label: 'Потвърдена', cls: 'confirmed' },
  preparing: { label: 'Приготвя се', cls: 'preparing' },
  out_for_delivery: { label: 'На път', cls: 'out_for_delivery' },
  delivered: { label: 'Доставена', cls: 'delivered' },
  cancelled: { label: 'Отказана', cls: 'cancelled' },
};

const BG_DAYS = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];
export const BG_MONTHS = [
  'януари', 'февруари', 'март', 'април', 'май', 'юни',
  'юли', 'август', 'септември', 'октомври', 'ноември', 'декември',
];

/** "събота, 30 май 2026 г." */
export function bgDateLabel(d: Date = new Date()): string {
  return `${BG_DAYS[d.getDay()]}, ${d.getDate()} ${BG_MONTHS[d.getMonth()]} ${d.getFullYear()} г.`;
}

const BG_DAYS_SHORT = ['Нед', 'Пон', 'Вто', 'Сря', 'Чет', 'Пет', 'Съб'];

/** "09:00:00" → "09:00" (pg time → display). */
export function hhmm(t: string): string {
  return t.slice(0, 5);
}

/** "2026-05-30" → "Съб". */
export function bgWeekdayShort(dateStr: string): string {
  return BG_DAYS_SHORT[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}

/** Compact relative day for delivery slots: "Днес"/"Утре"/"Вчера", else "чт, 12 юни". */
export function relDayLabel(iso: string): string {
  const today = todayIso();
  if (iso === today) return 'Днес';
  if (iso === shiftIsoDate(today, -1)) return 'Вчера';
  if (iso === shiftIsoDate(today, 1)) return 'Утре';
  const [, m, d] = iso.split('-');
  return `${bgWeekdayShort(iso)}, ${Number(d)} ${BG_MONTHS[Number(m) - 1]}`;
}

/** "2026-05-30" → "30.05". */
export function ddmm(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}`;
}

/** Today as local-time "YYYY-MM-DD". Only call from client components. */
export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Shift a "YYYY-MM-DD" string by deltaDays, returning "YYYY-MM-DD" (local time). */
export function shiftIsoDate(dateStr: string, deltaDays: number): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  const ny = dt.getFullYear();
  const nm = String(dt.getMonth() + 1).padStart(2, '0');
  const nd = String(dt.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

/** Renders an HH:MM in Bulgaria local time. Deterministic (fixed IANA zone), so it
 *  agrees between SSR and the browser — no hydration mismatch. */
const SOFIA_HM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Sofia',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** ISO timestamp → "HH:MM" in Europe/Sofia. The API serialises timestamps in UTC,
 *  so slicing the raw string showed UTC (07:51 for a 10:51 Sofia time). Parse as UTC
 *  even when the offset suffix is absent, then format in Bulgaria local time. */
export function timeFromIso(iso: string): string {
  const hasTz = /[zZ]$|[+-]\d\d:?\d\d$/.test(iso);
  const d = new Date(hasTz ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? iso : SOFIA_HM.format(d);
}
