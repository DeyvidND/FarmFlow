'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Repeat, Check, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ApiError, saveSlotRule } from '@/lib/api-client';
import { splitWindowChunks, toMin } from '@/lib/slot-chunks';
import type { SlotRule, SlotRuleInput, SlotDay, SlotWindow } from '@/lib/types';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2 text-[14px] font-bold text-ff-ink outline-none focus:border-ff-green-500';
const lbl = 'flex flex-col gap-1 text-[12.5px] font-bold text-ff-ink-2';

// Mon-first, Sunday last — the order farmers read a week in.
const WD = [
  { i: 1, l: 'Пн' },
  { i: 2, l: 'Вт' },
  { i: 3, l: 'Ср' },
  { i: 4, l: 'Чт' },
  { i: 5, l: 'Пт' },
  { i: 6, l: 'Сб' },
  { i: 0, l: 'Нд' },
];
const DOW_LABEL: Record<number, string> = Object.fromEntries(WD.map((d) => [d.i, d.l]));

// 24h options, 30-min steps, 05:00–22:00 — no AM/PM, no free typing.
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

const DEFAULT_WIN: SlotWindow = { timeFrom: '10:00', timeTo: '12:00' };

// How long one delivery takes. 0 = the whole window is a single slot.
const SLOT_LEN = [
  { v: 0, l: 'Без разделяне — целият прозорец е един час' },
  { v: 30, l: '30 минути' },
  { v: 45, l: '45 минути' },
  { v: 60, l: '1 час' },
  { v: 90, l: '1 час и 30 мин' },
  { v: 120, l: '2 часа' },
  { v: 180, l: '3 часа' },
];

/** Two same windows? Used to decide whether "same hours for all" starts on. */
const sameWin = (a: SlotWindow, b: SlotWindow) =>
  a.timeFrom === b.timeFrom && a.timeTo === b.timeTo;

/** Sorted unique options that always include `v` — so an off-grid legacy time
 *  (e.g. 09:45 from the old free time input) still shows instead of a blank select. */
const withValue = (opts: string[], v: string) =>
  opts.includes(v) ? opts : [...opts, v].sort();

/** Start/end (24h selects, end always after start). Each slot holds one order — no capacity. */
function WindowFields({
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
  sameHours: boolean;
  shared: SlotWindow; // the window applied to all days when sameHours is on
  intervalDays: number;
  intervalWindow: SlotWindow;
  anchorDate: string;
  slotMinutes: number;
  customerNote: string;
  driverNote: string;
  horizonDays: number;
  skipDates: string[];
}

function initialState(initial: SlotRule | null): State {
  if (!initial) {
    return {
      active: false,
      repeat: 'weekdays',
      days: [1, 3, 5].map((dow) => ({ dow, ...DEFAULT_WIN })),
      sameHours: true,
      shared: { ...DEFAULT_WIN },
      intervalDays: 3,
      intervalWindow: { ...DEFAULT_WIN },
      anchorDate: todayIso(),
      slotMinutes: 0,
      customerNote: '',
      driverNote: '',
      horizonDays: 28,
      skipDates: [],
    };
  }
  const days = initial.days?.length ? initial.days : [{ dow: 1, ...DEFAULT_WIN }];
  const shared: SlotWindow = { timeFrom: days[0].timeFrom, timeTo: days[0].timeTo };
  return {
    active: initial.active,
    repeat: initial.repeat,
    days,
    sameHours: days.every((d) => sameWin(d, shared)),
    shared,
    intervalDays: initial.intervalDays,
    intervalWindow: initial.intervalWindow ?? { ...DEFAULT_WIN },
    anchorDate: initial.anchorDate,
    slotMinutes: initial.slotMinutes ?? 0,
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

  // The everyday form is just days + hours. Slot length, start date and notes are
  // optional — fold them away, but auto-open if an existing rule already uses them.
  const [showAdvanced, setShowAdvanced] = useState(
    () => !!initial && ((initial.slotMinutes ?? 0) !== 0 || !!initial.customerNote || !!initial.driverNote),
  );

  const pickedDows = useMemo(() => new Set(s.days.map((d) => d.dow)), [s.days]);

  const toggleDay = (dow: number) => {
    if (pickedDows.has(dow)) {
      set({ days: s.days.filter((d) => d.dow !== dow) });
    } else {
      // New day inherits the shared window so the common case stays one decision.
      set({ days: [...s.days, { dow, ...s.shared }] });
    }
  };

  const setSameHours = (on: boolean) => {
    if (on) {
      set({ sameHours: true });
    } else {
      // Seed each day from the shared window, then let them diverge.
      set({ sameHours: false, days: s.days.map((d) => ({ dow: d.dow, ...s.shared })) });
    }
  };

  const setDayWindow = (dow: number, win: SlotWindow) =>
    set({ days: s.days.map((d) => (d.dow === dow ? { dow, ...win } : d)) });

  // Days in week order (Mon-first), for the per-day rows.
  const orderedDays = WD.map((w) => s.days.find((d) => d.dow === w.i)).filter(Boolean) as SlotDay[];

  async function save() {
    setSaving(true);
    try {
      // Strip any field other than the window's hours. Legacy rules stored a
      // per-window `maxOrders` (capacity, since removed); it survives in state
      // (loaded raw from the saved rule, spread through edits) and the server's
      // strict DTO rejects it ("intervalWindow.property maxOrders should not
      // exist"). Send only timeFrom/timeTo. The first clean save lets the server
      // rewrite the stored rule without the stale field, so this self-heals.
      const cleanWin = (w: SlotWindow): SlotWindow => ({ timeFrom: w.timeFrom, timeTo: w.timeTo });
      const days = (s.sameHours ? [...pickedDows].map((dow) => ({ dow, ...s.shared })) : s.days).map(
        (d) => ({ dow: d.dow, ...cleanWin(d) }),
      );
      const rule: SlotRuleInput = {
        active: s.active,
        repeat: s.repeat,
        days,
        intervalDays: s.intervalDays,
        intervalWindow: cleanWin(s.intervalWindow),
        anchorDate: s.anchorDate,
        slotMinutes: s.slotMinutes,
        customerNote: s.customerNote || undefined,
        driverNote: s.driverNote || undefined,
        horizonDays: s.horizonDays,
      };
      await saveSlotRule(rule);
      toast.success(s.active ? 'Правилото е запазено — часовете се попълват' : 'Правилото е изключено');
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
            <div className="text-[15px] font-extrabold text-ff-ink">Повтарящи се часове</div>
            <div className="text-[12.5px] text-ff-muted">
              Задай веднъж — часовете се появяват напред автоматично.
            </div>
          </div>
        </div>
        <ToggleSwitch checked={s.active} onChange={(v) => set({ active: v })} />
      </div>

      {/* Configurability is the whole point — say it plainly. */}
      <p className="mb-3 rounded-lg border border-ff-green-100 bg-ff-green-50/60 px-3 py-2 text-[12.5px] leading-relaxed text-ff-ink-2">
        Нагласи го според <b>реалната си наличност</b>: избери само дните, в които доставяш, и дай на всеки ден
        собствени часове. Всеки час е за 1 поръчка. Не можеш в някой ден? Просто не го избирай. Клиентите в
        магазина виждат точно тези часове — само свободните.
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
                <span className="text-[13px] font-bold text-ff-ink">Еднакви часове за всички дни</span>
                <span className="text-[12px] text-ff-muted">
                  Изключи, за да зададеш различни часове за всеки ден.
                </span>
              </span>
              <ToggleSwitch checked={s.sameHours} onChange={setSameHours} />
            </label>

            {s.sameHours ? (
              <WindowFields win={s.shared} onChange={(w) => set({ shared: w })} />
            ) : orderedDays.length ? (
              <div className="flex flex-col gap-3">
                {orderedDays.map((d) => (
                  <div key={d.dow} className="rounded-lg border border-ff-border-2 bg-ff-surface-2/40 p-3">
                    <div className="mb-2 text-[13px] font-extrabold text-ff-green-800">{DOW_LABEL[d.dow]}</div>
                    <WindowFields win={d} onChange={(w) => setDayWindow(d.dow, w)} />
                  </div>
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
            <WindowFields win={s.intervalWindow} onChange={(w) => set({ intervalWindow: w })} />
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
        {(() => {
          // Live preview of what the chosen slot length produces, so the farmer
          // sees the result before saving. Per-day hours → generic hint instead.
          const perDay = s.repeat === 'weekdays' && !s.sameHours;
          const win = s.repeat === 'interval' ? s.intervalWindow : s.shared;
          const fits = toMin(win.timeTo) - toMin(win.timeFrom) >= s.slotMinutes;
          const parts = splitWindowChunks(win, s.slotMinutes).map((c) => `${c.timeFrom}–${c.timeTo}`);
          const preview = perDay
            ? 'Прозорецът на всеки ден се разделя според собствените му часове — по 1 поръчка на час.'
            : s.slotMinutes === 0
              ? `Един час на ден: ${win.timeFrom}–${win.timeTo} — 1 поръчка.`
              : !fits
                ? `Прозорецът е по-къс от времетраенето — остава един час ${parts[0]} (1 поръчка).`
                : `${parts.length} ${parts.length === 1 ? 'час' : 'часа'} на ден: ${parts.slice(0, 6).join(' · ')}${parts.length > 6 ? ' …' : ''} — по 1 поръчка на час.`;
          return (
            <div className="flex flex-col gap-1.5">
              <label className={lbl}>
                Колко трае една доставка <span className="font-normal text-ff-muted">(по избор)</span>
                <select
                  value={String(s.slotMinutes)}
                  onChange={(e) => set({ slotMinutes: parseInt(e.target.value, 10) || 0 })}
                  className={field}
                >
                  {SLOT_LEN.map((o) => (
                    <option key={o.v} value={o.v}>
                      {o.l}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-[12.5px] leading-relaxed text-ff-muted">{preview}</p>
            </div>
          );
        })()}

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
