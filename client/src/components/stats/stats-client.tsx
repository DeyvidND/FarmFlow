'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Coins,
  Package,
  Wallet,
  Repeat,
  TrendingUp,
  TrendingDown,
  Minus,
  Info,
  Trophy,
  CreditCard,
  Banknote,
  PackageX,
  CalendarRange,
  type LucideIcon,
} from 'lucide-react';
import { cn, moneyFromStotinki } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { HelpModal } from '@/components/delivery/ui';
import { STATS_HELP } from '@/lib/help-content';
import { TrendChart } from './trend-chart';
import { ApiError, getStats } from '@/lib/api-client';
import type { StatsSummary, StatsRange } from '@/lib/types';

const RANGES: { key: StatsRange; label: string }[] = [
  { key: '7d', label: '7 дни' },
  { key: '30d', label: '30 дни' },
  { key: '90d', label: '3 месеца' },
  { key: '1y', label: '1 година' },
];

// dow index → BG day name (0=Sunday). Rendered Monday-first.
const DOW_SHORT = ['Нед', 'Пон', 'Вто', 'Сря', 'Чет', 'Пет', 'Съб'];
const DOW_FULL = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

const RANGE_NOUN: Record<StatsRange, string> = {
  '7d': 'последните 7 дни',
  '30d': 'последните 30 дни',
  '90d': 'последните 3 месеца',
  '1y': 'последната година',
};

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/** Segmented pill selector (range / metric). */
function Seg<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { key: T; label: string }[];
}) {
  return (
    <div className="inline-flex flex-wrap rounded-xl border border-ff-border bg-ff-surface p-0.5 shadow-ff-sm">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={cn(
            'rounded-lg px-3 py-1.5 text-[13px] font-bold transition-colors',
            value === o.key ? 'bg-ff-green-700 text-[#EAF1E4]' : 'text-ff-ink-2 hover:bg-ff-surface-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

type Delta = { dir: 'up' | 'down' | 'flat'; text: string };

/** Percent change of `cur` vs the equal previous period, as a labelled arrow. */
function pctDelta(cur: number, prev: number): Delta {
  if (prev <= 0) return cur > 0 ? { dir: 'up', text: 'ново спрямо преди' } : { dir: 'flat', text: 'няма промяна' };
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return { dir: 'flat', text: 'колкото преди' };
  return { dir: pct > 0 ? 'up' : 'down', text: `${pct > 0 ? '+' : ''}${pct}% спрямо преди` };
}

const DELTA_STYLE = {
  up: { Icon: TrendingUp, cls: 'text-ff-green-700' },
  down: { Icon: TrendingDown, cls: 'text-ff-amber-600' },
  flat: { Icon: Minus, cls: 'text-ff-muted' },
} as const;

/** Headline number card. `delta` colours the change; `sub` is plain text. */
function StatTile({
  Icon,
  label,
  value,
  delta,
  sub,
  index = 0,
}: {
  Icon: LucideIcon;
  label: string;
  value: string | number;
  delta?: Delta;
  sub?: string;
  index?: number;
}) {
  const d = delta ? DELTA_STYLE[delta.dir] : null;
  return (
    <div
      className="animate-ff-fade-up rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-[18px] shadow-ff-sm"
      style={{ animationDelay: `${index * 0.04}s` }}
    >
      <div className="grid h-[42px] w-[42px] place-items-center rounded-[11px] bg-ff-green-50 text-ff-green-700">
        <Icon size={22} />
      </div>
      <div className="ff-fig mt-3.5 text-[32px] font-extrabold tracking-[-0.02em] text-ff-ink">{value}</div>
      <div className="mt-0.5 text-[13.5px] font-bold text-ff-ink-2">{label}</div>
      {delta && d ? (
        <div className={cn('mt-[3px] flex items-center gap-1 text-[12.5px] font-semibold', d.cls)}>
          <d.Icon size={14} /> {delta.text}
        </div>
      ) : (
        <div className="mt-[3px] text-[12.5px] text-ff-muted">{sub}</div>
      )}
    </div>
  );
}

/** One horizontal share bar (top products / payment split). */
function ShareBar({
  label,
  meta,
  value,
  max,
  Icon,
  amber = false,
}: {
  label: string;
  meta: string;
  value: number;
  max: number;
  Icon?: LucideIcon;
  amber?: boolean;
}) {
  const pct = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      {Icon && (
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ff-surface-2 text-ff-ink-2">
          <Icon size={16} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-[13.5px] font-semibold text-ff-ink-2">{label}</span>
          <span className="ff-fig shrink-0 text-[12.5px] text-ff-muted">{meta}</span>
        </div>
        <div className="h-[7px] overflow-hidden rounded-full bg-ff-border-2">
          <div
            className={cn('h-full rounded-full', amber ? 'bg-ff-amber' : 'bg-ff-green-500')}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/** Muted chip marking a section whose numbers are thin (few orders in window). */
function SparseTag() {
  return (
    <span className="rounded-full bg-ff-surface-2 px-2 py-0.5 text-[11px] font-bold text-ff-muted-2">
      малко данни
    </span>
  );
}

export function StatsClient({ initial }: { initial: StatsSummary | null }) {
  const [range, setRange] = useState<StatsRange>(initial?.range ?? '30d');
  const [metric, setMetric] = useState<'orders' | 'revenue'>('revenue');
  const [data, setData] = useState<StatsSummary | null>(initial);
  const [loading, setLoading] = useState(false);
  const [help, setHelp] = useState(false);
  // Skip the first fetch when the server already handed us this range's data.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!hydrated && initial && initial.range === range) {
      setHydrated(true);
      return;
    }
    let live = true;
    setLoading(true);
    getStats(range)
      .then((s) => {
        if (live) setData(s);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const repeatPct =
    data && data.customerCount > 0 ? Math.round((data.returningCustomers / data.customerCount) * 100) : 0;
  const topMax = data ? Math.max(0, ...data.topProducts.map((p) => p.revenueStotinki)) : 0;
  const payMax = data ? Math.max(data.codRevenueStotinki, data.onlineRevenueStotinki) : 0;
  const weekMax = data ? Math.max(1, ...data.weekdayLoad.map((w) => w.orders)) : 1;
  const busiest =
    data && data.weekdayLoad.length ? data.weekdayLoad.reduce((a, b) => (b.orders > a.orders ? b : a)) : null;
  const byDow = (d: number) => data?.weekdayLoad.find((w) => w.dow === d) ?? { dow: d, orders: 0, revenueStotinki: 0 };

  return (
    <div className="animate-ff-fade-up flex flex-col gap-5">
      {/* header: period selector + help */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <Seg value={range} onChange={setRange} options={RANGES} />
          <span className="text-[13px] text-ff-muted">{RANGE_NOUN[range]}</span>
          {data?.sparse && (
            <span className="text-[12.5px] text-ff-muted-2">· малко поръчки — пробвай по-дълъг период</span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setHelp(true)}>
          <Info size={16} /> Обяснения
        </Button>
      </div>

      {!data ? (
        <div className="rounded-xl border border-ff-border bg-ff-surface px-5 py-12 text-center text-sm text-ff-muted shadow-ff-sm">
          Неуспешно зареждане на статистиката. Опитай да презаредиш страницата.
        </div>
      ) : (
        <div className={cn('flex flex-col gap-5 transition-opacity', loading && 'opacity-50')}>
          {/* headline numbers */}
          <div className="grid grid-cols-4 gap-4 max-[1024px]:grid-cols-2 max-[640px]:grid-cols-1">
            <StatTile
              Icon={Coins}
              label="Оборот"
              value={moneyFromStotinki(data.revenueStotinki)}
              delta={pctDelta(data.revenueStotinki, data.prevRevenueStotinki)}
              index={0}
            />
            <StatTile
              Icon={Package}
              label="Поръчки"
              value={data.orderCount}
              delta={pctDelta(data.orderCount, data.prevOrderCount)}
              index={1}
            />
            <StatTile
              Icon={Wallet}
              label="Средна поръчка"
              value={moneyFromStotinki(data.avgOrderStotinki)}
              sub="средно на поръчка"
              index={2}
            />
            {(
              <StatTile
                Icon={Repeat}
                label="Връщащи се клиенти"
                value={`${data.returningCustomers}/${data.customerCount}`}
                sub={`${repeatPct}% от клиентите за периода`}
                index={3}
              />
            )}
          </div>

          {/* top products + payment split */}
          {(
            <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
              <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
                <div className="mb-1 flex items-center gap-2">
                  <Trophy size={17} className="text-ff-green-700" />
                  <h2 className="text-[16.5px] font-extrabold">Топ продукти</h2>
                  {data.sparse && <SparseTag />}
                </div>
                <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">
                  Кое носи най-много пари — какво да зареждаш повече.
                </p>
                {data.topProducts.length === 0 ? (
                  <p className="text-[13px] text-ff-muted">Няма продадени продукти за периода.</p>
                ) : (
                  <div className="flex flex-col gap-3.5">
                    {data.topProducts.map((p) => (
                      <ShareBar
                        key={p.name}
                        label={p.name}
                        meta={`${moneyFromStotinki(p.revenueStotinki)} · ${p.quantity} бр.`}
                        value={p.revenueStotinki}
                        max={topMax}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
                <div className="mb-1 flex items-center gap-2">
                  <CreditCard size={17} className="text-ff-green-700" />
                  <h2 className="text-[16.5px] font-extrabold">Как плащат</h2>
                  {data.sparse && <SparseTag />}
                </div>
                <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">
                  Колко от парите идват с наложен платеж и колко с карта.
                </p>
                <div className="flex flex-col gap-3.5">
                  <ShareBar
                    Icon={Banknote}
                    amber
                    label="Наложен платеж"
                    meta={`${moneyFromStotinki(data.codRevenueStotinki)} · ${data.codOrders} бр.`}
                    value={data.codRevenueStotinki}
                    max={payMax}
                  />
                  <ShareBar
                    Icon={CreditCard}
                    label="Карта"
                    meta={`${moneyFromStotinki(data.onlineRevenueStotinki)} · ${data.onlineOrders} бр.`}
                    value={data.onlineRevenueStotinki}
                    max={payMax}
                  />
                </div>
              </section>
            </div>
          )}

          {/* slow products + weekday load */}
          {(
            <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
              <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
                <div className="mb-1 flex items-center gap-2">
                  <PackageX size={17} className="text-ff-amber-600" />
                  <h2 className="text-[16.5px] font-extrabold">Слабо продавани</h2>
                  {data.sparse && <SparseTag />}
                </div>
                <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">
                  Кое почти не се търси — обмисли намаление или го махни.
                </p>
                {data.slowProducts.length === 0 ? (
                  <p className="text-[13px] text-ff-muted">Няма активни продукти.</p>
                ) : (
                  <div className="flex flex-col">
                    {data.slowProducts.map((p) => (
                      <div
                        key={p.name}
                        className="flex items-center justify-between gap-3 border-b border-ff-border-2 py-2.5 last:border-0"
                      >
                        <span className="truncate text-[13.5px] font-semibold text-ff-ink-2">{p.name}</span>
                        {p.quantity === 0 ? (
                          <span className="shrink-0 rounded-full bg-ff-amber-softer px-2 py-0.5 text-[11.5px] font-bold text-ff-amber-600">
                            0 продажби
                          </span>
                        ) : (
                          <span className="ff-fig shrink-0 text-[12.5px] text-ff-muted">
                            {p.quantity} бр. · {moneyFromStotinki(p.revenueStotinki)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
                <div className="mb-1 flex items-center gap-2">
                  <CalendarRange size={17} className="text-ff-green-700" />
                  <h2 className="text-[16.5px] font-extrabold">Натоварени дни</h2>
                  {data.sparse && <SparseTag />}
                </div>
                <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">
                  {busiest && busiest.orders > 0 ? (
                    <>
                      Най-натоварен ден:{' '}
                      <span className="font-bold text-ff-ink-2">{DOW_FULL[busiest.dow]}</span> — пусни повече
                      часове за доставка.
                    </>
                  ) : (
                    'В кои дни идват най-много поръчки.'
                  )}
                </p>
                <div className="flex flex-col gap-2.5">
                  {MON_FIRST.map((d) => {
                    const w = byDow(d);
                    const pct = Math.round((w.orders / weekMax) * 100);
                    const top = busiest != null && busiest.orders > 0 && d === busiest.dow;
                    return (
                      <div key={d} className="flex items-center gap-3">
                        <span className="w-9 shrink-0 text-[12.5px] font-bold text-ff-ink-2">{DOW_SHORT[d]}</span>
                        <div className="h-[7px] flex-1 overflow-hidden rounded-full bg-ff-border-2">
                          <div
                            className={cn('h-full rounded-full', top ? 'bg-ff-green-600' : 'bg-ff-green-500')}
                            style={{ width: `${w.orders > 0 ? Math.max(4, pct) : 0}%` }}
                          />
                        </div>
                        <span className="ff-fig w-7 shrink-0 text-right text-[12.5px] text-ff-muted">{w.orders}</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          )}

          {/* trend */}
          <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <TrendingUp size={17} className="text-ff-green-700" />
                <h2 className="text-[16.5px] font-extrabold">Тренд</h2>
              </div>
              <Seg
                value={metric}
                onChange={setMetric}
                options={[
                  { key: 'revenue', label: 'Оборот' },
                  { key: 'orders', label: 'Поръчки' },
                ]}
              />
            </div>
            {data.points.length > 0 ? (
              <TrendChart points={data.points} bucket={data.bucket} metric={metric} />
            ) : (
              <div className="grid h-[240px] place-items-center text-sm text-ff-muted">
                Няма данни за периода.
              </div>
            )}
          </section>
        </div>
      )}

      {help && <HelpModal {...STATS_HELP} onClose={() => setHelp(false)} />}
    </div>
  );
}
