'use client';

import { X } from 'lucide-react';
import { hhmm } from '@/lib/utils';
import { slotColor } from '@/lib/slots';
import type { Slot } from '@/lib/types';

export function SlotPill({
  slot,
  onDelete,
  onEdit,
  busy,
}: {
  slot: Slot;
  onDelete: () => void;
  onEdit: () => void;
  busy?: boolean;
}) {
  const c = slotColor(slot.booked, slot.maxOrders);
  const pct = slot.maxOrders > 0 ? Math.round((slot.booked / slot.maxOrders) * 100) : 0;
  const hasNote = !!(slot.customerNote || slot.driverNote);

  return (
    <div className="group relative rounded-[10px] px-[9px] py-2" style={{ background: c.bg }}>
      <button
        onClick={onDelete}
        disabled={busy}
        aria-label="Изтрий слот"
        className="absolute right-1 top-1 hidden h-4 w-4 place-items-center rounded-full bg-white/70 text-ff-muted hover:text-ff-red group-hover:grid [@media(hover:none)]:grid"
      >
        <X size={11} />
      </button>
      <button type="button" onClick={onEdit} className="block w-full text-left">
        <div className="flex items-center gap-1 whitespace-nowrap text-[11.5px] font-bold text-ff-ink">
          {hhmm(slot.timeFrom)} – {hhmm(slot.timeTo)}
          {slot.generated && (
            <span title="Автоматичен слот (от правило)" className="text-[10px] font-extrabold text-ff-green-700">
              ↻
            </span>
          )}
          {hasNote && (
            <span
              title={slot.driverNote || slot.customerNote || ''}
              className="h-[5px] w-[5px] rounded-full bg-ff-green-600"
            />
          )}
        </div>
        <div className="mt-1 flex items-center justify-between">
          <div
            className="mr-[7px] h-[5px] flex-1 overflow-hidden rounded-full"
            style={{ background: 'rgba(0,0,0,0.07)' }}
          >
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: c.bar }} />
          </div>
          <span className="text-[11.5px] font-extrabold" style={{ color: c.ink }}>
            {slot.booked}/{slot.maxOrders}
          </span>
        </div>
      </button>
    </div>
  );
}
