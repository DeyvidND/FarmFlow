'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Repeat, Check, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ApiError, saveSlotRule } from '@/lib/api-client';
import type { SlotRule, SlotRuleInput, SlotDay, SlotWindow } from '@/lib/types';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2 text-[14px] font-bold text-ff-ink outline-none focus:border-ff-green-500';
const lbl = 'flex flex-col gap-1 text-[12.5px] font-bold text-ff-ink-2';

// Mon-first, Sunday last — the order farmers read a week in.
// Also used by the pickup method's fixed-schedule picker in methods-section.tsx
// (a single fixed pickup day, not a recurring slot rule) — don't assume this is
// slot-rule-private when touching it.
export const WD = [
  { i: 1, l: 'Пн' },
  { i: 2, l: 'Вт' },
  { i: 3, l: 'Ср' },
  { i: 4, l: 'Чт' },
  { i: 5, l: 'Пт' },
  { i: 6, l: 'Сб' },
  { i: 0, l: 'Нд' },
];
const DOW_LABEL: Record<number, string> = Object.fromEntries(WD.map((d) => [d.i, d.l]));

// 24h options, 30-min steps, 05:00–22:00 — no AM/PM, no free typing. Only used
// by WindowFields below (the slot rule itself is day-based now, no hours).
const TIMES = (() => {
  const out: string[] = [];
  for (let m = 5 * 60; m <= 22 * 60; m += 30) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
})();

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Sorted unique options that always include `v` — so an off-grid legacy time
 *  (e.g. 09:45 from the old free time input) still shows instead of a blank select. */
const withValue = (opts: string[], v: string) =>
  opts.includes(v) ? opts : [...opts, v].sort();

/** Start/end (24h selects, end always after start). NOT used by the slot rule
 *  anymore (day-based, no hours) — kept only because the pickup method's fixed-
 *  schedule picker in methods-section.tsx reuses it for its own hours field. */
export function WindowFields({
  win,
  onChange,
}: {
  win: SlotWindow;
  onChange: (w: SlotWindow) => void;
}) {
  const setFrom = (timeFrom: string) => {
    // Keep end strictly after start — pick the next valid slot if it slipped behind.
    const timeTo = win.timeTo > timeFrom ? win.timeTo : (TIMES.find((t) => t > timeFrom) ?? timeFrom);
    onChange({ ...win, timeFrom, timeTo });
  };
  const startOpts = withValue(TIMES.slice(0, -1), win.timeFrom);
  const endOpts = withValue(TIMES.filter((t) => t > win.timeFrom), win.timeTo);
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className={lbl}>
        Начало
        <select value={win.timeFrom} onChange={(e) => setFrom(e.target.value)} className={field}>
          {startOpts.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className={lbl}>
        Край
        <select value={win.timeTo} onChange={(e) => onChange({ ...win, timeTo: e.target.value })} className={field}>
          {endOpts.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

interface State {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  days: SlotDay[];
  sameCapacity: boolean;
  sharedCapacity: number; // the capacity applied to all days when sameCapacity is on
  intervalDays: number;
  intervalCapacity: number;
  anchorDate: string;
  customerNote: string;
  driverNote: string;
  horizonDays: number;
  skipDates: string[];
}

const clampCap = (n: number) => Math.min(500, Math.max(1, n || 1));

function initialState(initial: SlotRule | null): State {
  if (!initial) {
    return {
      active: false,
      repeat: 'weekdays',
      days: [1, 3, 5].map((dow) => ({ dow, capacity: 1 })),
      sameCapacity: true,
      sharedCapacity: 1,
      intervalDays: 3,
      intervalCapacity: 1,
      anchorDate: todayIso(),
      customerNote: '',
      driverNote: '',
      horizonDays: 28,
      skipDates: [],
    };
  }
  const days = initial.days?.length ? initial.days : [{ dow: 1, capacity: 1 }];
  const sharedCapacity = days[0].capacity;
  return {
    active: initial.active,
    repeat: initial.repeat,
    days,
    sameCapacity: days.every((d) => d.capacity === sharedCapacity),
    sharedCapacity,
    intervalDays: initial.intervalDays,
    intervalCapacity: initial.intervalCapacity ?? 1,
    anchorDate: initial.anchorDate,
    customerNote: initial.customerNote ?? '',
    driverNote: initial.driverNote ?? '',
    horizonDays: initial.horizonDays,
    skipDates: initial.skipDates ?? [],
  };
}

export function RecurrenceCard({ initial, onSaved }: { initial: SlotRule | null; onSaved: () => void }) {
  const [s, setS] = useState<State>(() => initialState(initial));
  // This card mounts in two places (Delivery page + Slots page). Each has its
  // own fetch, so a save in one only refreshes that host's `initial` prop —
  // re-seed here too, or the other mount keeps showing what it loaded at mount
  // time even after `initial` moves on (stale read on next open/reload).
  const seededRef = useRef(initial);
  useEffect(() => {
    if (initial !== seededRef.current) {
      seededRef.current = initial;
      setS(initialState(initial));
    }
  }, [initial]);
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<State>) => setS((prev) => ({ ...prev, ...p }));

  // The everyday form is just days + capacity. Start date and notes are
  // optional — fold them away, but auto-open if an existing rule already uses them.
  const [showAdvanced, setShowAdvanced] = useState(
    () => !!initial && (!!initial.customerNote || !!initial.driverNote),
  );

  const pickedDows = useMemo(() => new Set(s.days.map((d) => d.dow)), [s.days]);

  const toggleDay = (dow: number) => {
    if (pickedDows.has(dow)) {
      set({ days: s.days.filter((d) => d.dow !== dow) });
    } else {
      // New day inherits the shared capacity so the common case stays one decision.
      set({ days: [...s.days, { dow, capacity: s.sharedCapacity }] });
    }
  };

  const setSameCapacity = (on: boolean) => {
    if (on) {
      set({ sameCapacity: true });
    } else {
      // Seed each day from the shared capacity, then let them diverge.
      set({ sameCapacity: false, days: s.days.map((d) => ({ dow: d.dow, capacity: s.sharedCapacity })) });
    }
  };

  const setDayCapacity = (dow: number, capacity: number) =>
    set({ days: s.days.map((d) => (d.dow === dow ? { dow, capacity } : d)) });

  // Days in week order (Mon-first), for the per-day rows.
  const orderedDays = WD.map((w) => s.days.find((d) => d.dow === w.i)).filter(Boolean) as SlotDay[];

  async function save() {
    setSaving(true);
    try {
      const days = (s.sameCapacity ? [...pickedDows].map((dow) => ({ dow, capacity: s.sharedCapacity })) : s.days).map(
        (d) => ({ dow: d.dow, capacity: clampCap(d.capacity) }),
      );
      const rule: SlotRuleInput = {
        active: s.active,
        repeat: s.repeat,
        days,
        intervalDays: s.intervalDays,
        intervalCapacity: clampCap(s.intervalCapacity),
        anchorDate: s.anchorDate,
        customerNote: s.customerNote || undefined,
        driverNote: s.driverNote || undefined,
        horizonDays: s.horizonDays,
      };
      await saveSlotRule(rule);
      toast.success(s.active ? 'Правилото е запазено — дните се отварят напред' : 'Правилото е изключено');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-[14px] border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-ff-green-50 text-ff-green-700">
            <Repeat size={18} />
          </span>
          <div>
            <div className="text-[15px] font-extrabold text-ff-ink">Повтарящи се дни за доставка</div>
            <div className="text-[12.5px] text-ff-muted">
              Задай веднъж — дните се отварят напред автоматично. Клиентът избира ден, а не час; ти решаваш
              колко поръчки поемаш на ден.
            </div>
          </div>
        </div>
        <ToggleSwitch checked={s.active} onChange={(v) => set({ active: v })} />
      </div>

      {/* Configurability is the whole point — say it plainly. */}
      <p className="mb-3 rounded-lg border border-ff-green-100 bg-ff-green-50/60 px-3 py-2 text-[12.5px] leading-relaxed text-ff-ink-2">
        Нагласи го според <b>реалната си наличност</b>: избери само дните, в които доставяш, и реши колко
        поръчки поемаш всеки от тях. Не можеш в някой ден? Просто не го избирай. Клиентите в магазина
        виждат само отворените дни — само тях могат да изберат.
      </p>

      <div className={cn('flex flex-col gap-3', !s.active && 'pointer-events-none opacity-50')}>
        <div className="flex gap-2">
          {(['weekdays', 'interval'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => set({ repeat: m })}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-[13px] font-bold',
                s.repeat === m
                  ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-700'
                  : 'border-ff-border text-ff-ink-2',
              )}
            >
              {m === 'weekdays' ? 'По дни от седмицата' : 'През N дни'}
            </button>
          ))}
        </div>

        {s.repeat === 'weekdays' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-bold text-ff-ink-2">Дни, в които доставяш</span>
              <div className="flex flex-wrap gap-1.5">
                {WD.map((d) => (
                  <button
                    key={d.i}
                    type="button"
                    onClick={() => toggleDay(d.i)}
                    className={cn(
                      'h-9 w-9 rounded-lg border text-[12.5px] font-bold transition-colors',
                      pickedDows.has(d.i)
                        ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-700'
                        : 'border-ff-border text-ff-ink-2 hover:border-ff-green-300',
                    )}
                  >
                    {d.l}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center justify-between gap-3 rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-2">
              <span className="flex flex-col">
                <span className="text-[13px] font-bold text-ff-ink">Еднакъв капацитет за всички дни</span>
                <span className="text-[12px] text-ff-muted">
                  Изключи, за да зададеш различен капацитет за всеки ден.
                </span>
              </span>
              <ToggleSwitch checked={s.sameCapacity} onChange={setSameCapacity} />
            </label>

            {s.sameCapacity ? (
              <label className={cn(lbl, 'max-w-[14rem]')}>
                Колко поръчки на ден
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={s.sharedCapacity}
                  onChange={(e) => set({ sharedCapacity: clampCap(parseInt(e.target.value, 10)) })}
                  className={field}
                />
              </label>
            ) : orderedDays.length ? (
              <div className="flex flex-col gap-2">
                {orderedDays.map((d) => (
                  <label key={d.dow} className="flex items-center justify-between gap-3">
                    <span className="text-[13px] font-extrabold text-ff-green-800">
                      {DOW_LABEL[d.dow]} — колко доставки?
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={d.capacity}
                      onChange={(e) => setDayCapacity(d.dow, clampCap(parseInt(e.target.value, 10)))}
                      className={cn(field, 'w-24')}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-ff-muted">Избери поне един ден по-горе.</p>
            )}
          </>
        ) : (
          <>
            <label className={cn(lbl, 'max-w-[12rem]')}>
              През колко дни
              <input
                value={String(s.intervalDays)}
                onChange={(e) => set({ intervalDays: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                inputMode="numeric"
                className={field}
              />
            </label>
            <label className={cn(lbl, 'max-w-[14rem]')}>
              Колко поръчки на ден
              <input
                type="number"
                min={1}
                max={500}
                value={s.intervalCapacity}
                onChange={(e) => set({ intervalCapacity: clampCap(parseInt(e.target.value, 10)) })}
                className={field}
              />
            </label>
          </>
        )}

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1.5 self-start text-[12.5px] font-bold text-ff-green-700 hover:underline"
        >
          {showAdvanced ? 'Скрий разширените настройки' : 'Разширени настройки (по избор)'}
          <ChevronDown size={15} className={cn('transition-transform', showAdvanced && 'rotate-180')} />
        </button>

        {showAdvanced && (
          <>
            <label className={cn(lbl, 'max-w-[14rem]')}>
              Започва от <span className="font-normal text-ff-muted">(по избор · по подразбиране днес)</span>
              <input
                type="date"
                value={s.anchorDate}
                onChange={(e) => set({ anchorDate: e.target.value })}
                className={field}
              />
            </label>

            <label className={lbl}>
              Бележка за клиента <span className="font-normal text-ff-muted">(по избор · в магазина)</span>
              <input
                value={s.customerNote}
                onChange={(e) => set({ customerNote: e.target.value })}
                maxLength={280}
                placeholder="напр. Ще се обадя преди доставка"
                className={field}
              />
            </label>
            <label className={lbl}>
              Бележка за доставчика <span className="font-normal text-ff-muted">(по избор · само за теб)</span>
              <input
                value={s.driverNote}
                onChange={(e) => set({ driverNote: e.target.value })}
                maxLength={500}
                placeholder="напр. маршрут + телефон"
                className={field}
              />
            </label>
          </>
        )}
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant="primary" size="sm" onClick={save} disabled={saving} className="rounded-sm">
          <Check size={16} /> {saving ? 'Записване…' : 'Запази правилото'}
        </Button>
      </div>
    </div>
  );
}
