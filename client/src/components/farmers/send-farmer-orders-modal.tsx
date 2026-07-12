'use client';

import { useState } from 'react';
import { X, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, sendFarmerOrders } from '@/lib/api-client';
import type { Farmer } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const todayStr = () => new Date().toLocaleDateString('en-CA');

const STATUS_OPTIONS: { key: string; label: string }[] = [
  { key: 'pending', label: 'Чакащи' },
  { key: 'confirmed', label: 'Потвърдени' },
  { key: 'delivered', label: 'Доставени' },
];

export function SendFarmerOrdersModal({
  farmers,
  onClose,
}: {
  farmers: Farmer[];
  onClose: () => void;
}) {
  const withEmail = farmers.filter((f) => f.email);
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [farmerIds, setFarmerIds] = useState<Record<string, boolean>>(
    Object.fromEntries(withEmail.map((f) => [f.id, true])),
  );
  const [statuses, setStatuses] = useState<Record<string, boolean>>({ confirmed: true });
  const [busy, setBusy] = useState(false);

  const selectedFarmers = withEmail.filter((f) => farmerIds[f.id]).map((f) => f.id);
  const selectedStatuses = STATUS_OPTIONS.filter((s) => statuses[s.key]).map((s) => s.key);
  const canSend =
    selectedFarmers.length > 0 && selectedStatuses.length > 0 && from <= to && !busy;

  async function submit() {
    if (!canSend) return;
    setBusy(true);
    try {
      const res = await sendFarmerOrders({ from, to, farmerIds: selectedFarmers, statuses: selectedStatuses });
      toast.success(`Изпратени ${res.sent} · прескочени ${res.skipped} (без поръчки за периода)`);
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const allChecked = withEmail.length > 0 && selectedFarmers.length === withEmail.length;
  const toggleAll = () =>
    setFarmerIds(Object.fromEntries(withEmail.map((f) => [f.id, !allChecked])));

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ff-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-[16px] font-extrabold text-ff-ink">
            <Send size={18} /> Изпрати поръчки на фермери
          </h2>
          <button onClick={onClose} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          <div className="mb-4 flex gap-3">
            <div className="flex-1">
              <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">От</label>
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
                className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3 text-[14.5px] outline-none focus:border-ff-green-500"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">До</label>
              <input
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
                className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3 text-[14.5px] outline-none focus:border-ff-green-500"
              />
            </div>
          </div>

          <div className="mb-4">
            <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">Статуси</label>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((s) => (
                <label
                  key={s.key}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-ff-border px-3 py-2 text-[14px]"
                >
                  <input
                    type="checkbox"
                    checked={!!statuses[s.key]}
                    onChange={(e) => setStatuses((c) => ({ ...c, [s.key]: e.target.checked }))}
                    className="h-4 w-4 accent-ff-green-700"
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </div>

          <div className="mb-1 flex items-center justify-between">
            <label className="text-[13px] font-bold text-ff-ink-2">Фермери</label>
            {withEmail.length > 0 && (
              <button type="button" onClick={toggleAll} className="text-[12.5px] font-semibold text-ff-green-700">
                {allChecked ? 'Никой' : 'Всички'}
              </button>
            )}
          </div>
          <div className="rounded-xl border border-ff-border-2">
            {farmers.map((f) => {
              const disabled = !f.email;
              return (
                <label
                  key={f.id}
                  className={`flex items-center gap-3 border-b border-ff-border-2 px-3.5 py-2.5 last:border-0 ${
                    disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={!disabled && !!farmerIds[f.id]}
                    onChange={(e) => setFarmerIds((c) => ({ ...c, [f.id]: e.target.checked }))}
                    className="h-4 w-4 accent-ff-green-700"
                  />
                  <span className="flex-1 text-[14px] font-semibold text-ff-ink">{f.name}</span>
                  <span className="text-[12.5px] text-ff-muted">{f.email ?? 'няма имейл'}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-ff-border px-5 py-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Отказ
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!canSend}>
            <Send size={16} /> Изпрати
          </Button>
        </div>
      </div>
    </div>
  );
}
