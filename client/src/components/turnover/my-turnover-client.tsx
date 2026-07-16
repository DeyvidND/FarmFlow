'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Wallet, PackageCheck, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { getRoute } from '@/lib/api-client';
import type { MultiRouteResult, CourierRoute } from '@/lib/types';
import { moneyFromStotinki, relDayLabel } from '@/lib/utils';
import { DateNavBar } from '@/components/production/date-nav-bar';

/**
 * «Моят оборот» — a courier's own turnover for one selected day. The
 * driver-scoped GET /orders/route already filters to the caller's leg and sums
 * its money per stop, so the leg IS the personal turnover; this screen just
 * presents it with a day filter (no map, no stop editing). `routes` empty means
 * the courier isn't on a route that day.
 */
export function MyTurnoverClient({
  initial,
  initialDate,
}: {
  initial: MultiRouteResult;
  initialDate: string;
}) {
  const [date, setDate] = useState(initialDate);
  const [route, setRoute] = useState<MultiRouteResult>(initial);
  const [loading, setLoading] = useState(false);
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    let live = true;
    setLoading(true);
    getRoute({ date })
      .then((r) => {
        if (live) setRoute(r);
      })
      .catch(() => {
        if (live) toast.error('Оборотът не можа да се зареди');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [date]);

  // Driver-scoped: the API returns only the caller's own leg, so the first (and
  // only) route is theirs. Empty = not on a route this day.
  const leg: CourierRoute | null = route.routes[0] ?? null;
  const stops = leg?.stops ?? [];

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Моят оборот</h1>
          <p className="text-[13.5px] text-ff-muted">Оборотът от твоите доставки за избрания ден.</p>
        </div>
        <DateNavBar date={date} dateLabel={relDayLabel(date)} onSelect={setDate} hrefBase="/my-turnover" />
      </div>

      {loading && (
        <p className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-ff-muted">
          <Loader2 size={14} className="animate-spin" /> Зареждане…
        </p>
      )}

      {leg == null || stops.length === 0 ? (
        <div className="rounded-xl border border-ff-border bg-ff-surface px-5 py-12 text-center text-[13.5px] text-ff-muted shadow-ff-sm">
          <PackageCheck size={28} className="mx-auto mb-2 text-ff-muted-2" />
          На избрания ден нямаш доставки в маршрут.
        </div>
      ) : (
        <>
          {/* Hero turnover card */}
          <div className="rounded-2xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-5 shadow-ff-sm">
            <div className="flex items-center gap-2 text-[13px] font-bold text-ff-muted">
              <Wallet size={16} className="text-ff-green-700" /> Оборот за деня
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="ff-fig text-[40px] font-extrabold leading-none tracking-[-0.03em] text-ff-ink">
                {moneyFromStotinki(leg.totalStotinki)}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <Stat label="Стоки" value={moneyFromStotinki(leg.itemsSubtotalStotinki)} />
              <Stat label="Доставки" value={moneyFromStotinki(leg.deliveryFeeStotinki)} />
              <Stat label="Поръчки" value={String(stops.length)} />
            </div>
          </div>

          {/* Per-order breakdown */}
          <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
            <div className="flex items-center justify-between border-b border-ff-border-2 px-[18px] pb-[13px] pt-4">
              <h2 className="inline-flex items-center gap-1.5 text-[15px] font-extrabold">
                <TrendingUp size={16} className="text-ff-muted" /> Поръчки в маршрута
              </h2>
              <span className="text-[12.5px] font-bold text-ff-muted">
                {stops.length} {stops.length === 1 ? 'поръчка' : 'поръчки'}
              </span>
            </div>
            <ul>
              {stops.map((s, i) => (
                <li
                  key={s.id}
                  className={
                    'flex items-center justify-between gap-3 px-[18px] py-3' +
                    (i < stops.length - 1 ? ' border-b border-ff-border-2' : '')
                  }
                >
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-bold text-ff-ink-2">
                      {s.customer ?? 'Клиент'}
                    </div>
                    {s.summary && (
                      <div className="mt-0.5 truncate text-[12.5px] text-ff-muted">{s.summary}</div>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="ff-fig text-[15px] font-extrabold text-ff-green-700">
                      {moneyFromStotinki(s.totalStotinki)}
                    </div>
                    {s.deliveryFeeStotinki > 0 && (
                      <div className="text-[11.5px] text-ff-muted">
                        от тях доставка {moneyFromStotinki(s.deliveryFeeStotinki)}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-ff-surface-2 px-3 py-2.5">
      <div className="text-[11.5px] font-bold text-ff-muted">{label}</div>
      <div className="ff-fig mt-0.5 text-[17px] font-extrabold text-ff-ink">{value}</div>
    </div>
  );
}
