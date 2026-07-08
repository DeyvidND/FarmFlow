'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Wand2, MapPin, Sprout } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { relDayLabel, moneyFromStotinki } from '@/lib/utils';
import { ApiError, suggestDays, rescheduleOrders, listReschedulable } from '@/lib/api-client';
import type { DaySuggestionResult, SuggestedDayOrder } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const todayStr = () => new Date().toLocaleDateString('en-CA');
const orderNo = (o: { orderNumber: number | null; id: string }) =>
  o.orderNumber != null ? `#${o.orderNumber}` : `#${o.id.slice(0, 8)}`;

/** Per-order target-day override the farmer can change before applying. */
type Choice = { day: string | null }; // null = excluded from the move

export function RouteDaySuggesterModal({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  /** Called after a successful apply so the route page can reload. */
  onApplied: () => void;
}) {
  const [days, setDays] = useState<string[]>([]);
  const [newDay, setNewDay] = useState('');
  const [result, setResult] = useState<DaySuggestionResult | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const addDay = () => {
    if (newDay && !days.includes(newDay)) setDays([...days, newDay].sort());
    setNewDay('');
  };
  const removeDay = (d: string) => {
    setDays(days.filter((x) => x !== d));
    // Any orders currently assigned to the removed day become excluded — so
    // apply() never reschedules onto a day the farmer just took off the list
    // (and their per-order picker doesn't show a now-missing option).
    setChoices((c) => {
      const next: Record<string, Choice> = {};
      for (const [id, choice] of Object.entries(c)) {
        next[id] = choice.day === d ? { day: null } : choice;
      }
      return next;
    });
  };

  // Pre-seed the picker with the farm's upcoming delivery days (distinct
  // slotDate values from the reschedulable pool) — the farmer can still add
  // or remove any date afterward.
  useEffect(() => {
    listReschedulable()
      .then((rows) => {
        const distinct = [...new Set(rows.map((r) => r.slotDate))].sort();
        setDays(distinct);
      })
      .catch(() => {
        // Non-fatal — the farmer can still add days by hand.
      });
  }, []);

  async function propose() {
    if (!days.length) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await suggestDays(days);
      setResult(res);
      // Seed each order's choice with the day the engine proposed.
      const seeded: Record<string, Choice> = {};
      for (const day of res.days) for (const o of day.orders) seeded[o.id] = { day: day.date };
      setChoices(seeded);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }

  // Group by the farmer's (possibly edited) choice, ready to apply.
  const groupedForApply = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [orderId, c] of Object.entries(choices)) {
      if (!c.day) continue; // excluded
      const list = map.get(c.day) ?? [];
      list.push(orderId);
      map.set(c.day, list);
    }
    return map;
  }, [choices]);

  const movesCount = useMemo(
    () => [...groupedForApply.values()].reduce((n, ids) => n + ids.length, 0),
    [groupedForApply],
  );

  async function apply() {
    if (!movesCount) return;
    setBusy(true);
    try {
      let moved = 0;
      for (const [date, ids] of groupedForApply) {
        if (!ids.length) continue;
        const res = await rescheduleOrders(ids, date);
        moved += res.moved;
      }
      toast.success(`Разпределени ${moved} поръчки по ${groupedForApply.size} дни`);
      onApplied();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const orderRow = (o: SuggestedDayOrder) => (
    <div key={o.id} className="flex items-center gap-2 border-b border-ff-border-2 px-3 py-2 last:border-0">
      <span className="flex-1 truncate text-[13.5px] font-semibold text-ff-ink">
        {orderNo(o)} · {o.customerName ?? '—'}
        {o.lat == null && <MapPin size={13} className="ml-1 inline text-ff-amber-600" />}
      </span>
      <span className="ff-fig text-[13px] font-bold text-ff-ink-2">
        {moneyFromStotinki(o.totalStotinki)}
      </span>
      <select
        value={choices[o.id]?.day ?? ''}
        onChange={(e) =>
          setChoices((c) => ({ ...c, [o.id]: { day: e.target.value || null } }))
        }
        className="rounded-md border border-ff-border bg-ff-surface-2 px-1.5 py-1 text-[12.5px] font-bold outline-none"
      >
        {days.map((d) => (
          <option key={d} value={d}>
            {relDayLabel(d)}
          </option>
        ))}
        <option value="">Изключи</option>
      </select>
    </div>
  );

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ff-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-[16px] font-extrabold text-ff-ink">
            <Wand2 size={18} /> Предложи разпределение по дни
          </h2>
          <button onClick={onClose} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Day picker */}
          <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">За кои дни</label>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {days.map((d) => (
              <span key={d} className="inline-flex items-center gap-1.5 rounded-lg bg-ff-green-100 px-2.5 py-1 text-[13px] font-bold text-ff-green-800">
                {relDayLabel(d)}
                <button onClick={() => removeDay(d)} aria-label={`Махни ${d}`}>
                  <X size={13} />
                </button>
              </span>
            ))}
            <input
              type="date"
              min={todayStr()}
              value={newDay}
              onChange={(e) => setNewDay(e.target.value)}
              className="h-9 rounded-lg border border-ff-border bg-ff-surface px-2 text-[13px] outline-none focus:border-ff-green-500"
            />
            <Button variant="ghost" size="sm" onClick={addDay} disabled={!newDay}>
              Добави ден
            </Button>
          </div>
          <Button variant="primary" size="sm" onClick={propose} disabled={!days.length || loading}>
            {loading ? 'Смятам…' : 'Предложи'}
          </Button>

          {/* Proposal */}
          {result && (
            <div className="mt-4 space-y-3">
              {result.days.map((day) => (
                <div key={day.date} className="rounded-xl border border-ff-border-2">
                  <div className="flex items-center justify-between border-b border-ff-border-2 bg-ff-surface-2 px-3 py-2">
                    <span className="text-[14px] font-extrabold capitalize text-ff-ink">
                      {relDayLabel(day.date)} · {day.orders.length} поръчки
                    </span>
                    <span className="text-[12px] font-semibold text-ff-muted">~{day.spreadKm} км</span>
                  </div>
                  {day.harvest.length > 0 && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-ff-border-2 px-3 py-2 text-[12.5px] text-ff-ink-2">
                      <span className="inline-flex items-center gap-1 font-bold text-ff-green-700">
                        <Sprout size={13} /> За бране:
                      </span>
                      {day.harvest.map((h) => (
                        <span key={h.productName}>
                          {h.productName} <strong>× {h.quantity}</strong>
                        </span>
                      ))}
                    </div>
                  )}
                  {day.orders.map(orderRow)}
                </div>
              ))}

              {result.unplaced.length > 0 && (
                <div className="rounded-xl border border-ff-amber-300 bg-ff-amber-50">
                  <div className="border-b border-ff-amber-200 px-3 py-2 text-[13.5px] font-bold text-ff-amber-700">
                    За ръчно нареждане (без карта) · {result.unplaced.length}
                  </div>
                  {result.unplaced.map((o) => (
                    <div key={o.id} className="flex items-center gap-2 border-b border-ff-amber-100 px-3 py-2 text-[13px] font-semibold text-ff-ink last:border-0">
                      <span className="flex-1 truncate">
                        {orderNo(o)} · {o.customerName ?? '—'}
                      </span>
                      <span className="ff-fig text-ff-ink-2">{moneyFromStotinki(o.totalStotinki)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-ff-border px-5 py-4">
          <p className="text-[12px] text-ff-muted">
            Клиентите с имейл получават известие, че денят е сменен.
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Отказ
            </Button>
            <Button variant="primary" size="sm" onClick={apply} disabled={!result || !movesCount || busy}>
              Приложи {movesCount || ''}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
