'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Clock, Mail, MailX, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  getTenant,
  updateTenant,
  generateDeliveryWindows,
  updateDeliveryWindow,
  approveDeliveryWindows,
  notifyDeliveryWindows,
} from '@/lib/api-client';
import type { DeliveryWindowProposal } from '@/lib/types';

const WEEKDAYS = ['Неделя', 'Понеделник', 'Вторник', 'Сряда', 'Четвъртък', 'Петък', 'Събота'];

/** HH:MM strict check — good enough to gate the PATCH call. */
const isValidTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/**
 * Generates per-order delivery time windows from the optimized route, lets
 * the operator lightly edit them, approve, then email customers (task #13).
 * Also exposes the weekly order-intake cutoff shown on the storefront.
 */
export function DeliveryWindowsModal({
  date,
  couriers,
  ends,
  onClose,
  onChanged,
}: {
  date: string;
  couriers: number;
  ends: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [proposal, setProposal] = useState<DeliveryWindowProposal | null>(null);
  const [edited, setEdited] = useState<Record<string, { start: string; end: string }>>({});
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [notifying, setNotifying] = useState(false);

  // Cutoff state (weekly order-intake cutoff, shown on the storefront).
  const [weekday, setWeekday] = useState(3);
  const [hour, setHour] = useState(17);
  const [cutoffLoading, setCutoffLoading] = useState(true);
  const [cutoffSaving, setCutoffSaving] = useState(false);

  useEffect(() => {
    getTenant()
      .then((t) => {
        const c = t.routing?.cutoff ?? { weekday: 3, hour: 17 };
        setWeekday(c.weekday);
        setHour(c.hour);
      })
      .catch(() => {})
      .finally(() => setCutoffLoading(false));
  }, []);

  const totalStops = useMemo(
    () => (proposal ? proposal.couriers.reduce((n, c) => n + c.stops.length, 0) : 0),
    [proposal],
  );

  async function generate() {
    setGenerating(true);
    try {
      const res = await generateDeliveryWindows({ date, couriers, ends });
      setProposal(res);
      const seed: Record<string, { start: string; end: string }> = {};
      for (const c of res.couriers) {
        for (const s of c.stops) seed[s.id] = { start: s.windowStart, end: s.windowEnd };
      }
      setEdited(seed);
      const n = res.couriers.reduce((sum, c) => sum + c.stops.length, 0);
      toast.success(`Готово — ${n} поръчки`);
    } catch {
      toast.error('Неуспешно генериране на часове');
    } finally {
      setGenerating(false);
    }
  }

  async function approveAll() {
    setApproving(true);
    try {
      const res = await approveDeliveryWindows(date);
      toast.success(`Одобрени ${res.approved} часа`);
    } catch {
      toast.error('Неуспешно одобрение на часовете');
    } finally {
      setApproving(false);
    }
  }

  async function notifyAll() {
    setNotifying(true);
    try {
      const res = await notifyDeliveryWindows(date);
      toast.success(`Изпратени ${res.sent} · пропуснати ${res.skipped}`);
      onChanged();
    } catch {
      toast.error('Неуспешно изпращане на известия');
    } finally {
      setNotifying(false);
    }
  }

  function setField(id: string, field: 'start' | 'end', v: string) {
    setEdited((cur) => ({ ...cur, [id]: { ...(cur[id] ?? { start: '', end: '' }), [field]: v } }));
  }

  async function commit(stopId: string, orig: { windowStart: string; windowEnd: string }) {
    const cur = edited[stopId];
    if (!cur) return;
    if (cur.start === orig.windowStart && cur.end === orig.windowEnd) return; // no-op
    if (!isValidTime(cur.start) || !isValidTime(cur.end)) return; // guard, silent
    try {
      await updateDeliveryWindow(stopId, cur.start, cur.end);
      toast.success('Часът е обновен');
    } catch {
      toast.error('Неуспешна промяна на часа');
    }
  }

  async function saveCutoff() {
    setCutoffSaving(true);
    try {
      await updateTenant({ routing: { cutoff: { weekday, hour } } });
      toast.success('Записано');
    } catch {
      toast.error('Неуспешно записване');
    } finally {
      setCutoffSaving(false);
    }
  }

  function close() {
    onChanged();
    onClose();
  }

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={close}>
      <div
        className="flex max-h-[85vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Часове за доставка"
      >
        <div className="flex items-center justify-between border-b border-ff-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-[16px] font-extrabold text-ff-ink">
            <Clock size={17} /> Часове за доставка <span className="font-bold text-ff-muted">· {date}</span>
          </h2>
          <button onClick={close} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <p className="border-b border-ff-border-2 bg-ff-surface-2 px-5 py-2.5 text-[12.5px] leading-relaxed text-ff-muted">
          Генерирай часове от оптимизирания маршрут, коригирай при нужда, одобри и извести
          клиентите по имейл.
        </p>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" disabled={generating} onClick={() => void generate()}>
              {generating ? 'Генериране…' : 'Генерирай часове'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!proposal || approving}
              onClick={() => void approveAll()}
            >
              {approving ? 'Одобряване…' : 'Одобри всички'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!proposal || notifying}
              onClick={() => void notifyAll()}
            >
              {notifying ? 'Изпращане…' : 'Изпрати по имейл'}
            </Button>
          </div>

          {proposal && proposal.withoutEmail > 0 && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-2.5">
              <AlertTriangle size={15} className="shrink-0 text-ff-amber-600" />
              <span className="text-[12.5px] font-bold text-ff-amber-600">
                {proposal.withoutEmail} поръчки без имейл — няма да получат известие.
              </span>
            </div>
          )}

          {proposal && (
            <div className="mt-4 flex flex-col gap-5">
              {proposal.couriers.map((c) => (
                <div key={c.courierIndex}>
                  <h3 className="mb-2 text-[13px] font-extrabold text-ff-ink">
                    Маршрут {c.courierIndex + 1}
                    {c.name ? ` · ${c.name}` : ''}
                  </h3>
                  <div className="flex flex-col gap-2">
                    {c.stops.map((s) => {
                      const cur = edited[s.id] ?? { start: s.windowStart, end: s.windowEnd };
                      return (
                        <div
                          key={s.id}
                          className="flex flex-wrap items-center gap-2.5 rounded-xl border border-ff-border-2 px-3 py-2"
                        >
                          <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ff-ink">
                            {s.customer ?? 'Клиент'}
                          </span>
                          {s.hasEmail ? (
                            <Mail size={13} className="shrink-0 text-ff-green-700" />
                          ) : (
                            <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-bold text-ff-muted">
                              <MailX size={13} /> без имейл
                            </span>
                          )}
                          <input
                            type="time"
                            value={cur.start}
                            onChange={(e) => setField(s.id, 'start', e.target.value)}
                            onBlur={() => void commit(s.id, s)}
                            aria-label={`Начало за ${s.customer ?? 'клиента'}`}
                            className="rounded-md border border-ff-border bg-ff-surface-2 px-2 py-1 text-[13px] font-bold text-ff-ink outline-none"
                          />
                          <span className="text-ff-muted">–</span>
                          <input
                            type="time"
                            value={cur.end}
                            onChange={(e) => setField(s.id, 'end', e.target.value)}
                            onBlur={() => void commit(s.id, s)}
                            aria-label={`Край за ${s.customer ?? 'клиента'}`}
                            className="rounded-md border border-ff-border bg-ff-surface-2 px-2 py-1 text-[13px] font-bold text-ff-ink outline-none"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {totalStops === 0 && (
                <p className="text-[13px] text-ff-muted">Няма спирки за този ден.</p>
              )}
            </div>
          )}

          {/* cutoff section */}
          <div className="mt-6 border-t border-ff-border-2 pt-4">
            <h3 className="mb-1.5 text-[13px] font-extrabold text-ff-ink">
              Краен час за приемане на поръчки
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={weekday}
                onChange={(e) => setWeekday(parseInt(e.target.value, 10))}
                disabled={cutoffLoading}
                aria-label="Ден от седмицата"
                className="rounded-md border border-ff-border bg-ff-surface-2 px-2.5 py-1.5 text-[13px] font-bold text-ff-ink outline-none"
              >
                {WEEKDAYS.map((label, i) => (
                  <option key={i} value={i}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                value={hour}
                onChange={(e) => setHour(parseInt(e.target.value, 10))}
                disabled={cutoffLoading}
                aria-label="Час"
                className="rounded-md border border-ff-border bg-ff-surface-2 px-2.5 py-1.5 text-[13px] font-bold text-ff-ink outline-none"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="sm"
                disabled={cutoffLoading || cutoffSaving}
                onClick={() => void saveCutoff()}
              >
                {cutoffSaving ? 'Записване…' : 'Запази края'}
              </Button>
            </div>
            <p className="mt-2 text-[12px] text-ff-muted">
              Показва се на сайта — клиентите виждат до кога приемаме поръчки за следващата
              доставка.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ff-border px-5 py-4">
          <Button variant="ghost" size="sm" onClick={close}>
            Затвори
          </Button>
        </div>
      </div>
    </div>
  );
}
