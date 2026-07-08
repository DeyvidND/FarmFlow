'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn, BG_MONTHS, shiftIsoDate, todayIso } from '@/lib/utils';

const BG_DAYS_MON = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

type Cell = { iso: string; day: number; otherMonth: boolean };

function parseIso(s: string) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m: m - 1, d };
}

function isoOf(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

function mondayFirstDow(y: number, m: number, d: number): number {
  return (new Date(y, m, d).getDay() + 6) % 7;
}

function firstOfMonth(dateStr: string) {
  const { y, m } = parseIso(dateStr);
  return { y, m };
}

/**
 * Day picker + prev/next nav. Two modes:
 *  - Production (default): URL-driven — picking a day pushes `${hrefBase}?date=`.
 *  - Orders: controlled — pass `onSelect` (called with the picked iso) and
 *    `onAllDays` to enable the «Всички дни» clear affordance. In all-days mode
 *    pass `allDays` so no day reads as selected and the «Днес» badge hides.
 */
export function DateNavBar({
  date,
  dateLabel,
  onSelect,
  hrefBase = '/production',
  allDays = false,
  onAllDays,
}: {
  /** Concrete day driving the calendar view. In orders all-days mode pass today. */
  date: string;
  dateLabel: string;
  onSelect?: (iso: string) => void;
  hrefBase?: string;
  allDays?: boolean;
  onAllDays?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => firstOfMonth(date));
  const [today, setToday] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setToday(todayIso());
  }, []);

  useEffect(() => {
    setViewMonth(firstOfMonth(date));
  }, [date]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const cells: Cell[] = useMemo(() => {
    const { y, m } = viewMonth;
    const lead = mondayFirstDow(y, m, 1);
    const result: Cell[] = [];

    const prevM = m === 0 ? 11 : m - 1;
    const prevY = m === 0 ? y - 1 : y;
    const prevDays = daysInMonth(prevY, prevM);
    for (let i = lead - 1; i >= 0; i--) {
      const d = prevDays - i;
      result.push({ iso: isoOf(prevY, prevM, d), day: d, otherMonth: true });
    }

    const curDays = daysInMonth(y, m);
    for (let d = 1; d <= curDays; d++) {
      result.push({ iso: isoOf(y, m, d), day: d, otherMonth: false });
    }

    const nextM = m === 11 ? 0 : m + 1;
    const nextY = m === 11 ? y + 1 : y;
    const remaining = result.length % 7 === 0 ? 0 : 7 - (result.length % 7);
    for (let d = 1; d <= remaining; d++) {
      result.push({ iso: isoOf(nextY, nextM, d), day: d, otherMonth: true });
    }

    return result;
  }, [viewMonth]);

  const isToday = !allDays && today !== null && date === today;

  const go = onSelect ?? ((iso: string) => router.push(`${hrefBase}?date=${iso}`));
  const goPrev = () => go(shiftIsoDate(date, -1));
  const goNext = () => go(shiftIsoDate(date, +1));
  const goToday = () => { go(todayIso()); setOpen(false); };
  const goAllDays = () => { onAllDays?.(); setOpen(false); };
  const pickDay = (cell: Cell) => { if (cell.otherMonth) return; go(cell.iso); setOpen(false); };
  const prevMonth = () => setViewMonth(({ y, m }) => m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 });
  const nextMonth = () => setViewMonth(({ y, m }) => m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 });

  return (
    <div ref={wrapRef} className="relative">
      {/* nav bar */}
      <div className="flex items-center overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <button
          onClick={goPrev}
          aria-label="Предходен ден"
          className="flex items-center justify-center px-3 py-2.5 text-ff-ink-2 transition-colors hover:bg-ff-surface-2"
        >
          <ChevronLeft size={18} />
        </button>

        <span className="self-stretch w-px bg-ff-border-2" />

        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label="Избери дата"
          className="flex flex-1 items-center justify-center gap-2 px-3.5 py-2.5 text-[13.5px] font-bold text-ff-ink-2 transition-colors hover:bg-ff-surface-2"
        >
          <CalendarDays size={17} className="shrink-0 text-ff-muted" />
          <span className="capitalize">{dateLabel}</span>
          {isToday && (
            <span className="rounded-md bg-ff-green-50 px-1.5 py-0.5 text-[11px] font-bold text-ff-green-700">
              Днес
            </span>
          )}
          <ChevronDown
            size={16}
            className={cn('shrink-0 text-ff-muted transition-transform duration-200', open && 'rotate-180')}
          />
        </button>

        <span className="self-stretch w-px bg-ff-border-2" />

        <button
          onClick={goNext}
          aria-label="Следващ ден"
          className="flex items-center justify-center px-3 py-2.5 text-ff-ink-2 transition-colors hover:bg-ff-surface-2"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {/* calendar popup */}
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-[300px] rounded-xl border border-ff-border bg-ff-surface p-3 shadow-ff-sm">
          {/* month header */}
          <div className="mb-2 flex items-center justify-between">
            <button
              onClick={prevMonth}
              aria-label="Предишен месец"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-ff-muted transition-colors hover:bg-ff-surface-2 hover:text-ff-ink-2"
            >
              <ChevronLeft size={16} />
            </button>
            <div className="text-[14px] font-extrabold capitalize text-ff-ink">
              {BG_MONTHS[viewMonth.m]} {viewMonth.y}
            </div>
            <button
              onClick={nextMonth}
              aria-label="Следващ месец"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-ff-muted transition-colors hover:bg-ff-surface-2 hover:text-ff-ink-2"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* weekday labels */}
          <div className="mb-1 grid grid-cols-7">
            {BG_DAYS_MON.map((d) => (
              <div key={d} className="py-1 text-center text-[11px] font-bold text-ff-muted">
                {d}
              </div>
            ))}
          </div>

          {/* day grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((cell) => (
              <button
                key={cell.iso}
                disabled={cell.otherMonth}
                onClick={() => pickDay(cell)}
                className={cn(
                  'aspect-square rounded-lg text-[13px] font-bold transition-colors',
                  cell.otherMonth && 'pointer-events-none text-ff-muted-2 opacity-30',
                  !cell.otherMonth && !allDays && cell.iso === date && 'bg-ff-green-600 text-white',
                  !cell.otherMonth && (allDays || cell.iso !== date) && cell.iso === today && 'bg-ff-green-50 text-ff-green-700',
                  !cell.otherMonth && (allDays || cell.iso !== date) && cell.iso !== today && 'text-ff-ink hover:bg-ff-surface-2',
                )}
              >
                {cell.day}
              </button>
            ))}
          </div>

          {/* footer */}
          <div className={cn('mt-2 flex items-center border-t border-ff-border-2 pt-2', onAllDays ? 'justify-between' : 'justify-end')}>
            {onAllDays && (
              <button
                onClick={goAllDays}
                className={cn(
                  'rounded-lg px-2.5 py-1.5 text-[12.5px] font-bold transition-colors',
                  allDays ? 'bg-ff-green-50 text-ff-green-700' : 'text-ff-ink-2 hover:bg-ff-surface-2',
                )}
              >
                Всички дни
              </button>
            )}
            <button
              onClick={goToday}
              className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-bold text-ff-green-700 transition-colors hover:bg-ff-green-50"
            >
              Към днес
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
