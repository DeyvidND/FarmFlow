'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Clock, Mail, MailX, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { cn, moneyFromStotinki } from '@/lib/utils';
import {
  getTenant,
  updateTenant,
  generateDeliveryWindows,
  updateDeliveryWindow,
  approveDeliveryWindows,
  notifyDeliveryWindows,
  listSlots,
  updateSlot,
} from '@/lib/api-client';
import type { DeliveryWindowProposal, Slot } from '@/lib/types';
import { TimeInput24 } from './time-input-24';

const WEEKDAYS = ['Неделя', 'Понеделник', 'Вторник', 'Сряда', 'Четвъртък', 'Петък', 'Събота'];

/** HH:MM strict check — good enough to gate the PATCH call. */
const isValidTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** Distance + rough drive time from the previous stop, for a proposal row. */
const fmtGap = (m: number, s: number): string => {
  const dist = m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} км` : `${Math.round(m)} м`;
  const min = Math.round(s / 60);
  return min > 0 ? `${dist} · ~${min} мин` : dist;
};

/** Whole-route distance (km) for the per-courier summary line. */
const fmtKmTotal = (m: number): string => `${(m / 1000).toFixed(1).replace('.', ',')} км`;

/** Whole-route drive time (hours/minutes) for the summary line. */
const fmtDurTotal = (s: number): string => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}ч ${m % 60}м` : `${m}м`;
};

/**
 * Generates per-order delivery time windows from the optimized route, lets
 * the operator lightly edit them, approve, then email customers (task #13).
 * Also exposes the weekly order-intake cutoff shown on the storefront.
 */
export function DeliveryWindowsModal({
  date,
  couriers,
  ends,
  start,
  onClose,
  onChanged,
}: {
  date: string;
  couriers: number;
  ends: string;
  /** Courier's current position (route screen's live GPS / last delivered stop);
   *  when present, the first stop's distance/time is measured from here. */
  start?: { lat: number | null; lng: number | null } | null;
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

  // When the round starts (Europe/Sofia hour) — seeds the window generation.
  // Asked here every time rather than buried in settings; seeded from the saved
  // dayStartHour (default 9) and remembered on generate.
  const [startHour, setStartHour] = useState(9);

  // Tenant-level auto-reminder config (settings.sms): master on/off for sending
  // the time-window email to customers, and the Europe/Sofia hour it goes out.
  // Both persist on change (optimistic, like the settings card / cutoff).
  const [reminderOn, setReminderOn] = useState(false);
  const [sendHour, setSendHour] = useState(8);
  const [savingReminderCfg, setSavingReminderCfg] = useState(false);

  // The day's slot row (for the reminder opt-out toggle) — separate from the
  // per-order windows above.
  const [slot, setSlot] = useState<Slot | null>(null);
  const [savingReminder, setSavingReminder] = useState(false);

  useEffect(() => {
    getTenant()
      .then((t) => {
        const c = t.routing?.cutoff ?? { weekday: 3, hour: 17 };
        setWeekday(c.weekday);
        setHour(c.hour);
        const dsh = t.routing?.dayStartHour;
        if (typeof dsh === 'number' && dsh >= 0 && dsh <= 23) setStartHour(dsh);
        setReminderOn(!!t.sms?.dayOfReminder);
        const sh = t.sms?.sendHour;
        if (typeof sh === 'number' && sh >= 0 && sh <= 23) setSendHour(sh);
      })
      .catch(() => {})
      .finally(() => setCutoffLoading(false));
  }, []);

  useEffect(() => {
    listSlots(date, date)
      .then((rows) => setSlot(rows[0] ?? null))
      .catch(() => {});
  }, [date]);

  const totalStops = useMemo(
    () => (proposal ? proposal.couriers.reduce((n, c) => n + c.stops.length, 0) : 0),
    [proposal],
  );

  // Per-farmer order counts across the whole day (a multi-farmer order counts for
  // each of its producers) — drives the „Фермери днес" summary chips. Sorted by
  // count, descending.
  const farmerSummary = useMemo<[string, number][]>(() => {
    if (!proposal) return [];
    const counts = new Map<string, number>();
    for (const c of proposal.couriers)
      for (const s of c.stops) for (const f of s.farmers ?? []) counts.set(f, (counts.get(f) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [proposal]);

  async function generate() {
    setGenerating(true);
    try {
      const res = await generateDeliveryWindows({
        date,
        couriers,
        ends,
        startHour,
        ...(start && start.lat != null && start.lng != null
          ? { startLat: start.lat, startLng: start.lng }
          : {}),
      });
      // Remember the chosen start hour as the default for next time (fire-and-
      // forget — the windows are already generated; a failed persist just means
      // the picker re-seeds from the old value next open).
      void updateTenant({ routing: { dayStartHour: startHour } }).catch(() => {});
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
      // A partial failure isn't a full error (some customers WERE notified),
      // but it must read differently from a clean run — the operator needs to
      // know some orders are still 'approved' (not sent) and worth retrying.
      if (res.failed > 0) {
        toast.error(`Изпратени ${res.sent} · пропуснати ${res.skipped} · неуспешни ${res.failed} — опитай пак за неуспешните`);
      } else {
        toast.success(`Изпратени ${res.sent} · пропуснати ${res.skipped}`);
      }
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

  /** Persist one stop's edited window. Takes the values EXPLICITLY — the
   *  TimeInput24 commit callback runs in the same tick as its setField, so
   *  reading `edited` state here would still see the pre-edit value. */
  async function commit(
    stopId: string,
    orig: { windowStart: string; windowEnd: string },
    cur: { start: string; end: string },
  ) {
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

  // Master on/off for the auto-reminder (settings.sms.dayOfReminder). Optimistic
  // + persist, mirroring the settings card; reverts on error.
  async function toggleReminderMaster(next: boolean) {
    const prev = reminderOn;
    setReminderOn(next);
    setSavingReminderCfg(true);
    try {
      await updateTenant({ sms: { dayOfReminder: next } });
      toast.success(next ? 'Автоматичното напомняне е включено' : 'Автоматичното напомняне е изключено');
    } catch {
      setReminderOn(prev);
      toast.error('Неуспешна промяна');
    } finally {
      setSavingReminderCfg(false);
    }
  }

  // The Europe/Sofia hour the reminder goes out (settings.sms.sendHour).
  async function saveSendHour(h: number) {
    const prev = sendHour;
    setSendHour(h);
    setSavingReminderCfg(true);
    try {
      await updateTenant({ sms: { sendHour: h } });
      toast.success('Часът на изпращане е запазен');
    } catch {
      setSendHour(prev);
      toast.error('Неуспешна промяна');
    } finally {
      setSavingReminderCfg(false);
    }
  }

  async function toggleReminder(send: boolean) {
    if (!slot) return;
    setSavingReminder(true);
    try {
      const updated = await updateSlot(slot.id, { reminderOptOut: !send });
      setSlot(updated);
      toast.success(send ? 'Напомнянето е включено' : 'Напомнянето е изключено за този ден');
    } catch {
      toast.error('Неуспешна промяна');
    } finally {
      setSavingReminder(false);
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
          {/* Tenant-level auto-reminder: master on/off (whether customers get a
              time-window email at all) + the hour it's sent. Both persist on
              change. The per-day override below only applies when this is on. */}
          <div className="mb-3 rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-2.5">
            <label className="flex items-center justify-between gap-3">
              <span className="flex flex-col">
                <span className="text-[13.5px] font-bold text-ff-ink">
                  Изпращай часовия диапазон на клиентите
                </span>
                <span className="text-[12px] text-ff-muted">
                  Клиентът получава имейл в деня на доставка с очаквания час. Изисква одобрени часове.
                </span>
              </span>
              <ToggleSwitch
                checked={reminderOn}
                onChange={(v) => void toggleReminderMaster(v)}
                disabled={cutoffLoading || savingReminderCfg}
              />
            </label>
            <div
              className={cn(
                'mt-2.5 flex flex-wrap items-center gap-2 border-t border-ff-border-2 pt-2.5 text-[13px] font-bold text-ff-ink-2',
                !reminderOn && 'opacity-50',
              )}
            >
              Час на изпращане:
              <select
                value={sendHour}
                onChange={(e) => void saveSendHour(parseInt(e.target.value, 10))}
                disabled={!reminderOn || cutoffLoading || savingReminderCfg}
                aria-label="Час на изпращане на напомнянето"
                className="rounded-md border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13px] font-bold text-ff-ink outline-none disabled:cursor-not-allowed"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
              <span className="text-[12px] font-normal text-ff-muted">сутринта в деня на доставка</span>
            </div>
          </div>

          {slot && (
            <label
              className={cn(
                'mb-3 flex items-center justify-between gap-3 rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-2.5',
                !reminderOn && 'opacity-50',
              )}
            >
              <span className="flex flex-col">
                <span className="text-[13.5px] font-bold text-ff-ink">Напомни за този ден</span>
                <span className="text-[12px] text-ff-muted">
                  {reminderOn
                    ? `Изключи, за да пропуснеш напомнянето само за ${date}.`
                    : 'Включи автоматичното напомняне горе, за да важи.'}
                </span>
              </span>
              <ToggleSwitch
                checked={!slot.reminderOptOut}
                onChange={(v) => void toggleReminder(v)}
                disabled={savingReminder || !reminderOn}
              />
            </label>
          )}

          <label className="mb-3 flex flex-wrap items-center gap-2 text-[13px] font-bold text-ff-ink-2">
            Начало на доставката:
            <select
              value={startHour}
              onChange={(e) => setStartHour(parseInt(e.target.value, 10))}
              disabled={cutoffLoading || generating}
              aria-label="Начален час на доставката"
              className="rounded-md border border-ff-border bg-ff-surface-2 px-2.5 py-1.5 text-[13px] font-bold text-ff-ink outline-none"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
            <span className="text-[12px] font-normal text-ff-muted">
              от кога куриерът тръгва — часовете се смятат оттук
            </span>
          </label>

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

          {proposal && farmerSummary.length > 1 && (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-ff-border bg-ff-surface-2 px-3.5 py-2.5">
              <span className="text-[12px] font-bold text-ff-ink-2">Фермери днес:</span>
              {farmerSummary.map(([name, count]) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-1 rounded-md bg-ff-green-100 px-1.5 py-0.5 text-[11.5px] font-bold text-ff-green-800"
                >
                  {name} · {count}
                </span>
              ))}
            </div>
          )}

          {proposal && (
            <div className="mt-4 flex flex-col gap-5">
              {proposal.couriers.map((c) => {
                const routeValue = c.stops.reduce((n, s) => n + (s.valueStotinki ?? 0), 0);
                const last = c.stops[c.stops.length - 1];
                const lastEnd = last ? (edited[last.id]?.end ?? last.windowEnd) : null;
                return (
                <div key={c.courierIndex}>
                  <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] font-extrabold text-ff-ink">
                    <span>
                      Маршрут {c.courierIndex + 1}
                      {c.name ? ` · ${c.name}` : ''}
                    </span>
                    <span className="text-[11.5px] font-bold text-ff-muted">
                      {c.stops.length} {c.stops.length === 1 ? 'спирка' : 'спирки'}
                      {c.distanceM != null ? ` · ${fmtKmTotal(c.distanceM)}` : ''}
                      {c.durationS != null ? ` · ~${fmtDurTotal(c.durationS)}` : ''}
                      {lastEnd ? ` · до ${lastEnd}` : ''}
                      {` · ${moneyFromStotinki(routeValue)}`}
                    </span>
                  </h3>
                  <div className="flex flex-col gap-2">
                    {c.stops.map((s, i) => {
                      const cur = edited[s.id] ?? { start: s.windowStart, end: s.windowEnd };
                      return (
                        <div
                          key={s.id}
                          className="flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-xl border border-ff-border-2 px-3 py-2"
                        >
                          <span className="flex min-w-0 flex-1 basis-[58%] flex-col">
                            <span className="truncate text-[13px] font-bold text-ff-ink">
                              {s.customer ?? 'Клиент'}
                            </span>
                            {s.address && (
                              <span className="truncate text-[11px] text-ff-muted">{s.address}</span>
                            )}
                            <span className="text-[11px] text-ff-muted">
                              {fmtGap(s.distanceFromPrevM, s.durationFromPrevS)}{' '}
                              {i === 0 ? 'от старта' : 'от предната'} · {moneyFromStotinki(s.valueStotinki)}
                            </span>
                            {s.farmers && s.farmers.length > 0 && (
                              <span className="truncate text-[11px] font-bold text-ff-green-800">
                                {s.farmers.join(', ')}
                                {s.farmers.length > 1 ? ' · споделена' : ''}
                              </span>
                            )}
                            {!s.hasEmail && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-ff-muted">
                                <MailX size={12} className="shrink-0" /> без имейл
                              </span>
                            )}
                          </span>
                          <div className="ml-auto flex shrink-0 items-center gap-2">
                            {s.hasEmail && (
                              <Mail size={13} className="shrink-0 text-ff-green-700" />
                            )}
                            <TimeInput24
                              value={cur.start}
                              onCommit={(next) => {
                                setField(s.id, 'start', next);
                                void commit(s.id, s, { ...cur, start: next });
                              }}
                              ariaLabel={`Начало за ${s.customer ?? 'клиента'}`}
                              className="w-[64px] rounded-md border border-ff-border bg-ff-surface-2 px-2 py-1 text-center text-[13px] font-bold tabular-nums text-ff-ink outline-none"
                            />
                            <span className="text-ff-muted">–</span>
                            <TimeInput24
                              value={cur.end}
                              onCommit={(next) => {
                                setField(s.id, 'end', next);
                                void commit(s.id, s, { ...cur, end: next });
                              }}
                              ariaLabel={`Край за ${s.customer ?? 'клиента'}`}
                              className="w-[64px] rounded-md border border-ff-border bg-ff-surface-2 px-2 py-1 text-center text-[13px] font-bold tabular-nums text-ff-ink outline-none"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                );
              })}
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
