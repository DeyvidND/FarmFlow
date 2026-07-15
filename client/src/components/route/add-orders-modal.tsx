'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, PlusCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { relDayLabel, moneyFromStotinki } from '@/lib/utils';
import { ApiError, listReschedulable, rescheduleOrders, setOrderCourier } from '@/lib/api-client';
import type { ReschedulableOrder } from '@/lib/types';
import { groupBySourceDay } from './add-orders';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const orderNo = (o: ReschedulableOrder) =>
  o.orderNumber != null ? `#${o.orderNumber}` : `#${o.id.slice(0, 8)}`;

export function AddOrdersModal({
  routeDate,
  courierCount,
  courierLegs,
  onClose,
  onAdded,
}: {
  routeDate: string;
  courierCount: number;
  /** The day's REAL leg numbers (route.courierIndex per leg), in tab order —
   *  non-contiguous on a board day with a gap (e.g. [0, 2]). The courier
   *  select's option values must be these legs, not 0..count-1, or the pin
   *  would target an unassigned leg (silently treated as auto). Falls back to
   *  0..courierCount-1 when absent. */
  courierLegs?: number[];
  onClose: () => void;
  /** Called after a successful move so the parent can reload its list. */
  onAdded: () => void;
}) {
  const [rows, setRows] = useState<ReschedulableOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [courierIndex, setCourierIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchReschedulable = () => {
    setRows(null);
    setError(null);
    listReschedulable()
      .then((r) => {
        setRows(r);
      })
      .catch((e) => {
        const msg = errMsg(e);
        toast.error(msg);
        setError(msg);
        setRows([]);
      });
  };

  useEffect(() => {
    fetchReschedulable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(() => groupBySourceDay(rows ?? [], routeDate), [rows, routeDate]);

  const selectedIds = useMemo(
    () => groups.flatMap((g) => g.orders).filter((o) => checked[o.id]).map((o) => o.id),
    [groups, checked],
  );
  const canSubmit = selectedIds.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    let res: { moved: number };
    try {
      res = await rescheduleOrders(selectedIds, routeDate);
    } catch (e) {
      toast.error(errMsg(e));
      setBusy(false);
      return;
    }

    // Orders are on the route now — any failure past this point is partial,
    // not total, so it must not look like nothing happened.
    let courierFailures = 0;
    if (courierIndex !== null) {
      const results = await Promise.allSettled(
        selectedIds.map((id) => setOrderCourier(id, courierIndex)),
      );
      courierFailures = results.filter((r) => r.status === 'rejected').length;
    }

    if (courierFailures > 0) {
      toast.error(
        `Добавени ${res.moved} поръчки към ${relDayLabel(routeDate)} — куриерът не се зададе за всички, провери реда`,
      );
    } else {
      toast.success(`Добавени ${res.moved} поръчки към ${relDayLabel(routeDate)}`);
    }
    onAdded();
    onClose();
    setBusy(false);
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
            <PlusCircle size={18} /> Добави поръчки към маршрута
          </h2>
          <button onClick={onClose} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {rows === null ? (
            <p className="py-8 text-center text-sm text-ff-muted">Зареждане…</p>
          ) : error ? (
            <div className="py-8 text-center">
              <p className="mb-4 text-sm text-ff-muted">{error}</p>
              <Button variant="primary" size="sm" onClick={fetchReschedulable}>
                Опитай пак
              </Button>
            </div>
          ) : groups.length === 0 ? (
            <p className="py-8 text-center text-sm text-ff-muted">
              Няма поръчки от други дни, които да добавиш към този маршрут.
            </p>
          ) : (
            <>
              {groups.map((g) => (
                <div key={g.date} className="mb-4">
                  <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">
                    {relDayLabel(g.date)} · {g.orders.length} поръчки
                  </label>
                  <div className="rounded-xl border border-ff-border-2">
                    {g.orders.map((o) => (
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
                          {o.status === 'pending' && (
                            <span className="ml-2 rounded-full bg-ff-amber-soft px-2 py-0.5 text-[11px] font-bold text-ff-amber-600">
                              чака потвърждение
                            </span>
                          )}
                        </span>
                        <span className="ff-fig text-[14px] font-bold text-ff-ink-2">
                          {moneyFromStotinki(o.totalStotinki)}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              {courierCount > 1 && (
                <>
                  <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">Куриер</label>
                  <select
                    value={courierIndex === null ? '' : String(courierIndex)}
                    onChange={(e) => setCourierIndex(e.target.value === '' ? null : Number(e.target.value))}
                    className="mb-4 h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3 text-[14.5px] outline-none focus:border-ff-green-500"
                  >
                    <option value="">Автоматично</option>
                    {(courierLegs ?? Array.from({ length: courierCount }, (_, i) => i)).map(
                      (leg) => (
                        <option key={leg} value={leg}>
                          Куриер {leg + 1}
                        </option>
                      ),
                    )}
                  </select>
                </>
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
            Добави {selectedIds.length || ''} поръчки
          </Button>
        </div>
      </div>
    </div>
  );
}
