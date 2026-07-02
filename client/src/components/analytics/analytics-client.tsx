'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Users, Eye, MousePointerClick, Target, Smartphone, Monitor,
  TrendingUp, TrendingDown, Minus, Globe, FileText, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError, getAnalytics } from '@/lib/api-client';
import type { AnalyticsSummary, StatsRange } from '@/lib/types';

const RANGES: { key: StatsRange; label: string }[] = [
  { key: '7d', label: '7 дни' },
  { key: '30d', label: '30 дни' },
  { key: '90d', label: '3 месеца' },
  { key: '1y', label: '1 година' },
];

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

type Delta = { dir: 'up' | 'down' | 'flat'; text: string };
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

function StatTile({ Icon, label, value, delta, sub, index = 0 }: {
  Icon: LucideIcon; label: string; value: string | number; delta?: Delta; sub?: string; index?: number;
}) {
  const d = delta ? DELTA_STYLE[delta.dir] : null;
  return (
    <div className="animate-ff-fade-up rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-[18px] shadow-ff-sm"
      style={{ animationDelay: `${index * 0.04}s` }}>
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

/** The funnel: each step a full-width bar scaled to the FIRST step, with the
 *  step's visitor count + the drop-off vs the previous step. */
function Funnel({ steps }: { steps: AnalyticsSummary['funnel'] }) {
  const top = steps[0]?.visitors ?? 0;
  return (
    <div className="flex flex-col gap-3">
      {steps.map((s, i) => {
        const pctOfTop = top > 0 ? Math.max(2, Math.round((s.visitors / top) * 100)) : 0;
        const prev = i > 0 ? steps[i - 1].visitors : null;
        const keepPct = prev && prev > 0 ? Math.round((s.visitors / prev) * 100) : null;
        return (
          <div key={s.key}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-[13.5px] font-bold text-ff-ink-2">{i + 1}. {s.label}</span>
              <span className="ff-fig text-[13px] text-ff-muted">
                {s.visitors}
                {keepPct !== null && <span className="ml-2 text-ff-muted-2">({keepPct}% от предната стъпка)</span>}
              </span>
            </div>
            <div className="h-[14px] overflow-hidden rounded-full bg-ff-border-2">
              <div className="h-full rounded-full bg-ff-green-600 transition-[width]" style={{ width: `${pctOfTop}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ShareRow({ label, value, max, Icon }: { label: string; value: number; max: number; Icon?: LucideIcon }) {
  const pct = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      {Icon && <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ff-surface-2 text-ff-ink-2"><Icon size={16} /></span>}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-[13.5px] font-semibold text-ff-ink-2">{label}</span>
          <span className="ff-fig shrink-0 text-[12.5px] text-ff-muted">{value}</span>
        </div>
        <div className="h-[7px] overflow-hidden rounded-full bg-ff-border-2">
          <div className="h-full rounded-full bg-ff-green-500" style={{ width: `${pct}%` }} />
        </div>
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
                  {data.sources.map((s) => <ShareRow key={s.host} label={s.host} value={s.visitors} max={srcMax} />)}
                </div>
              )}
            </section>
            <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
              <div className="mb-1 flex items-center gap-2"><FileText size={17} className="text-ff-green-700" /><h2 className="text-[16.5px] font-extrabold">Топ страници</h2></div>
              <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">Кои страници се гледат най-много.</p>
              {data.topPages.length === 0 ? <p className="text-[13px] text-ff-muted">Няма данни.</p> : (
                <div className="flex flex-col gap-3.5">
                  {data.topPages.map((p) => <ShareRow key={p.path} label={p.path} value={p.views} max={pageMax} />)}
                </div>
              )}
            </section>
          </div>

          <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-1 flex items-center gap-2"><Smartphone size={17} className="text-ff-green-700" /><h2 className="text-[16.5px] font-extrabold">Устройства</h2></div>
            <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">Телефон или компютър — с какво пазаруват.</p>
            <div className="flex flex-col gap-3.5">
              <ShareRow Icon={Smartphone} label="Телефон" value={data.devices.mobile} max={Math.max(1, devTotal)} />
              <ShareRow Icon={Monitor} label="Компютър" value={data.devices.desktop} max={Math.max(1, devTotal)} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
