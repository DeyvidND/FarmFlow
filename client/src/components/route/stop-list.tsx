'use client';

import { MapPin, Navigation, Phone } from 'lucide-react';
import { cn, hhmm } from '@/lib/utils';
import type { RouteStop } from '@/lib/types';

interface StopListProps {
  stops: RouteStop[];
  activeId: string | null;
  onPick: (id: string) => void;
  onOpenMaps: (stop: RouteStop) => void;
  onCall: (stop: RouteStop) => void;
}

export function StopList({ stops, activeId, onPick, onOpenMaps, onCall }: StopListProps) {
  if (stops.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-14 text-center text-ff-muted">
        <div className="mb-3 grid h-[52px] w-[52px] place-items-center rounded-[14px] bg-ff-green-50 text-ff-green-600">
          <Navigation size={26} />
        </div>
        <div className="text-[15px] font-bold text-ff-ink-2">Няма спирки за този ден</div>
        <div className="mt-0.5 text-[13.5px]">Потвърдените поръчки с доставка до адрес се появяват тук.</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {stops.map((s, i) => {
        const on = activeId === s.id;
        const slot = s.slotFrom && s.slotTo ? `${hhmm(s.slotFrom)} – ${hhmm(s.slotTo)}` : null;
        return (
          <div
            key={s.id}
            onClick={() => onPick(s.id)}
            data-on={on}
            className={cn(
              'flex cursor-pointer gap-[13px] border-b border-ff-border-2 px-[18px] py-3.5 transition-colors',
              on ? 'bg-ff-green-50' : 'hover:bg-ff-surface-2',
            )}
          >
            {/* number bead + connector */}
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13.5px] font-extrabold',
                  on ? 'bg-ff-green-700 text-white' : 'bg-ff-green-100 text-ff-green-800',
                )}
              >
                {i + 1}
              </span>
              {i < stops.length - 1 && <span className="mt-1 min-h-[14px] w-0.5 flex-1 bg-ff-border" />}
            </div>

            {/* details */}
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="text-[14.5px] font-bold">{s.customer}</div>
                <div className="flex shrink-0 gap-[7px]">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenMaps(s);
                    }}
                    title="Отвори в Google Maps"
                    className="grid h-8 w-8 place-items-center rounded-[9px] bg-ff-green-100 text-ff-green-700 transition hover:brightness-95"
                  >
                    <Navigation size={16} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCall(s);
                    }}
                    title="Обади се"
                    className="grid h-8 w-8 place-items-center rounded-[9px] bg-ff-green-100 text-ff-green-700 transition hover:brightness-95"
                  >
                    <Phone size={16} />
                  </button>
                </div>
              </div>
              <div className="mt-0.5 flex items-center gap-[5px] text-[13px] text-ff-ink-2">
                <MapPin size={14} className="shrink-0" /> <span className="truncate">{s.address}</span>
              </div>
              <div className="mt-1 text-[12.5px] text-ff-muted">
                {s.summary}
                {slot && (
                  <>
                    {' · '}
                    <span className="font-semibold">{slot}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
