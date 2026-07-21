import type { ExpenseCategory } from '@/lib/types';

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  fuel: 'Гориво',
  packaging: 'Амбалаж',
  salary: 'Заплати',
  fees: 'Такси',
  other: 'Друго',
};

/** Таванът от бекенда (MAX_COMMISSION_BPS) в проценти. */
const MAX_PCT = 50;

/** 1250 → '12.5'; целите числа остават без излишна нула. */
export function bpsToPct(bps: number): string {
  return String(Math.round(bps) / 100);
}

/** '12,5' → 1250. null при празно, нечислово, отрицателно или над тавана. */
export function pctToBps(input: string): number | null {
  const trimmed = input.trim();
  // Number('') === 0, which would otherwise slip past the >= 0 check below.
  if (trimmed === '') return null;
  const n = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > MAX_PCT) return null;
  return Math.round(n * 100);
}

/** '12,34' лв → 1234 стотинки. null при празно, нечислово или ≤ 0. */
export function parseAmountToStotinki(input: string): number | null {
  const n = Number(input.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  const stotinki = Math.round(n * 100);
  return stotinki > 0 ? stotinki : null;
}
