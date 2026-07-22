'use client';

import { useEffect, useState } from 'react';
import { X, Send, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, farmerOrderDays, previewFarmerOrders, sendFarmerOrders } from '@/lib/api-client';
import type { Farmer } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const tomorrowStr = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA');
};
// "22 юли" — short label for an order-days chip.
const shortBgDate = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString('bg-BG', { day: 'numeric', month: 'short' });

type PreviewResult = { recipients: { id: string; name: string; email: string; orderCount: number }[]; skipped: number };
type OrderDay = { day: string; count: number };

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
  const [day, setDay] = useState(tomorrowStr());
  const [farmerIds, setFarmerIds] = useState<Record<string, boolean>>(
    Object.fromEntries(withEmail.map((f) => [f.id, true])),
  );
  const [statuses, setStatuses] = useState<Record<string, boolean>>({ confirmed: true });
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [orderDays, setOrderDays] = useState<OrderDay[] | null>(null);

  const selectedFarmers = withEmail.filter((f) => farmerIds[f.id]).map((f) => f.id);
  const selectedStatuses = STATUS_OPTIONS.filter((s) => statuses[s.key]).map((s) => s.key);
  const canSend = selectedFarmers.length > 0 && selectedStatuses.length > 0 && !busy;

  // Which days (near the current pick) actually have matching orders — an
  // indicator so the organizer doesn't have to remember/guess a date.
  // Re-centers around the currently picked day, not on every keystroke of it.
  const farmerKey = selectedFarmers.join(',');
  const statusKey = selectedStatuses.join(',');
  useEffect(() => {
    if (!farmerKey || !statusKey) {
      setOrderDays([]);
      return;
    }
    let cancelled = false;
    farmerOrderDays({ farmerIds: farmerKey.split(','), statuses: statusKey.split(','), anchor: day })
      .then((res) => {
        if (!cancelled) setOrderDays(res);
      })
      .catch(() => {
        if (!cancelled) setOrderDays([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmerKey, statusKey]);

  // Any change to the selection makes a shown preview stale — hide it rather
  // than let the organizer trust a recipient list for a different query.
  function clearPreview() {
    setPreview(null);
  }

  async function runPreview() {
    if (!canSend || previewing) return;
    setPreviewing(true);
    try {
      const res = await previewFarmerOrders({ from: day, to: day, farmerIds: selectedFarmers, statuses: selectedStatuses });
      setPreview(res);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function submit() {
    if (!canSend) return;
    setBusy(true);
    try {
      const res = await sendFarmerOrders({ from: day, to: day, farmerIds: selectedFarmers, statuses: selectedStatuses });
      toast.success(`Изпратени ${res.sent} · прескочени ${res.skipped} (без поръчки за деня)`);
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const allChecked = withEmail.length > 0 && selectedFarmers.length === withEmail.length;
  const toggleAll = () => {
    setFarmerIds(Object.fromEntries(withEmail.map((f) => [f.id, !allChecked])));
    clearPreview();
  };

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
          <div className="mb-4">
            <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">Ден на доставка</label>
            <input
              type="date"
              value={day}
              onChange={(e) => {
                setDay(e.target.value);
                clearPreview();
              }}
              className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3 text-[14.5px] outline-none focus:border-ff-green-500"
            />
            {orderDays && orderDays.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {orderDays.map((d) => (
                  <button
                    key={d.day}
                    type="button"
                    onClick={() => {
                      setDay(d.day);
                      clearPreview();
                    }}
                    className={`rounded-lg border px-2.5 py-1 text-[12.5px] font-semibold transition-colors ${
                      d.day === day
                        ? 'border-ff-green-600 bg-ff-green-100 text-ff-green-800'
                        : 'border-ff-border-2 text-ff-ink-2 hover:border-ff-green-500'
                    }`}
                  >
                    {shortBgDate(d.day)} · {d.count}
                  </button>
                ))}
              </div>
            )}
            {orderDays && orderDays.length === 0 && (
              <p className="mt-1.5 text-[12.5px] text-ff-muted">Няма поръчки в близките седмици за тези фермери/статуси.</p>
            )}
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
                    onChange={(e) => {
                      setStatuses((c) => ({ ...c, [s.key]: e.target.checked }));
                      clearPreview();
                    }}
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
                    onChange={(e) => {
                      setFarmerIds((c) => ({ ...c, [f.id]: e.target.checked }));
                      clearPreview();
                    }}
                    className="h-4 w-4 accent-ff-green-700"
                  />
                  <span className="flex-1 text-[14px] font-semibold text-ff-ink">{f.name}</span>
                  <span className="text-[12.5px] text-ff-muted">{f.email ?? 'няма имейл'}</span>
                </label>
              );
            })}
          </div>

          {preview && (
            <div className="mt-4 rounded-xl border border-ff-border-2 bg-ff-bg px-3.5 py-3">
              <p className="mb-2 text-[13px] font-bold text-ff-ink-2">
                Ще получат имейл ({preview.recipients.length})
                {preview.skipped > 0 && ` · без поръчки за деня: ${preview.skipped}`}
              </p>
              {preview.recipients.length === 0 ? (
                <p className="text-[13.5px] text-ff-muted">Никой избран фермер няма поръчки за деня.</p>
              ) : (
                <ul className="space-y-1">
                  {preview.recipients.map((r) => (
                    <li key={r.id} className="flex items-center justify-between text-[13.5px]">
                      <span className="font-semibold text-ff-ink">{r.name}</span>
                      <span className="text-ff-muted">
                        {r.email} · {r.orderCount} поръчки
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-ff-border px-5 py-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Отказ
          </Button>
          <Button variant="outline" size="sm" onClick={runPreview} disabled={!canSend || previewing}>
            <Eye size={16} /> Преглед
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!canSend}>
            <Send size={16} /> Изпрати
          </Button>
        </div>
      </div>
    </div>
  );
}
