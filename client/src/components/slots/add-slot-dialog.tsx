'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { bgWeekdayShort, ddmm } from '@/lib/utils';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-bold text-ff-ink outline-none focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export function AddSlotDialog({
  date,
  onClose,
  onAdd,
}: {
  date: string | null;
  onClose: () => void;
  onAdd: (d: { date: string; timeFrom: string; timeTo: string; maxOrders: number }) => Promise<void>;
}) {
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('10:00');
  const [cap, setCap] = useState('5');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  if (!date) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) {
      setErr('Часът трябва да е ЧЧ:ММ');
      return;
    }
    if (to <= from) {
      setErr('Краят трябва да е след началото');
      return;
    }
    const m = parseInt(cap, 10);
    if (!m || m < 1) {
      setErr('Невалиден капацитет');
      return;
    }
    setLoading(true);
    try {
      await onAdd({ date: date as string, timeFrom: from, timeTo: to, maxOrders: m });
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
        className="animate-ff-pop w-[380px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-[18px] font-extrabold">Нов слот</h2>
          <button onClick={onClose} aria-label="Затвори" className="grid h-8 w-8 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2">
            <X size={18} />
          </button>
        </div>
        <p className="mb-4 text-[13px] text-ff-muted">
          {bgWeekdayShort(date)} · {ddmm(date)}
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
            Капацитет (поръчки)
            <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="numeric" className={field} />
          </label>

          {err && <p className="text-[13px] font-semibold text-ff-red">{err}</p>}

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={onClose} className="rounded-sm">
              Отказ
            </Button>
            <Button variant="primary" type="submit" disabled={loading} className="rounded-sm">
              {loading ? 'Запазване…' : 'Добави'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
