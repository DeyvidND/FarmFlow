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
  const c = slotColor(slot.booked);
  const taken = slot.booked >= 1;
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
        <div className="mt-1 flex items-center justify-end">
          <span className="text-[11.5px] font-extrabold" style={{ color: c.ink }}>
            {taken ? 'Зает' : 'Свободен'}
          </span>
        </div>
      </button>
    </div>
  );
}
