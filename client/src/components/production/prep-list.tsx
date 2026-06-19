'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, ShoppingBasket, Clock, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DateNavBar } from './date-nav-bar';
import type { ProductionSummary } from '@/lib/types';

const plural = (n: number) => (n === 1 ? 'бройка' : 'бройки');

const prepKey = (date: string) => `ff-prep-${date}`;

/** Daily prep list. Data from GET /orders/production; tick state is persisted to
 *  localStorage per date so a refresh / phone-sleep mid-harvest keeps your place.
 *  Progress is measured in бройки (units) everywhere so the numbers never clash. */
export function PrepList({
  summary,
  dateLabel,
  date,
}: {
  summary: ProductionSummary;
  dateLabel: string;
  date: string;
}) {
  const { items, confirmedOrders } = summary;
  const [done, setDone] = useState<Record<string, boolean>>({});

  const [farmerFilter, setFarmerFilter] = useState<string>('all');

  // Distinct farmers present in today's items (+ whether any item is unassigned).
  const { farmerList, hasUnassigned } = useMemo(() => {
    const m = new Map<string, string>();
    let unassigned = false;
    for (const it of items) {
      if (it.farmerId && it.farmerName) m.set(it.farmerId, it.farmerName);
      else unassigned = true;
    }
    return { farmerList: [...m.entries()], hasUnassigned: unassigned };
  }, [items]);

  const showFarmerFilter = summary.multiFarmer && (farmerList.length > 0 || hasUnassigned);

  // Items after applying the farmer filter.
  const shown = items.filter((it) => {
    if (farmerFilter === 'all') return true;
    if (farmerFilter === 'none') return !it.farmerId;
    return it.farmerId === farmerFilter;
  });

  // Hydrate ticks for the shown date (runs after mount → no SSR hydration clash).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(prepKey(date));
      setDone(raw ? (JSON.parse(raw) as Record<string, boolean>) : {});
    } catch {
      setDone({});
    }
  }, [date]);

  const totalQty = shown.reduce((s, r) => s + r.totalQty, 0);
  const doneQty = shown.filter((r) => done[r.productName]).reduce((s, r) => s + r.totalQty, 0);
  const allDone = totalQty > 0 && doneQty === totalQty;
  const toggle = (name: string) =>
    setDone((d) => {
      const next = { ...d, [name]: !d[name] };
      try {
        localStorage.setItem(prepKey(date), JSON.stringify(next));
      } catch {
        /* private mode / quota — ticks still work for this session */
      }
      return next;
    });

  return (
    <div className="animate-ff-fade-up">
      {/* Silent-failure guard: pending orders aren't in the prep list. Nudge the
          farmer to confirm them so nothing is forgotten before harvest. */}
      {summary.pendingOrders > 0 && (
        <Link
          href="/orders"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-2.5 transition hover:brightness-[0.98]"
        >
          <AlertTriangle size={16} className="shrink-0 text-ff-amber-600" />
          <span className="text-[12.5px] font-bold text-ff-amber-600">
            {summary.pendingOrders === 1
              ? '1 поръчка чака потвърждение — не е в списъка за бране. Потвърди я.'
              : `${summary.pendingOrders} поръчки чакат потвърждение — не са в списъка за бране. Потвърди ги.`}
          </span>
          <span className="ml-auto whitespace-nowrap text-[12.5px] font-extrabold text-ff-amber-600 underline">
            Към поръчките →
          </span>
        </Link>
      )}

      {/* summary + date pick */}
      <div className="mb-[18px] flex flex-wrap items-center justify-between gap-3">
        <p className="text-[15px] font-semibold text-ff-ink-2">
          <strong className="font-extrabold text-ff-ink">{confirmedOrders}</strong> потвърдени поръчки
          <span className="mx-2 text-ff-muted-2">·</span>
          <strong className="font-extrabold text-ff-ink">{totalQty}</strong> {plural(totalQty)} за приготвяне
        </p>
        {showFarmerFilter && (
          <select
            value={farmerFilter}
            onChange={(e) => setFarmerFilter(e.target.value)}
            aria-label="Филтър по фермер"
            className="rounded-xl border border-ff-border bg-ff-surface px-3.5 py-2.5 text-[13.5px] font-bold text-ff-ink-2 shadow-ff-sm transition-colors hover:bg-ff-surface-2"
          >
            <option value="all">Всички фермери</option>
            {farmerList.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
            {hasUnassigned && <option value="none">Без фермер</option>}
          </select>
        )}
        <DateNavBar date={date} dateLabel={dateLabel} />
      </div>

      <div className="grid grid-cols-[1fr_300px] items-start gap-4 max-[900px]:grid-cols-1">
        {/* prep list */}
        <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
          <div className="flex items-center justify-between border-b border-ff-border-2 px-[22px] pb-[15px] pt-[18px]">
            <h2 className="text-[17px] font-extrabold capitalize">За приготвяне — {dateLabel}</h2>
            <span className={cn('text-[13px] font-bold', allDone ? 'text-ff-green-700' : 'text-ff-muted')}>
              {doneQty}/{totalQty} готови
            </span>
          </div>

          {shown.map((r, i) => {
            const isDone = !!done[r.productName];
            return (
              <button
                key={r.productName}
                onClick={() => toggle(r.productName)}
                className={cn(
                  'grid w-full grid-cols-[auto_1fr_auto] items-center gap-[18px] px-[22px] py-5 text-left transition-colors hover:bg-ff-surface-2',
                  i < shown.length - 1 && 'border-b border-ff-border-2',
                )}
              >
                {/* checkbox */}
                <span
                  className={cn(
                    'grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white transition-colors',
                    isDone ? 'bg-ff-green-600' : 'border-2 border-ff-border bg-ff-surface',
                  )}
                >
                  {isDone && <Check size={17} strokeWidth={3} />}
                </span>

                {/* name + order count */}
                <div className="min-w-0">
                  <div
                    className={cn(
                      'text-[18px] font-extrabold tracking-[-0.01em]',
                      isDone ? 'text-ff-muted line-through decoration-ff-muted-2' : 'text-ff-ink',
                    )}
                  >
                    {r.productName}
                  </div>
                  <div className="mt-0.5 text-[13px] text-ff-muted">
                    от {r.orderCount} {r.orderCount === 1 ? 'поръчка' : 'поръчки'}
                  </div>
                </div>

                {/* qty */}
                <div className="flex shrink-0 items-baseline gap-1.5">
                  <span
                    className={cn(
                      'ff-fig text-[34px] font-extrabold leading-none tracking-[-0.03em]',
                      isDone ? 'text-ff-muted-2' : 'text-ff-green-700',
                    )}
                  >
                    {r.totalQty}
                  </span>
                  <span className="text-[15px] font-bold text-ff-muted">бр</span>
                </div>
              </button>
            );
          })}

          {shown.length === 0 && (
            <div className="px-5 py-14 text-center text-ff-muted">
              <div className="mx-auto mb-3 grid h-[52px] w-[52px] place-items-center rounded-[14px] bg-ff-green-50 text-ff-green-600">
                <ShoppingBasket size={28} />
              </div>
              <div className="text-[15px] font-bold text-ff-ink-2">Няма потвърдени поръчки</div>
              <div className="mt-0.5 text-[13.5px]">Потвърди поръчки, за да се появи списъкът за приготвяне.</div>
            </div>
          )}
        </div>

        {/* side: progress + tip */}
        <div className="sticky top-0 flex flex-col gap-4 max-[900px]:static">
          <div className="rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-3 text-[13.5px] font-bold text-ff-muted">Напредък</div>
            <div className="flex items-baseline gap-2">
              <span className="ff-fig text-[40px] font-extrabold tracking-[-0.03em] text-ff-ink">{doneQty}</span>
              <span className="text-[18px] font-bold text-ff-muted-2">/ {totalQty}</span>
            </div>
            <div className="mt-3.5 h-[9px] overflow-hidden rounded-full bg-ff-border-2">
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-300',
                  allDone ? 'bg-ff-green-600' : 'bg-ff-green-500',
                )}
                style={{ width: `${totalQty ? (doneQty / totalQty) * 100 : 0}%` }}
              />
            </div>
            <div
              className={cn(
                'mt-3 text-[13px] font-semibold leading-[1.4]',
                allDone ? 'text-ff-green-700' : 'text-ff-muted',
              )}
            >
              {allDone
                ? 'Всичко е приготвено — готов за доставка! 🌿'
                : `Остават ${totalQty - doneQty} от ${totalQty} ${plural(totalQty)}.`}
            </div>
          </div>

          <div className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="flex items-start gap-[11px]">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-ff-amber-softer text-ff-amber-600">
                <Clock size={19} />
              </span>
              <div>
                <div className="text-[14px] font-extrabold">Преди бране</div>
                <div className="mt-0.5 text-[13px] leading-[1.5] text-ff-ink-2">
                  Отмятай всеки продукт, докато го приготвяш. Списъкът се събира автоматично от потвърдените поръчки за деня.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
