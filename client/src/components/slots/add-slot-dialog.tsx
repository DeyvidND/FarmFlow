'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { bgWeekdayShort, ddmm, hhmm } from '@/lib/utils';
import type { Slot } from '@/lib/types';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-bold text-ff-ink outline-none focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export type SlotInput = {
  date: string;
  timeFrom: string;
  timeTo: string;
  capacity: number;
  customerNote?: string;
  driverNote?: string;
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
  const [from, setFrom] = useState(slot ? hhmm(slot.timeFrom) : '09:00');
  const [to, setTo] = useState(slot ? hhmm(slot.timeTo) : '10:00');
  const [capacity, setCapacity] = useState(slot?.capacity ?? 1);
  const [cNote, setCNote] = useState(slot?.customerNote ?? '');
  const [dNote, setDNote] = useState(slot?.driverNote ?? '');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const theDate = slot?.date ?? date;
  if (!theDate) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) return setErr('Часът трябва да е ЧЧ:ММ');
    if (to <= from) return setErr('Краят трябва да е след началото');
    setLoading(true);
    try {
      await onSubmit(
        {
          date: theDate as string,
          timeFrom: from,
          timeTo: to,
          capacity,
          customerNote: cNote.trim() || undefined,
          driverNote: dNote.trim() || undefined,
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
          <h2 className="text-[18px] font-extrabold">{editing ? 'Редактирай час' : 'Нов час'}</h2>
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
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Начало
              <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
            </label>
            <label className={labelCls}>
              Край
              <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className={field} />
            </label>
          </div>
          <label className={labelCls}>
            Поръчки на слот <span className="font-normal text-ff-muted">(колко доставки поемаш едновременно · напр. 2 човека = 2)</span>
            <input
              type="number"
              min={1}
              max={20}
              value={capacity}
              onChange={(e) => setCapacity(Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)))}
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
