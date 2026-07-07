'use client';

import { X, Users } from 'lucide-react';
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
  const cap = slot.capacity ?? 1;
  const c = slotColor(slot.booked, cap);
  const full = slot.booked >= cap;
  const remaining = Math.max(0, cap - slot.booked);
  const hasNote = !!(slot.customerNote || slot.driverNote);
  // The booked/capacity fraction is the primary line now — a day-row can take
  // several orders. The hover title spells the fraction out in words.
  const capTitle = full ? 'Запълнен' : `Още ${remaining} ${remaining === 1 ? 'свободно място' : 'свободни места'}`;

  return (
    <div className="group relative rounded-[10px] px-[9px] py-2" style={{ background: c.bg }}>
      <button
        onClick={onDelete}
        disabled={busy}
        aria-label="Изтрий деня"
        className="absolute right-1 top-1 hidden h-4 w-4 place-items-center rounded-full bg-white/70 text-ff-muted hover:text-ff-red group-hover:grid [@media(hover:none)]:grid"
      >
        <X size={11} />
      </button>
      <button type="button" onClick={onEdit} className="block w-full text-left">
        <div className="flex items-center gap-1 whitespace-nowrap text-[11.5px] font-bold text-ff-ink">
          {slot.timeFrom != null && slot.timeTo != null ? `${hhmm(slot.timeFrom)} – ${hhmm(slot.timeTo)}` : 'Цял ден'}
          {slot.generated && (
            <span title="Автоматичен ден (от правило)" className="text-[10px] font-extrabold text-ff-green-700">
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
          <span
            title={capTitle}
            className="flex items-center gap-0.5 text-[11.5px] font-extrabold"
            style={{ color: c.ink }}
          >
            <Users size={11} strokeWidth={2.75} />
            {slot.booked}/{cap} поръчки
          </span>
        </div>
      </button>
    </div>
  );
}
