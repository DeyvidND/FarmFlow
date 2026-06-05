'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, Info, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { cn, bgWeekdayShort, ddmm } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { HelpModal, InfoNote } from '@/components/delivery/ui';
import { SLOTS_HELP } from '@/lib/delivery-data';
import { SlotPill } from './slot-pill';
import { AddSlotDialog } from './add-slot-dialog';
import { ApiError, createSlot, deleteSlot } from '@/lib/api-client';
import type { Slot } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function SlotsClient({
  initialSlots,
  days,
  today,
  deliveryEnabled,
}: {
  initialSlots: Slot[];
  days: string[];
  /** Real current date (YYYY-MM-DD, Sofia) for the "ДНЕС" highlight. */
  today: string;
  deliveryEnabled: boolean;
}) {
  const [slots, setSlots] = useState<Slot[]>(initialSlots);
  const [addDate, setAddDate] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [help, setHelp] = useState(false);

  // The master delivery switch lives on the Доставка page — here it's read-only
  // so the same flag is never toggled from two screens (it would go stale).
  const delivery = deliveryEnabled;
  const weekLabel = days.length === 7 ? `Седмица ${ddmm(days[0])} – ${ddmm(days[6])}` : '';

  const byDay = (d: string) =>
    slots.filter((s) => s.date === d).sort((a, b) => a.timeFrom.localeCompare(b.timeFrom));

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
        <p className="text-sm text-ff-muted">
          <span className="font-extrabold text-ff-ink">Лична доставка</span>
          {weekLabel && <> · {weekLabel}</>}
        </p>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-[12.5px] font-semibold text-ff-muted max-sm:hidden">
            <Legend c="var(--ff-green-500)" t="свободно" />
            <Legend c="var(--ff-amber)" t="почти пълно" />
            <Legend c="var(--ff-muted-2)" t="пълно" />
          </div>
          <Button variant="ghost" size="sm" onClick={() => setHelp(true)}>
            <Info size={16} /> Обяснения
          </Button>
          {/* Read-only mirror of the master toggle + a jump to where it's changed. */}
          <Link
            href="/delivery"
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

      {!delivery && (
        <div className="mb-4 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-4 py-3 text-[13.5px] font-semibold text-ff-amber-600">
          Доставката е изключена — слотовете не се показват в онлайн магазина. Включи я от{' '}
          <Link href="/delivery" className="underline">
            страница „Доставка“
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
