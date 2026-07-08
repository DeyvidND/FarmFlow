'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, ArrowRightLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { relDayLabel, moneyFromStotinki } from '@/lib/utils';
import { ApiError, listReschedulable, rescheduleOrders } from '@/lib/api-client';
import type { ReschedulableOrder } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
/** Local calendar day as YYYY-MM-DD — the date input's floor. */
const todayStr = () => new Date().toLocaleDateString('en-CA');
const orderNo = (o: ReschedulableOrder) =>
  o.orderNumber != null ? `#${o.orderNumber}` : `#${o.id.slice(0, 8)}`;

export function RescheduleOrdersModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  /** Called after a successful move so the parent can reload its list. */
  onDone: () => void;
}) {
  const [rows, setRows] = useState<ReschedulableOrder[] | null>(null);
  const [sourceDate, setSourceDate] = useState<string>('');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [toDate, setToDate] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    listReschedulable()
      .then((r) => {
        if (!live) return;
        setRows(r);
      })
      .catch((e) => {
        if (live) toast.error(errMsg(e));
      });
    return () => {
      live = false;
    };
  }, []);

  // Distinct source days with their orders, sorted ascending.
  const days = useMemo(() => {
    const map = new Map<string, ReschedulableOrder[]>();
    for (const o of rows ?? []) {
      const arr = map.get(o.slotDate) ?? [];
      arr.push(o);
      map.set(o.slotDate, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, orders]) => ({ date, orders }));
  }, [rows]);

  // Default the source day to the first available; pre-check all its orders.
  useEffect(() => {
    if (!days.length) return;
    const first = days[0];
    setSourceDate((cur) => (cur && days.some((d) => d.date === cur) ? cur : first.date));
  }, [days]);

  const sourceOrders = useMemo(
    () => days.find((d) => d.date === sourceDate)?.orders ?? [],
    [days, sourceDate],
  );

  // When the source day changes, pre-check every order on it.
  useEffect(() => {
    setChecked(Object.fromEntries(sourceOrders.map((o) => [o.id, true])));
  }, [sourceOrders]);

  const selectedIds = sourceOrders.filter((o) => checked[o.id]).map((o) => o.id);
  const canSubmit = selectedIds.length > 0 && !!toDate && toDate !== sourceDate && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await rescheduleOrders(selectedIds, toDate);
      toast.success(`Преместени ${res.moved} поръчки за ${relDayLabel(toDate)}`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ff-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-[16px] font-extrabold text-ff-ink">
            <ArrowRightLeft size={18} /> Премести поръчки на друг ден
          </h2>
          <button onClick={onClose} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {rows === null ? (
            <p className="py-8 text-center text-sm text-ff-muted">Зареждане…</p>
          ) : days.length === 0 ? (
            <p className="py-8 text-center text-sm text-ff-muted">
              Няма поръчки с лична доставка за преместване.
            </p>
          ) : (
            <>
              <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">От кой ден</label>
              <select
                value={sourceDate}
                onChange={(e) => setSourceDate(e.target.value)}
                className="mb-4 h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3 text-[14.5px] outline-none focus:border-ff-green-500"
              >
                {days.map((d) => (
                  <option key={d.date} value={d.date}>
                    {relDayLabel(d.date)} · {d.orders.length} поръчки
                  </option>
                ))}
              </select>

              <div className="mb-4 rounded-xl border border-ff-border-2">
                {sourceOrders.map((o) => (
                  <label
                    key={o.id}
                    className="flex cursor-pointer items-center gap-3 border-b border-ff-border-2 px-3.5 py-2.5 last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked={!!checked[o.id]}
                      onChange={(e) => setChecked((c) => ({ ...c, [o.id]: e.target.checked }))}
                      className="h-4 w-4 accent-ff-green-700"
                    />
                    <span className="flex-1 text-[14px] font-semibold text-ff-ink">
                      {orderNo(o)} · {o.customerName ?? '—'}
                    </span>
                    <span className="ff-fig text-[14px] font-bold text-ff-ink-2">
                      {moneyFromStotinki(o.totalStotinki)}
                    </span>
                  </label>
                ))}
              </div>

              <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">За кой ден</label>
              <input
                type="date"
                min={todayStr()}
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3 text-[14.5px] outline-none focus:border-ff-green-500"
              />
              {toDate && toDate === sourceDate && (
                <p className="mt-1.5 text-[12.5px] font-semibold text-ff-amber-600">
                  Избери различен ден от текущия.
                </p>
              )}

              <p className="mt-4 rounded-xl bg-ff-surface-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-ff-ink-2">
                Клиентите с имейл ще получат известие, че поръчката е преместена, и покана да се обадят,
                ако денят не им е удобен.
              </p>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-ff-border px-5 py-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Отказ
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!canSubmit}>
            Премести {selectedIds.length || ''} поръчки
          </Button>
        </div>
      </div>
    </div>
  );
}
