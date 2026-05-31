'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { cn, bgWeekdayShort, ddmm } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { SlotPill } from './slot-pill';
import { AddSlotDialog } from './add-slot-dialog';
import { ApiError, createSlot, deleteSlot, setDeliveryEnabled } from '@/lib/api-client';
import type { Slot } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
// Demo week reference (matches the design's "today"). Seeded week is 25–31 May 2026.
const TODAY = '2026-05-30';

export function SlotsClient({
  initialSlots,
  days,
  deliveryEnabled,
}: {
  initialSlots: Slot[];
  days: string[];
  deliveryEnabled: boolean;
}) {
  const [slots, setSlots] = useState<Slot[]>(initialSlots);
  const [delivery, setDelivery] = useState(deliveryEnabled);
  const [addDate, setAddDate] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const byDay = (d: string) =>
    slots.filter((s) => s.date === d).sort((a, b) => a.timeFrom.localeCompare(b.timeFrom));

  async function onToggleDelivery(on: boolean) {
    setDelivery(on); // optimistic
    try {
      await setDeliveryEnabled(on);
      toast.success(on ? 'Доставката е включена' : 'Доставката е изключена');
    } catch (e) {
      setDelivery(!on);
      toast.error(errMsg(e));
    }
  }

  async function onAdd(data: { date: string; timeFrom: string; timeTo: string; maxOrders: number }) {
    const created = await createSlot(data);
    setSlots((prev) => [...prev, created]);
    toast.success('Слотът е добавен');
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
        <p className="text-sm text-ff-muted">Седмица 25 – 31 май 2026 · Варна</p>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-[12.5px] font-semibold text-ff-muted max-sm:hidden">
            <Legend c="var(--ff-green-500)" t="свободно" />
            <Legend c="var(--ff-amber)" t="почти пълно" />
            <Legend c="var(--ff-muted-2)" t="пълно" />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-[13px] font-bold text-ff-ink-2">
            <ToggleSwitch small checked={delivery} onChange={onToggleDelivery} />
            Доставка
          </label>
        </div>
      </div>

      {!delivery && (
        <div className="mb-4 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-4 py-3 text-[13.5px] font-semibold text-ff-amber-600">
          Доставката е изключена — слотовете не се показват в онлайн магазина. Включи „Доставка“, за да ги активираш.
        </div>
      )}

      <div
        className={cn(
          'grid grid-cols-7 items-start gap-3 max-lg:flex max-lg:snap-x max-lg:overflow-x-auto max-lg:pb-2',
          !delivery && 'pointer-events-none opacity-50',
        )}
      >
        {days.map((d) => {
          const today = d === TODAY;
          return (
            <div
              key={d}
              className={cn(
                'overflow-hidden rounded-[14px] max-lg:min-w-[160px] max-lg:shrink-0 max-lg:snap-start',
                today
                  ? 'border-2 border-ff-green-600 bg-ff-surface shadow-[0_6px_20px_rgba(44,85,48,0.14)]'
                  : 'border border-ff-border bg-ff-surface shadow-ff-sm',
              )}
            >
              <div className={cn('border-b border-ff-border-2 px-3 pb-2.5 pt-3 text-center', today && 'bg-ff-green-50')}>
                <div className={cn('text-[13px] font-extrabold', today ? 'text-ff-green-800' : 'text-ff-ink')}>
                  {bgWeekdayShort(d)}
                </div>
                <div className="mt-px text-xs font-semibold text-ff-muted">{ddmm(d)}</div>
                {today && <div className="mt-1 text-[10.5px] font-extrabold tracking-wide text-ff-green-700">ДНЕС</div>}
              </div>
              <div className="flex min-h-[90px] flex-col gap-[7px] p-[9px]">
                {byDay(d).map((s) => (
                  <SlotPill key={s.id} slot={s} busy={busyId === s.id} onDelete={() => onDelete(s)} />
                ))}
                <button
                  onClick={() => setAddDate(d)}
                  className="mt-0.5 flex items-center justify-center gap-1.5 rounded-[10px] border-[1.5px] border-dashed border-ff-border px-2 py-2 text-xs font-bold text-ff-muted transition-colors hover:border-ff-green-500 hover:bg-ff-green-50 hover:text-ff-green-700"
                >
                  <Plus size={15} /> Слот
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <AddSlotDialog date={addDate} onClose={() => setAddDate(null)} onAdd={onAdd} />
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
