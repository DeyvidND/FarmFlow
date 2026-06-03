'use client';

/**
 * Shared presentational primitives for the Доставка (Delivery) page — ported from
 * the design prototype into the real FarmFlow Tailwind/token stack.
 */
import * as React from 'react';
import { Info, X, Check, Plus, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** Field input + label class strings (the project's settings-form convention). */
export const fieldCls =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-bold text-ff-ink outline-none transition-colors focus:border-ff-green-500';
export const fieldErrCls =
  'w-full rounded-sm border border-ff-red bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-bold text-ff-ink outline-none';
export const subHeadCls =
  'text-[13px] font-extrabold uppercase tracking-[0.03em] text-ff-ink';
export const subDescCls = 'mt-1 mb-3 max-w-[520px] text-[12.5px] leading-snug text-ff-muted';

export function DLabel({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-bold text-ff-ink-2">{label}</span>
      {children}
      {error ? (
        <span className="text-[12px] font-semibold text-ff-red">{error}</span>
      ) : hint ? (
        <span className="text-[12px] text-ff-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export function DSection({
  title,
  helper,
  action,
  info,
  locked,
  children,
}: {
  title: string;
  helper?: string;
  action?: React.ReactNode;
  info?: React.ReactNode;
  locked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[14px] border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
      <div className={cn('flex items-start justify-between gap-3', info ? 'mb-3.5' : 'mb-4')}>
        <div>
          <h2 className="font-display text-[15.5px] font-extrabold tracking-[-0.01em] text-ff-ink">
            {title}
          </h2>
          {helper && (
            <p className="mt-0.5 max-w-[560px] text-[13px] leading-snug text-ff-ink-2">{helper}</p>
          )}
        </div>
        {action}
      </div>
      {info && <InfoNote>{info}</InfoNote>}
      <div className={locked ? 'pointer-events-none opacity-50' : undefined}>{children}</div>
    </section>
  );
}

export function InfoNote({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'green';
}) {
  const green = tone === 'green';
  return (
    <div
      className={cn(
        'mb-4 flex gap-2.5 rounded-[10px] border px-3.5 py-3',
        green ? 'border-ff-green-100 bg-ff-green-50' : 'border-ff-border-2 bg-ff-surface-2',
      )}
    >
      <Info size={17} className="mt-px shrink-0 text-ff-green-600" />
      <p className="text-[13px] leading-relaxed text-ff-ink-2">{children}</p>
    </div>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegOption<T>[];
}) {
  return (
    <div className="inline-flex flex-wrap gap-[3px] rounded-[9px] border border-ff-border bg-ff-surface-2 p-[3px]">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              'whitespace-nowrap rounded-[7px] px-[13px] py-[7px] text-[13px] font-bold transition-colors',
              on ? 'bg-ff-surface text-ff-green-800 shadow-ff-sm' : 'text-ff-ink-2 hover:text-ff-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max = 999,
  suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const set = (v: number) => onChange(Math.max(min, Math.min(max, v)));
  const btn =
    'grid h-[34px] w-[34px] place-items-center rounded-sm border border-ff-border bg-ff-surface-2 text-ff-ink-2 transition-colors hover:bg-ff-green-50 hover:text-ff-green-700';
  return (
    <div className="inline-flex items-center gap-2">
      <button type="button" className={btn} onClick={() => set(value - 1)} aria-label="намали">
        <Minus size={16} />
      </button>
      <span className="ff-fig min-w-[44px] text-center text-[16px] font-extrabold">
        {value}
        {suffix ? ` ${suffix}` : ''}
      </span>
      <button type="button" className={btn} onClick={() => set(value + 1)} aria-label="увеличи">
        <Plus size={16} />
      </button>
    </div>
  );
}

export type BadgeTone = 'green' | 'amber' | 'gray' | 'red';

export function DBadge({
  tone = 'gray',
  dot = true,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: React.ReactNode;
}) {
  const pal: Record<BadgeTone, { box: string; dot: string }> = {
    green: { box: 'bg-ff-green-100 text-ff-green-700', dot: 'bg-ff-green-500' },
    amber: { box: 'bg-ff-amber-soft text-ff-amber-600', dot: 'bg-ff-amber' },
    gray: { box: 'bg-ff-badge-bg text-ff-badge-ink', dot: 'bg-ff-muted-2' },
    red: { box: 'bg-[#f7e0dc] text-ff-red', dot: 'bg-ff-red' },
  };
  const p = pal[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11.5px] font-extrabold',
        p.box,
      )}
    >
      {dot && <span className={cn('h-[6.5px] w-[6.5px] rounded-full', p.dot)} />}
      {children}
    </span>
  );
}

/** € input bound to integer cents. */
export function LvInput({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: number;
  onChange: (stotinki: number) => void;
  error?: string;
}) {
  const fmt = (s: number) => (s / 100).toFixed(2).replace('.', ',');
  const [txt, setTxt] = React.useState(() => fmt(value));
  React.useEffect(() => {
    setTxt(fmt(value));
  }, [value]);
  const commit = (s: string) => {
    setTxt(s);
    const n = parseFloat(s.replace(',', '.').replace(/[^\d.]/g, ''));
    if (!isNaN(n) && n >= 0) onChange(Math.round(n * 100));
  };
  return (
    <DLabel label={label} error={error}>
      <div className="relative">
        <input
          value={txt}
          inputMode="decimal"
          onChange={(e) => commit(e.target.value)}
          className={cn(error ? fieldErrCls : fieldCls, 'pr-9')}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] font-bold text-ff-muted">
          €
        </span>
      </div>
    </DLabel>
  );
}

export function Divider() {
  return <div className="h-px bg-ff-border-2" />;
}

// ---- Reusable help / explanation modal ----

export interface HelpStep {
  title: string;
  body: string;
}

export function HelpModal({
  title,
  eyebrow,
  intro,
  steps = [],
  tips = [],
  onClose,
}: {
  title: string;
  eyebrow?: string;
  intro?: string;
  steps?: HelpStep[];
  tips?: string[];
  onClose: () => void;
}) {
  return (
    <div
      className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="animate-ff-pop max-h-[92vh] w-[540px] max-w-full overflow-y-auto rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-ff-border-2 px-6 pb-4 pt-5">
          <div className="flex gap-3">
            <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-xl bg-ff-green-100 text-ff-green-700">
              <Info size={22} />
            </span>
            <div>
              {eyebrow && (
                <div className="mb-0.5 text-[12px] font-bold uppercase tracking-[0.03em] text-ff-muted">
                  {eyebrow}
                </div>
              )}
              <h2 className="font-display text-[20px] font-extrabold tracking-[-0.015em] text-ff-ink">
                {title}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Затвори"
            className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border border-ff-border bg-ff-surface-2 text-ff-ink-2 hover:bg-ff-green-50"
          >
            <X size={19} />
          </button>
        </div>

        <div className="px-6 pb-6 pt-5">
          {intro && <p className="mb-[18px] text-[14px] leading-relaxed text-ff-ink-2">{intro}</p>}

          {steps.length > 0 && (
            <div className="flex flex-col">
              {steps.map((s, i) => {
                const last = i === steps.length - 1;
                return (
                  <div key={i} className="flex gap-3.5">
                    <div className="flex flex-col items-center">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ff-green-700 text-[14px] font-extrabold text-white">
                        {i + 1}
                      </span>
                      {!last && <span className="my-1 w-0.5 flex-1 bg-ff-green-100" style={{ minHeight: 16 }} />}
                    </div>
                    <div className={cn('flex-1', last ? 'pb-0' : 'pb-[18px]')}>
                      <div className="mt-1 text-[14.5px] font-extrabold text-ff-ink">{s.title}</div>
                      <p className="mt-0.5 text-[13.5px] leading-relaxed text-ff-ink-2">{s.body}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tips.length > 0 && (
            <div className="mt-[18px] rounded-xl border border-ff-green-100 bg-ff-green-50 p-4">
              <div className="mb-2.5 text-[12.5px] font-extrabold uppercase tracking-[0.03em] text-ff-green-800">
                Полезно да знаеш
              </div>
              <div className="flex flex-col gap-2.5">
                {tips.map((t, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <Check size={16} strokeWidth={2.6} className="mt-px shrink-0 text-ff-green-600" />
                    <span className="text-[13.5px] leading-relaxed text-ff-ink-2">{t}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 flex justify-end">
            <Button variant="primary" size="sm" onClick={onClose}>
              <Check size={16} /> Разбрах
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
