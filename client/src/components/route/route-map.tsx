'use client';

import { Plus, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RouteStop } from '@/lib/types';

interface RouteMapProps {
  stops: RouteStop[];
  activeId: string | null;
  onPick: (id: string) => void;
}

/** Deterministic demo-map position (%) for a stop when no real geo is available. */
function demoPos(i: number, n: number): { x: number; y: number } {
  const x = n <= 1 ? 50 : 15 + (i / (n - 1)) * 70;
  const y = Math.min(82, Math.max(14, 38 + Math.sin(i * 1.3 + 0.5) * 20));
  return { x, y };
}

export function RouteMap({ stops, activeId, onPick }: RouteMapProps) {
  // Demo placeholder map (matches the prototype) — no external maps dependency.
  const pts = stops.map((_, i) => demoPos(i, stops.length));

  return (
    <div className="absolute inset-0 bg-[#E9E7DF]">
      {/* subtle grid + fake roads */}
      <svg width="100%" height="100%" className="absolute inset-0">
        <defs>
          <pattern id="ffgrid" width="46" height="46" patternUnits="userSpaceOnUse">
            <path d="M46 0H0V46" fill="none" stroke="#D8D5CA" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#ffgrid)" />
        <path d="M-20 70 Q 200 40 420 130 T 900 180" fill="none" stroke="#D2CFC3" strokeWidth="11" strokeLinecap="round" />
        <path d="M120 -20 Q 180 200 120 460 T 260 900" fill="none" stroke="#D2CFC3" strokeWidth="9" strokeLinecap="round" />
        <path d="M-20 320 Q 320 300 620 380 T 1100 360" fill="none" stroke="#D2CFC3" strokeWidth="8" strokeLinecap="round" />
      </svg>

      {/* route line between pins */}
      {pts.length > 1 && (
        <svg
          width="100%"
          height="100%"
          className="pointer-events-none absolute inset-0"
          preserveAspectRatio="none"
          viewBox="0 0 100 100"
        >
          <polyline
            points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="var(--ff-green-600)"
            strokeWidth="0.7"
            strokeDasharray="1.4 1.4"
            strokeLinecap="round"
            opacity="0.75"
          />
        </svg>
      )}

      {/* pins */}
      {stops.map((s, i) => {
        const on = activeId === s.id;
        return (
          <button
            key={s.id}
            onClick={() => onPick(s.id)}
            className="absolute z-[1] -translate-x-1/2 -translate-y-full transition-transform"
            style={{ left: `${pts[i].x}%`, top: `${pts[i].y}%`, zIndex: on ? 3 : 1 }}
          >
            <span
              className={cn(
                'grid h-[30px] w-[30px] place-items-center rounded-[50%_50%_50%_2px] shadow-[0_4px_10px_rgba(0,0,0,0.25)] transition-transform',
                on ? 'bg-ff-amber' : 'bg-ff-green-700',
              )}
              style={{ transform: `rotate(45deg) scale(${on ? 1.12 : 1})` }}
            >
              <span
                className={cn('text-[13.5px] font-extrabold', on ? 'text-[#3a2a08]' : 'text-white')}
                style={{ transform: 'rotate(-45deg)' }}
              >
                {i + 1}
              </span>
            </span>
          </button>
        );
      })}

      {/* labels + zoom chrome (decorative) */}
      <div className="pointer-events-none absolute bottom-[13px] left-[14px] select-none text-[21px] font-bold tracking-[-0.01em] text-[#9A9788]">
        Google Maps
      </div>
      <div className="absolute right-[14px] top-[13px] rounded-[9px] bg-white/80 px-[11px] py-[7px] text-xs font-bold text-ff-ink-2 shadow-ff-sm">
        Демо карта — място за Google Maps
      </div>
      <div className="absolute bottom-[13px] right-[14px] flex flex-col overflow-hidden rounded-[9px] bg-white shadow-ff-md">
        <button className="grid h-[34px] w-9 place-items-center border-b border-ff-border-2 text-ff-ink-2 hover:bg-ff-surface-2">
          <Plus size={17} />
        </button>
        <button className="grid h-[34px] w-9 place-items-center text-ff-ink-2 hover:bg-ff-surface-2">
          <Minus size={17} />
        </button>
      </div>
    </div>
  );
}
