'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { bgWeekdayShort, ddmm } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import type { Slot } from '@/lib/types';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-bold text-ff-ink outline-none focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export type SlotInput = {
  date: string;
  capacity: number;
  customerNote?: string;
  driverNote?: string;
  reminderOptOut?: boolean;
};

export function AddSlotDialog({
  date,
  slot,
  onClose,
  onSubmit,
}: {
  date: string | null;
  slot?: Slot | null;
  onClose: () => void;
  onSubmit: (d: SlotInput, editingId: string | null) => Promise<void>;
}) {
  const editing = !!slot;
  const [capacity, setCapacity] = useState(slot?.capacity ?? 1);
  const [cNote, setCNote] = useState(slot?.customerNote ?? '');
  const [dNote, setDNote] = useState(slot?.driverNote ?? '');
  const [sendReminder, setSendReminder] = useState(slot ? !slot.reminderOptOut : true);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const theDate = slot?.date ?? date;
  if (!theDate) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      await onSubmit(
        {
          date: theDate as string,
          capacity,
          customerNote: cNote.trim() || undefined,
          driverNote: dNote.trim() || undefined,
          reminderOptOut: !sendReminder,
        },
        slot?.id ?? null,
      );
      onClose();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Грешка');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="animate-ff-pop w-[400px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-[18px] font-extrabold">{editing ? 'Редактирай деня' : 'Отвори ден'}</h2>
          <button
            onClick={onClose}
            aria-label="Затвори"
            className="grid h-8 w-8 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2"
          >
            <X size={18} />
          </button>
        </div>
        <p className="mb-4 text-[13px] text-ff-muted">
          {bgWeekdayShort(theDate)} · {ddmm(theDate)}
        </p>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className={labelCls}>
            Поръчки за деня <span className="font-normal text-ff-muted">(колко доставки поемаш този ден)</span>
            <input
              type="number"
              min={1}
              max={500}
              value={capacity}
              onChange={(e) => setCapacity(Math.min(500, Math.max(1, parseInt(e.target.value, 10) || 1)))}
              className={field}
            />
          </label>
          <label className={labelCls}>
            Бележка за клиента <span className="font-normal text-ff-muted">(по избор · вижда се в магазина)</span>
            <input
              value={cNote}
              onChange={(e) => setCNote(e.target.value)}
              maxLength={280}
              placeholder="напр. Ще се обадя преди доставка"
              className={field}
            />
          </label>
          <label className={labelCls}>
            Бележка за доставчика <span className="font-normal text-ff-muted">(по избор · само за теб)</span>
            <input
              value={dNote}
              onChange={(e) => setDNote(e.target.value)}
              maxLength={500}
              placeholder="напр. Маршрут Чайка→Левски, тел. 0888…"
              className={field}
            />
          </label>

          <label className="flex items-center justify-between gap-3 rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-2.5">
            <span className="flex flex-col">
              <span className="text-[13.5px] font-bold text-ff-ink">Напомняне в деня на доставка</span>
              <span className="text-[12px] text-ff-muted">
                Имейл на клиента сутринта с очаквания час, ако имаш одобрени часове за деня.
              </span>
            </span>
            <ToggleSwitch checked={sendReminder} onChange={setSendReminder} />
          </label>

          {err && <p className="text-[13px] font-semibold text-ff-red">{err}</p>}

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={onClose} className="rounded-sm">
              Отказ
            </Button>
            <Button variant="primary" type="submit" disabled={loading} className="rounded-sm">
              {loading ? 'Запазване…' : editing ? 'Запази' : 'Добави'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
