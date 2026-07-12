'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Landmark, PackageOpen, CalendarClock, Coins } from 'lucide-react';
import { cn, moneyFromStotinki } from '@/lib/utils';
import { getTurnover } from '@/lib/api-client';
import type { TurnoverBreakdown, TurnoverBasis, StatsRange } from '@/lib/types';
import { TrendChart } from './trend-chart';
import { StatTile, errMsg } from '@/lib/stat-ui';

/** Explains what each basis means — the whole point of Task #9 is making this
 *  explicit instead of silently reporting against order-placed day. */
const BASIS_OPTIONS: { key: TurnoverBasis; label: string; hint: string }[] = [
  { key: 'placed', label: 'По дата на поръчка', hint: 'Денят, в който клиентът е направил поръчката.' },
  { key: 'delivery', label: 'По дата на доставка', hint: 'Денят, за който е насрочена доставката.' },
  { key: 'delivered', label: 'По дата на доставено', hint: 'Денят, в който поръчката РЕАЛНО е доставена (не влизат недоставени поръчки).' },
];

/**
 * Task #9/#10 — turnover with an explicit switchable basis, lifetime to-date
 * sums, platform income (honest 0 while the commission ledger is dormant), and
 * the undelivered slice/toggle. Separate section from the existing headline
 * "Оборот" tile above (which stays basis-implicit = order-placed, unchanged).
 */
export function TurnoverSection({
  range,
  applied,
  mode,
  farmerId,
}: {
  range: StatsRange;
  applied: { from: string; to: string } | null;
  mode: 'preset' | 'custom';
  /** Owner-only producer scope — mirrors the rest of the Статистика screen. */
  farmerId?: string;
}) {
  const [basis, setBasis] = useState<TurnoverBasis>('placed');
  const [includeUndelivered, setIncludeUndelivered] = useState(false);
  const [data, setData] = useState<TurnoverBreakdown | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (mode === 'custom' && !applied) return;
    let live = true;
    setLoading(true);
    const scope = farmerId ? { farmerId } : {};
    const req =
      mode === 'custom' && applied
        ? getTurnover({ from: applied.from, to: applied.to, basis, includeUndelivered, ...scope })
        : getTurnover({ range, basis, includeUndelivered, ...scope });
    req
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) toast.error(errMsg(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [mode, range, applied, basis, includeUndelivered, farmerId]);

  const activeBasis = BASIS_OPTIONS.find((o) => o.key === basis)!;
  // TrendChart expects StatsPoint's `orders` field name — adapt TurnoverPoint's
  // `orderCount` rather than duplicate the whole chart component.
  const chartPoints = data
    ? data.points.map((p) => ({ t: p.t, orders: p.orderCount, revenueStotinki: p.revenueStotinki }))
    : [];

  return (
    <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Landmark size={17} className="text-ff-green-700" />
          <h2 className="text-[16.5px] font-extrabold">Оборот — по период</h2>
        </div>
        <div className="inline-flex flex-wrap rounded-xl border border-ff-border bg-ff-surface p-0.5 shadow-ff-sm">
          {BASIS_OPTIONS.map((o) => (
            <button
              key={o.key}
              type="button"
              title={o.hint}
              onClick={() => setBasis(o.key)}
              className={cn(
                'rounded-lg px-2.5 py-1.5 text-[12px] font-bold transition-colors',
                basis === o.key ? 'bg-ff-green-700 text-[#EAF1E4]' : 'text-ff-ink-2 hover:bg-ff-surface-2',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">{activeBasis.hint}</p>

      {!data ? (
        <div className="py-10 text-center text-[13px] text-ff-muted">
          {loading ? 'Зареждане…' : 'Няма данни.'}
        </div>
      ) : (
        <div className={cn('flex flex-col gap-4 transition-opacity', loading && 'opacity-50')}>
          <div className="grid grid-cols-4 gap-3 max-[1024px]:grid-cols-2 max-[560px]:grid-cols-1">
            <StatTile
              Icon={Coins}
              label="Оборот за периода"
              value={moneyFromStotinki(data.turnoverStotinki)}
              sub={`${data.orderCount} поръчки`}
              index={0}
            />
            <StatTile
              Icon={CalendarClock}
              label="Оборот до момента"
              value={moneyFromStotinki(data.turnoverToDateStotinki)}
              sub="от началото на магазина"
              index={1}
            />
            <StatTile
              Icon={Landmark}
              label="Доход на платформата"
              value={data.commissionEnabled ? moneyFromStotinki(data.platformIncomeStotinki) : '—'}
              sub={data.commissionEnabled ? `${data.commissionRateBps / 100}% комисиона` : 'Комисионата е изключена'}
              index={2}
            />
            <StatTile
              Icon={Landmark}
              label="Доход на платформата до момента"
              value={data.commissionEnabled ? moneyFromStotinki(data.platformIncomeToDateStotinki) : '—'}
              sub={data.commissionEnabled ? 'от началото на магазина' : 'Комисионата е изключена'}
              index={3}
            />
          </div>

          <label className="inline-flex w-fit items-center gap-2 text-[13px] font-semibold text-ff-ink-2">
            <input
              type="checkbox"
              checked={includeUndelivered}
              onChange={(e) => setIncludeUndelivered(e.target.checked)}
              className="h-4 w-4 accent-ff-green-600"
            />
            Включвай недоставени поръчки в оборота
          </label>

          {(data.undeliveredOrderCount > 0 || !includeUndelivered) && (
            <div className="flex items-start gap-2 rounded-lg bg-ff-amber-softer px-3 py-2.5 text-[12.5px] leading-[1.45] text-ff-amber-600">
              <PackageOpen size={15} className="mt-0.5 shrink-0" />
              <span>
                Недоставени поръчки в периода:{' '}
                <b className="ff-fig">{moneyFromStotinki(data.undeliveredRevenueStotinki)}</b>
                {' '}({data.undeliveredOrderCount}{' '}
                {data.undeliveredOrderCount === 1 ? 'поръчка' : 'поръчки'})
                {!includeUndelivered && ' — изключени от сумите по-горе.'}
                {includeUndelivered && data.undeliveredOrderCount > 0 && ' — включени по-горе; тези пари все още не са прибрани.'}
              </span>
            </div>
          )}

          {chartPoints.length > 0 && <TrendChart points={chartPoints} bucket={data.bucket} metric="revenue" />}
        </div>
      )}
    </section>
  );
}
