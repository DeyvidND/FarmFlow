'use client';

import { useState } from 'react';
import { CalendarDays, ChevronDown, Check, ShoppingBasket, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProductionSummary } from '@/lib/types';

/** Daily prep list. Data from GET /orders/production; tick state is local UI only. */
export function PrepList({ summary, dateLabel }: { summary: ProductionSummary; dateLabel: string }) {
  const { items, confirmedOrders } = summary;
  const [done, setDone] = useState<Record<string, boolean>>({});

  const doneCount = items.filter((r) => done[r.productName]).length;
  const allDone = items.length > 0 && doneCount === items.length;
  const totalQty = items.reduce((s, r) => s + r.totalQty, 0);
  const toggle = (name: string) => setDone((d) => ({ ...d, [name]: !d[name] }));

  return (
    <div className="animate-ff-fade-up">
      {/* summary + date pick */}
      <div className="mb-[18px] flex flex-wrap items-center justify-between gap-3">
        <p className="text-[15px] font-semibold text-ff-ink-2">
          <strong className="font-extrabold text-ff-ink">{confirmedOrders}</strong> потвърдени поръчки
          <span className="mx-2 text-ff-muted-2">·</span>
          <strong className="font-extrabold text-ff-ink">{items.length}</strong> продукта за приготвяне
        </p>
        <div className="flex items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3.5 py-2.5 text-[13.5px] font-bold text-ff-ink-2 shadow-ff-sm">
          <CalendarDays size={17} />
          <span className="capitalize">{dateLabel}</span>
          <ChevronDown size={16} className="text-ff-muted" />
        </div>
      </div>

      <div className="grid grid-cols-[1fr_300px] items-start gap-4 max-[900px]:grid-cols-1">
        {/* prep list */}
        <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
          <div className="flex items-center justify-between border-b border-ff-border-2 px-[22px] pb-[15px] pt-[18px]">
            <h2 className="text-[17px] font-extrabold">За приготвяне днес</h2>
            <span className={cn('text-[13px] font-bold', allDone ? 'text-ff-green-700' : 'text-ff-muted')}>
              {doneCount}/{items.length} готови
            </span>
          </div>

          {items.map((r, i) => {
            const isDone = !!done[r.productName];
            return (
              <button
                key={r.productName}
                onClick={() => toggle(r.productName)}
                className={cn(
                  'grid w-full grid-cols-[auto_1fr_auto] items-center gap-[18px] px-[22px] py-5 text-left transition-colors hover:bg-ff-surface-2',
                  i < items.length - 1 && 'border-b border-ff-border-2',
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

          {items.length === 0 && (
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
              <span className="ff-fig text-[40px] font-extrabold tracking-[-0.03em] text-ff-ink">{doneCount}</span>
              <span className="text-[18px] font-bold text-ff-muted-2">/ {items.length}</span>
            </div>
            <div className="mt-3.5 h-[9px] overflow-hidden rounded-full bg-ff-border-2">
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-300',
                  allDone ? 'bg-ff-green-600' : 'bg-ff-green-500',
                )}
                style={{ width: `${items.length ? (doneCount / items.length) * 100 : 0}%` }}
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
                : `Общо ${totalQty} бройки за приготвяне.`}
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
                  Чекни всеки продукт, докато го приготвяш. Списъкът се събира автоматично от потвърдените поръчки за деня.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
