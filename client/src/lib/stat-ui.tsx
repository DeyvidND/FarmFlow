import { TrendingUp, TrendingDown, Minus, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api-client';
import type { StatsRange } from '@/lib/types';

export const RANGES: { key: StatsRange; label: string }[] = [
  { key: '7d', label: '7 дни' },
  { key: '30d', label: '30 дни' },
  { key: '90d', label: '3 месеца' },
  { key: '1y', label: '1 година' },
];

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export type Delta = { dir: 'up' | 'down' | 'flat'; text: string };

/** Percent change of `cur` vs the equal previous period, as a labelled arrow. */
export function pctDelta(cur: number, prev: number): Delta {
  if (prev <= 0) return cur > 0 ? { dir: 'up', text: 'ново спрямо преди' } : { dir: 'flat', text: 'няма промяна' };
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return { dir: 'flat', text: 'колкото преди' };
  return { dir: pct > 0 ? 'up' : 'down', text: `${pct > 0 ? '+' : ''}${pct}% спрямо преди` };
}

export const DELTA_STYLE = {
  up: { Icon: TrendingUp, cls: 'text-ff-green-700' },
  down: { Icon: TrendingDown, cls: 'text-ff-amber-600' },
  flat: { Icon: Minus, cls: 'text-ff-muted' },
} as const;

/** Headline number card. `delta` colours the change; `sub` is plain text. */
export function StatTile({
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

/** One horizontal share bar (top products / payment split / sources / pages / devices). */
export function ShareBar({
  label,
  meta,
  value,
  max,
  Icon,
  variant = 'green',
}: {
  label: string;
  /** Defaults to String(value) when omitted (bare visitor/view counts). */
  meta?: string;
  value: number;
  max: number;
  Icon?: LucideIcon;
  variant?: 'green' | 'amber';
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
          <span className="ff-fig shrink-0 text-[12.5px] text-ff-muted">{meta ?? String(value)}</span>
        </div>
        <div className="h-[7px] overflow-hidden rounded-full bg-ff-border-2">
          <div
            className={cn('h-full rounded-full', variant === 'amber' ? 'bg-ff-amber' : 'bg-ff-green-500')}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/** Segmented pill selector (range / metric toggles). */
export function Seg<T extends string>({
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
