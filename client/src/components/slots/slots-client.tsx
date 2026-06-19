'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Info, Truck, X, CalendarCog } from 'lucide-react';
import { toast } from 'sonner';
import { cn, bgWeekdayShort, ddmm, hhmm } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { HelpModal, InfoNote } from '@/components/delivery/ui';
import { SLOTS_HELP } from '@/lib/delivery-data';
import { SlotPill } from './slot-pill';
import { AddSlotDialog, type SlotInput } from './add-slot-dialog';
import { RecurrenceCard } from './recurrence-card';
import { ApiError, createSlot, updateSlot, deleteSlot, listSlots, closeSlotDay, openSlotDay } from '@/lib/api-client';
import { splitWindowChunks } from '@/lib/slot-chunks';
import type { Slot, SlotRule } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function SlotsClient({
  initialSlots,
  initialRule,
  days,
  today,
  deliveryEnabled,
}: {
  initialSlots: Slot[];
  initialRule: SlotRule | null;
  days: string[];
  /** Real current date (YYYY-MM-DD, Sofia) for the "ДНЕС" highlight. */
  today: string;
  deliveryEnabled: boolean;
}) {
  const router = useRouter();
  const [slots, setSlots] = useState<Slot[]>(initialSlots);
  const [addDate, setAddDate] = useState<string | null>(null);
  const [editSlot, setEditSlot] = useState<Slot | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  // Dates the recurring rule skips ("затворен ден"). Mirrors rule.skipDates and
  // is kept in sync locally as days are closed/reopened.
  const [closedDates, setClosedDates] = useState<Set<string>>(
    () => new Set(initialRule?.skipDates ?? []),
  );
  const [busyDay, setBusyDay] = useState<string | null>(null);
  const [dayDialog, setDayDialog] = useState<string | null>(null);

  // The master delivery switch lives on the Доставка page — here it's read-only
  // so the same flag is never toggled from two screens (it would go stale).
  const delivery = deliveryEnabled;
  const weekLabel = days.length === 7 ? `Седмица ${ddmm(days[0])} – ${ddmm(days[6])}` : '';

  const byDay = (d: string) =>
    slots.filter((s) => s.date === d).sort((a, b) => a.timeFrom.localeCompare(b.timeFrom));

  async function onSubmit(data: SlotInput, editingId: string | null) {
    if (editingId) {
      const updated = await updateSlot(editingId, data);
      setSlots((prev) => prev.map((s) => (s.id === editingId ? updated : s)));
      toast.success('Слотът е обновен');
    } else {
      const created = await createSlot(data);
      setSlots((prev) => [...prev, created]);
      toast.success('Слотът е добавен');
    }
  }

  /** Refetch the visible week so the grid matches the server after a day action. */
  async function refreshWeek() {
    if (days.length) setSlots(await listSlots(days[0], days[days.length - 1]));
  }

  /**
   * Apply the per-day schedule: clear the date's unbooked slots + skip it in the
   * rule, then (when the farmer IS working that day, just differently) create the
   * custom window's slots — split by the rule's delivery duration, 1 order per
   * sub-slot when a duration is set.
   */
  async function applyDay(d: string, working: boolean, win: { timeFrom: string; timeTo: string }) {
    setBusyDay(d);
    try {
      const res = await closeSlotDay(d);
      let createdN = 0;
      if (working) {
        const slotMinutes = initialRule?.slotMinutes ?? 0;
        for (const c of splitWindowChunks(win, slotMinutes)) {
          await createSlot({
            date: d,
            timeFrom: c.timeFrom,
            timeTo: c.timeTo,
          });
          createdN++;
        }
      }
      await refreshWeek();
      setClosedDates((prev) => new Set(prev).add(d));
      const kept = res.kept > 0 ? ` · ${res.kept} часа с поръчки останаха` : '';
      toast.success(
        working
          ? `Графикът за ${ddmm(d)} е променен (${createdN} часа)${kept}`
          : `${ddmm(d)} е затворен — няма доставка${kept}`,
      );
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyDay(null);
    }
  }

  /** Drop the override: un-skip the date and let the rule refill its standard slots. */
  async function resetDay(d: string) {
    setBusyDay(d);
    try {
      const res = await openSlotDay(d);
      await refreshWeek();
      setClosedDates((prev) => {
        const next = new Set(prev);
        next.delete(d);
        return next;
      });
      toast.success(res.created > 0 ? `Стандартният график е върнат (${res.created} часа)` : 'Стандартният график е върнат');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyDay(null);
    }
  }

  async function onDelete(s: Slot) {
    setBusyId(s.id);
    setSlots((prev) => prev.filter((x) => x.id !== s.id)); // optimistic
    try {
      await deleteSlot(s.id);
      toast.success('Слотът е изтрит');
    } catch (e) {
      setSlots((prev) => [...prev, s]); // rollback
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-[18px] flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ff-muted">
          <span className="font-extrabold text-ff-ink">Лична доставка</span>
          {weekLabel && <> · {weekLabel}</>}
        </p>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-[12.5px] font-semibold text-ff-muted max-sm:hidden">
            <Legend c="var(--ff-green-500)" t="свободно" />
            <Legend c="var(--ff-muted-2)" t="заето" />
          </div>
          <Button variant="ghost" size="sm" onClick={() => setHelp(true)}>
            <Info size={16} /> Обяснения
          </Button>
          {/* Read-only mirror of the master toggle + a jump to where it's changed
              (the „Лична доставка + слотове" switch lives in Методи и цени). */}
          <Link
            href="/settings?config=setup"
            className="inline-flex items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3 py-2 text-[13px] font-bold text-ff-ink-2 shadow-ff-sm transition-colors hover:bg-ff-surface-2"
          >
            <Truck size={15} className={delivery ? 'text-ff-green-700' : 'text-ff-muted'} />
            Доставка:{' '}
            <span className={delivery ? 'text-ff-green-700' : 'text-ff-muted'}>
              {delivery ? 'включена' : 'изключена'}
            </span>
          </Link>
        </div>
      </div>

      <InfoNote tone="green">
        Това са часовете за <b>личната ти доставка</b> — ти доставяш сам, без куриер. Клиентът избира
        свободен час при поръчка. За доставка с куриер виж „Доставка → Еконт“.
      </InfoNote>

      <div className="mt-4">
        <RecurrenceCard initial={initialRule} onSaved={() => router.refresh()} />
      </div>

      {!delivery && (
        <div className="mb-4 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-4 py-3 text-[13.5px] font-semibold text-ff-amber-600">
          Доставката е изключена — слотовете не се показват в онлайн магазина. Включи
          „Лична доставка + слотове“ от{' '}
          <Link href="/settings?config=setup" className="underline">
            „Методи и цени“
          </Link>
          , за да ги активираш.
        </div>
      )}

      <div
        className={cn(
          'grid grid-cols-7 items-start gap-3 max-lg:flex max-lg:snap-x max-lg:overflow-x-auto max-lg:pb-2',
          !delivery && 'pointer-events-none opacity-50',
        )}
      >
        {days.map((d) => {
          const isToday = d === today;
          const isClosed = closedDates.has(d);
          return (
            <div
              key={d}
              className={cn(
                'overflow-hidden rounded-[14px] max-lg:min-w-[160px] max-lg:shrink-0 max-lg:snap-start',
                isToday
                  ? 'border-2 border-ff-green-600 bg-ff-surface shadow-[0_6px_20px_rgba(44,85,48,0.14)]'
                  : 'border border-ff-border bg-ff-surface shadow-ff-sm',
              )}
            >
              <div className={cn('border-b border-ff-border-2 px-3 pb-2.5 pt-3 text-center', isToday && 'bg-ff-green-50')}>
                <div className={cn('text-[13px] font-extrabold', isToday ? 'text-ff-green-800' : 'text-ff-ink')}>
                  {bgWeekdayShort(d)}
                </div>
                <div className="mt-px text-xs font-semibold text-ff-muted">{ddmm(d)}</div>
                {isToday && <div className="mt-1 text-[10.5px] font-extrabold tracking-wide text-ff-green-700">ДНЕС</div>}
              </div>
              <div className="flex min-h-[90px] flex-col gap-[7px] p-[9px]">
                {isClosed && (
                  <div className="rounded-[10px] bg-ff-amber-softer px-2 py-1.5 text-center text-[11px] font-extrabold text-ff-amber-600">
                    {byDay(d).length ? 'Променен график' : 'Няма доставка'}
                  </div>
                )}
                {byDay(d).map((s) => (
                  <SlotPill
                    key={s.id}
                    slot={s}
                    busy={busyId === s.id}
                    onDelete={() => onDelete(s)}
                    onEdit={() => setEditSlot(s)}
                  />
                ))}
                <button
                  onClick={() => setAddDate(d)}
                  className="mt-0.5 flex items-center justify-center gap-1.5 rounded-[10px] border-[1.5px] border-dashed border-ff-border px-2 py-2 text-xs font-bold text-ff-muted transition-colors hover:border-ff-green-500 hover:bg-ff-green-50 hover:text-ff-green-700"
                >
                  <Plus size={15} /> Слот
                </button>
                {/* Per-day override dialog: "няма да доставям на 15.06" or
                    "този ден работя в други часове". */}
                <button
                  onClick={() => setDayDialog(d)}
                  disabled={busyDay === d}
                  className="flex items-center justify-center gap-1.5 text-[11.5px] font-bold text-ff-ink-2 underline-offset-2 hover:text-ff-green-700 hover:underline disabled:opacity-50"
                >
                  <CalendarCog size={13} /> {busyDay === d ? 'Запазване…' : 'Промени деня'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <AddSlotDialog
        date={editSlot ? null : addDate}
        slot={editSlot}
        onClose={() => {
          setAddDate(null);
          setEditSlot(null);
        }}
        onSubmit={onSubmit}
      />

      {dayDialog && (
        <DayScheduleDialog
          date={dayDialog}
          closed={closedDates.has(dayDialog)}
          daySlots={byDay(dayDialog)}
          slotMinutes={initialRule?.slotMinutes ?? 0}
          onClose={() => setDayDialog(null)}
          onApply={(working, win) => {
            setDayDialog(null);
            void applyDay(dayDialog, working, win);
          }}
          onReset={() => {
            setDayDialog(null);
            void resetDay(dayDialog);
          }}
        />
      )}

      {help && (
        <HelpModal
          eyebrow={SLOTS_HELP.eyebrow}
          title={SLOTS_HELP.title}
          intro={SLOTS_HELP.intro}
          steps={SLOTS_HELP.steps}
          tips={SLOTS_HELP.tips}
          onClose={() => setHelp(false)}
        />
      )}
    </div>
  );
}

function Legend({ c, t }: { c: string; t: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-[9px] w-[9px] rounded-full" style={{ background: c }} />
      {t}
    </span>
  );
}

const dlgField =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-bold text-ff-ink outline-none focus:border-ff-green-500';
const dlgLabel = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

/**
 * Per-date schedule override: "доставям ли на 15.06, и ако да — от колко до
 * колко". Applying clears the date's unbooked slots and (when working) creates
 * the custom window's slots, split by the rule's delivery duration. "Върни
 * стандартния график" drops the override and lets the rule refill the date.
 */
function DayScheduleDialog({
  date,
  closed,
  daySlots,
  slotMinutes,
  onClose,
  onApply,
  onReset,
}: {
  date: string;
  closed: boolean;
  daySlots: Slot[];
  slotMinutes: number;
  onClose: () => void;
  onApply: (working: boolean, win: { timeFrom: string; timeTo: string }) => void;
  onReset: () => void;
}) {
  // Seed from the day's current slots so "different hours" starts from reality.
  const first = daySlots[0];
  const last = daySlots[daySlots.length - 1];
  const [working, setWorking] = useState(closed ? daySlots.length > 0 : true);
  const [from, setFrom] = useState(first ? hhmm(first.timeFrom) : '10:00');
  const [to, setTo] = useState(last ? hhmm(last.timeTo) : '12:00');
  const [err, setErr] = useState('');

  const chunks =
    working && /^\d{2}:\d{2}$/.test(from) && /^\d{2}:\d{2}$/.test(to) && to > from
      ? splitWindowChunks({ timeFrom: from, timeTo: to }, slotMinutes)
      : [];

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (working) {
      if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) return setErr('Часът трябва да е ЧЧ:ММ');
      if (to <= from) return setErr('Краят трябва да е след началото');
    }
    onApply(working, { timeFrom: from, timeTo: to });
  }

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="animate-ff-pop w-[420px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-[18px] font-extrabold">График за деня</h2>
          <button
            onClick={onClose}
            aria-label="Затвори"
            className="grid h-8 w-8 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2"
          >
            <X size={18} />
          </button>
        </div>
        <p className="mb-4 text-[13px] text-ff-muted">
          {bgWeekdayShort(date)} · {ddmm(date)}
        </p>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex items-center justify-between gap-3 rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-2.5">
            <span className="flex flex-col">
              <span className="text-[13.5px] font-bold text-ff-ink">Доставям този ден</span>
              <span className="text-[12px] text-ff-muted">
                Изключи, ако на тази дата няма да има доставки.
              </span>
            </span>
            <ToggleSwitch checked={working} onChange={setWorking} />
          </label>

          {working && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className={dlgLabel}>
                  Начало
                  <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className={dlgField} />
                </label>
                <label className={dlgLabel}>
                  Край
                  <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className={dlgField} />
                </label>
              </div>
              {chunks.length > 0 && (
                <p className="text-[12.5px] leading-relaxed text-ff-muted">
                  {slotMinutes > 0
                    ? `${chunks.length} ${chunks.length === 1 ? 'час' : 'часа'} по ${slotMinutes} мин: ${chunks.slice(0, 6).map((c) => `${c.timeFrom}–${c.timeTo}`).join(' · ')}${chunks.length > 6 ? ' …' : ''} — по 1 поръчка на час.`
                    : `Един слот: ${from}–${to} — 1 поръчка.`}
                </p>
              )}
            </>
          )}

          <p className="text-[12px] leading-snug text-ff-muted">
            Свободните часове за датата се подменят; часове с поръчки остават. Повтарящото се правило спира
            да създава часове за тази дата, докато не върнеш стандартния график.
          </p>

          {err && <p className="text-[13px] font-semibold text-ff-red">{err}</p>}

          <div className="mt-1 flex items-center justify-between gap-2">
            {closed ? (
              <button
                type="button"
                onClick={onReset}
                className="text-[12.5px] font-bold text-ff-green-700 underline-offset-2 hover:underline"
              >
                Върни стандартния график
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" type="button" onClick={onClose} className="rounded-sm">
                Отказ
              </Button>
              <Button variant="primary" type="submit" className="rounded-sm">
                Запази
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
