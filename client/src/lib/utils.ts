import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a value to "6,50 лв". Accepts either a BGN amount (number) or stotinki (int). */
export function money(value: number, { fromStotinki = false } = {}): string {
  const bgn = fromStotinki ? value / 100 : value;
  return bgn.toFixed(2).replace('.', ',') + ' лв';
}

/** Format integer stotinki to "6,50 лв". */
export function moneyFromStotinki(stotinki: number): string {
  return money(stotinki, { fromStotinki: true });
}

export type OrderStatus = 'pending' | 'confirmed' | 'delivered' | 'cancelled';

export const statusMeta: Record<OrderStatus, { label: string; cls: OrderStatus }> = {
  pending: { label: 'Чакаща', cls: 'pending' },
  confirmed: { label: 'Потвърдена', cls: 'confirmed' },
  delivered: { label: 'Доставена', cls: 'delivered' },
  cancelled: { label: 'Отказана', cls: 'cancelled' },
};

const BG_DAYS = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];
const BG_MONTHS = [
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

/** "2026-05-30" → "30.05". */
export function ddmm(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}`;
}

/** ISO timestamp → "HH:MM" (reads the wall-clock chars, TZ-agnostic). */
export function timeFromIso(iso: string): string {
  return iso.length >= 16 ? iso.slice(11, 16) : iso;
}
