'use client';

import { useState } from 'react';
import { Repeat, Check } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ApiError, saveSlotRule } from '@/lib/api-client';
import type { SlotRule } from '@/lib/types';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2 text-[14px] font-bold text-ff-ink outline-none focus:border-ff-green-500';
const lbl = 'flex flex-col gap-1 text-[12.5px] font-bold text-ff-ink-2';
const WD = [
  { i: 1, l: 'Пн' },
  { i: 2, l: 'Вт' },
  { i: 3, l: 'Ср' },
  { i: 4, l: 'Чт' },
  { i: 5, l: 'Пт' },
  { i: 6, l: 'Сб' },
  { i: 0, l: 'Нд' },
];

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const EMPTY: SlotRule = {
  active: false,
  repeat: 'weekdays',
  weekdays: [1, 3, 5],
  intervalDays: 3,
  anchorDate: todayIso(),
  timeFrom: '10:00',
  timeTo: '12:00',
  maxOrders: 5,
  horizonDays: 28,
  skipDates: [],
};

export function RecurrenceCard({ initial, onSaved }: { initial: SlotRule | null; onSaved: () => void }) {
  const [r, setR] = useState<SlotRule>(initial ?? EMPTY);
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<SlotRule>) => setR((prev) => ({ ...prev, ...p }));
  const toggleWd = (i: number) =>
    set({ weekdays: r.weekdays.includes(i) ? r.weekdays.filter((x) => x !== i) : [...r.weekdays, i] });

  async function save() {
    setSaving(true);
    try {
      await saveSlotRule(r);
      toast.success(r.active ? 'Правилото е запазено — слотовете се попълват' : 'Правилото е изключено');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-[14px] border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-ff-green-50 text-ff-green-700">
            <Repeat size={18} />
          </span>
          <div>
            <div className="text-[15px] font-extrabold text-ff-ink">Повтарящи се слотове</div>
            <div className="text-[12.5px] text-ff-muted">
              Задай веднъж — слотовете се появяват напред автоматично.
            </div>
          </div>
        </div>
        <ToggleSwitch checked={r.active} onChange={(v) => set({ active: v })} />
      </div>

      <div className={cn('flex flex-col gap-3', !r.active && 'pointer-events-none opacity-50')}>
        <div className="flex gap-2">
          {(['weekdays', 'interval'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => set({ repeat: m })}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-[13px] font-bold',
                r.repeat === m
                  ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-700'
                  : 'border-ff-border text-ff-ink-2',
              )}
            >
              {m === 'weekdays' ? 'По дни от седмицата' : 'През N дни'}
            </button>
          ))}
        </div>

        {r.repeat === 'weekdays' ? (
          <div className="flex flex-wrap gap-1.5">
            {WD.map((d) => (
              <button
                key={d.i}
                type="button"
                onClick={() => toggleWd(d.i)}
                className={cn(
                  'h-9 w-9 rounded-lg border text-[12.5px] font-bold',
                  r.weekdays.includes(d.i)
                    ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-700'
                    : 'border-ff-border text-ff-ink-2',
                )}
              >
                {d.l}
              </button>
            ))}
          </div>
        ) : (
          <label className={lbl}>
            През колко дни
            <input
              value={String(r.intervalDays)}
              onChange={(e) => set({ intervalDays: Math.max(1, parseInt(e.target.value, 10) || 1) })}
              inputMode="numeric"
              className={cn(field, 'w-24')}
            />
          </label>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className={lbl}>
            Начало
            <input type="time" value={r.timeFrom} onChange={(e) => set({ timeFrom: e.target.value })} className={field} />
          </label>
          <label className={lbl}>
            Край
            <input type="time" value={r.timeTo} onChange={(e) => set({ timeTo: e.target.value })} className={field} />
          </label>
          <label className={lbl}>
            Капацитет
            <input
              value={String(r.maxOrders)}
              onChange={(e) => set({ maxOrders: Math.max(1, parseInt(e.target.value, 10) || 1) })}
              inputMode="numeric"
              className={field}
            />
          </label>
          <label className={lbl}>
            Започва от
            <input type="date" value={r.anchorDate} onChange={(e) => set({ anchorDate: e.target.value })} className={field} />
          </label>
        </div>

        <label className={lbl}>
          Бележка за клиента <span className="font-normal text-ff-muted">(в магазина)</span>
          <input
            value={r.customerNote ?? ''}
            onChange={(e) => set({ customerNote: e.target.value })}
            maxLength={280}
            placeholder="напр. Ще се обадя преди доставка"
            className={field}
          />
        </label>
        <label className={lbl}>
          Бележка за доставчика <span className="font-normal text-ff-muted">(само за теб)</span>
          <input
            value={r.driverNote ?? ''}
            onChange={(e) => set({ driverNote: e.target.value })}
            maxLength={500}
            placeholder="напр. маршрут + телефон"
            className={field}
          />
        </label>
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant="primary" size="sm" onClick={save} disabled={saving} className="rounded-sm">
          <Check size={16} /> {saving ? 'Записване…' : 'Запази правилото'}
        </Button>
      </div>
    </div>
  );
}
