'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Users, Eye, MousePointerClick, Target, Smartphone, Monitor,
  Globe, FileText, TrendingUp, CalendarDays,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAnalytics } from '@/lib/api-client';
import type { AnalyticsSummary, StatsRange } from '@/lib/types';
import { RANGES, errMsg, pctDelta, StatTile, ShareBar, Seg } from '@/lib/stat-ui';
import { AnalyticsTrendChart } from './analytics-trend-chart';

/** The funnel: each step a full-width bar scaled to the FIRST step, with the
 *  step's visitor count + the drop-off vs the previous step. */
function Funnel({ steps }: { steps: AnalyticsSummary['funnel'] }) {
  const top = steps[0]?.visitors ?? 0;

  // Weakest step: lowest keep-rate vs. the step right before it. Step 0 has no
  // prior step to compare against, so it's never eligible. A step with a 100%
  // (or higher) keep-rate has no actual drop-off, so it's never eligible either —
  // flagging it as "biggest drop-off here" would be misleading. If every step
  // keeps 100%, weakestIdx stays -1 and no badge renders, which is correct.
  let weakestIdx = -1;
  let weakestKeepPct = Infinity;
  steps.forEach((s, i) => {
    if (i === 0) return;
    const prevVisitors = steps[i - 1].visitors;
    if (prevVisitors <= 0) return; // nothing to compare against
    const keepPct = (s.visitors / prevVisitors) * 100;
    if (keepPct < 100 && keepPct < weakestKeepPct) {
      weakestKeepPct = keepPct;
      weakestIdx = i;
    }
  });

  return (
    <div className="flex flex-col gap-3">
      {steps.map((s, i) => {
        const pctOfTop = top > 0 ? Math.max(2, Math.round((s.visitors / top) * 100)) : 0;
        const prev = i > 0 ? steps[i - 1].visitors : null;
        const keepPct = prev && prev > 0 ? Math.round((s.visitors / prev) * 100) : null;
        const isWeakest = i === weakestIdx;
        return (
          <div key={s.key}>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[13.5px] font-bold text-ff-ink-2">
                {i + 1}. {s.label}
                {isWeakest && (
                  <span className="rounded-full bg-ff-amber-softer px-1.5 py-0.5 text-[10.5px] font-bold text-ff-amber-600">
                    най-голям отток тук
                  </span>
                )}
              </span>
              <span className="ff-fig text-[13px] text-ff-muted">
                {s.visitors}
                {keepPct !== null && <span className="ml-2 text-ff-muted-2">({keepPct}% от предната стъпка)</span>}
              </span>
            </div>
            <div className="h-[14px] overflow-hidden rounded-full bg-ff-border-2">
              <div
                className={cn(
                  'h-full rounded-full transition-[width]',
                  isWeakest ? 'bg-ff-amber' : 'bg-ff-green-600',
                )}
                style={{ width: `${pctOfTop}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WeekdayBars({ pattern }: { pattern: AnalyticsSummary['weekdayPattern'] }) {
  const max = Math.max(1, ...pattern.map((d) => d.visitors));
  const hasData = pattern.some((d) => d.visitors > 0);
  // Require a minimum sample before a day can be crowned "best" — otherwise a
  // single visitor who happens to convert can "win" with 100% over a day that
  // actually drove real volume (e.g. 200 visitors at 20% conversion).
  const MIN_VISITORS_FOR_BEST = 5;
  const best = hasData
    ? pattern.reduce(
        (a, b) => (b.visitors >= MIN_VISITORS_FOR_BEST && b.conversionPct > a.conversionPct ? b : a),
        pattern[0],
      )
    : null;
  const hasBestConversion = !!best && best.conversionPct > 0 && best.visitors >= MIN_VISITORS_FOR_BEST;

  if (!hasData) {
    return <p className="text-[13px] text-ff-muted">Още няма данни за периода.</p>;
  }

  return (
    <div>
      {hasBestConversion && (
        <p className="mb-3 text-[13px] font-semibold text-ff-ink-2">
          Най-силен ден: <span className="text-ff-green-700">{best!.label}</span> — {best!.conversionPct}% конверсия
        </p>
      )}
      <div className="flex items-end gap-2" style={{ height: 120 }}>
        {pattern.map((d) => {
          const h = Math.max(4, Math.round((d.visitors / max) * 100));
          const isBest = hasBestConversion && d === best;
          return (
            <div key={d.label} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex h-[92px] w-full items-end">
                <div
                  className={cn('w-full rounded-t-md transition-[height]', isBest ? 'bg-ff-green-600' : 'bg-ff-border-2')}
                  style={{ height: `${h}%` }}
                />
              </div>
              <span className="text-[11px] font-bold text-ff-muted">{d.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AnalyticsClient({ initial, role = 'admin' }: { initial: AnalyticsSummary | null; role?: string }) {
  const initPreset: StatsRange = initial && initial.range !== 'custom' ? (initial.range as StatsRange) : '30d';
  const [range, setRange] = useState<StatsRange>(initPreset);
  const [data, setData] = useState<AnalyticsSummary | null>(initial);
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [metric, setMetric] = useState<'visitors' | 'pageViews'>('visitors');

  useEffect(() => {
    if (!hydrated) {
      setHydrated(true);
      if (initial && initial.range === range) return;
    }
    let live = true;
    setLoading(true);
    getAnalytics({ range })
      .then((s) => { if (live) setData(s); })
      .catch((e) => { if (live) toast.error(errMsg(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const srcMax = data ? Math.max(1, ...data.sources.map((s) => s.visitors)) : 1;
  const pageMax = data ? Math.max(1, ...data.topPages.map((p) => p.views)) : 1;
  const devTotal = data ? data.devices.mobile + data.devices.desktop : 0;

  return (
    <div className="animate-ff-fade-up flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2.5">
          <div className="text-[15px] font-extrabold text-ff-ink">
            {role === 'farmer' ? 'Анализ на моя сайт' : 'Анализ на сайта'}
          </div>
          <div className="inline-flex flex-wrap rounded-xl border border-ff-border bg-ff-surface p-0.5 shadow-ff-sm">
            {RANGES.map((o) => (
              <button key={o.key} onClick={() => setRange(o.key)} aria-pressed={range === o.key}
                className={cn('rounded-lg px-3 py-1.5 text-[13px] font-bold transition-colors',
                  range === o.key ? 'bg-ff-green-700 text-[#EAF1E4]' : 'text-ff-ink-2 hover:bg-ff-surface-2')}>
                {o.label}
              </button>
            ))}
          </div>
          {data?.sparse && (
            <span className="text-[12.5px] text-ff-muted-2">· малко посещения — числата са ориентир, пробвай по-дълъг период</span>
          )}
        </div>
      </div>

      {!data ? (
        <div className="rounded-xl border border-ff-border bg-ff-surface px-5 py-12 text-center text-sm text-ff-muted shadow-ff-sm">
          Още няма данни за посещения. Появяват се, щом сайтът получи трафик.
        </div>
      ) : (
        <div className={cn('flex flex-col gap-5 transition-opacity', loading && 'opacity-50')}>
          <div className="grid grid-cols-4 gap-4 max-[1024px]:grid-cols-2 max-[640px]:grid-cols-1">
            <StatTile Icon={Users} label="Посетители" value={data.visitors} delta={pctDelta(data.visitors, data.prevVisitors)} index={0} />
            <StatTile Icon={Eye} label="Прегледи на страници" value={data.pageViews} sub="общо отваряния" index={1} />
            <StatTile Icon={MousePointerClick} label="Купили" value={data.purchases} sub="различни купувачи" index={2} />
            <StatTile Icon={Target} label="Конверсия" value={`${data.conversionPct}%`}
              delta={pctDelta(data.conversionPct, data.prevConversionPct)} index={3} />
          </div>

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
                  { key: 'visitors', label: 'Посетители' },
                  { key: 'pageViews', label: 'Прегледи' },
                ]}
              />
            </div>
            {data.points.length > 0 ? (
              <AnalyticsTrendChart points={data.points} bucket={data.bucket} metric={metric} />
            ) : (
              <div className="grid h-[276px] place-items-center text-sm text-ff-muted">
                Няма данни за периода.
              </div>
            )}
          </section>

          <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-1 flex items-center gap-2">
              <Target size={17} className="text-ff-green-700" />
              <h2 className="text-[16.5px] font-extrabold">Фуния към поръчка</h2>
            </div>
            <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">
              Колко души минават всяка стъпка — и къде най-много се отказват.
            </p>
            <Funnel steps={data.funnel} />
          </section>

          <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
            <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
              <div className="mb-1 flex items-center gap-2"><Globe size={17} className="text-ff-green-700" /><h2 className="text-[16.5px] font-extrabold">Откъде идват</h2></div>
              <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">Кои сайтове и търсачки водят хора при теб.</p>
              {data.sources.length === 0 ? <p className="text-[13px] text-ff-muted">Няма данни.</p> : (
                <div className="flex flex-col gap-3.5">
                  {data.sources.map((s) => <ShareBar key={s.host} label={s.host} value={s.visitors} max={srcMax} />)}
                </div>
              )}
            </section>
            <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
              <div className="mb-1 flex items-center gap-2"><FileText size={17} className="text-ff-green-700" /><h2 className="text-[16.5px] font-extrabold">Топ страници</h2></div>
              <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">Кои страници се гледат най-много.</p>
              {data.topPages.length === 0 ? <p className="text-[13px] text-ff-muted">Няма данни.</p> : (
                <div className="flex flex-col gap-3.5">
                  {data.topPages.map((p) => <ShareBar key={p.path} label={p.path} value={p.views} max={pageMax} />)}
                </div>
              )}
            </section>
          </div>

          <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-1 flex items-center gap-2"><Smartphone size={17} className="text-ff-green-700" /><h2 className="text-[16.5px] font-extrabold">Устройства</h2></div>
            <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">Телефон или компютър — с какво пазаруват.</p>
            <div className="flex flex-col gap-3.5">
              <ShareBar Icon={Smartphone} label="Телефон" value={data.devices.mobile} max={Math.max(1, devTotal)} />
              <ShareBar Icon={Monitor} label="Компютър" value={data.devices.desktop} max={Math.max(1, devTotal)} />
            </div>
          </section>

          <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-1 flex items-center gap-2">
              <CalendarDays size={17} className="text-ff-green-700" />
              <h2 className="text-[16.5px] font-extrabold">Дни от седмицата</h2>
            </div>
            <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">
              Кой ден носи най-много посещения и поръчки.
            </p>
            <WeekdayBars pattern={data.weekdayPattern} />
          </section>
        </div>
      )}
    </div>
  );
}
