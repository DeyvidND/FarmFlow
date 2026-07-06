'use client';

import {
  Navigation,
  X,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Clock,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react';
import { wazeUrl, type WazeTarget } from './waze';

const fmtSlot = (from: string | null, to: string | null) =>
  from && to ? `${from}–${to}` : (from ?? to ?? null);

export function WazeStepper({
  targets,
  idx,
  onNavigate,
  onPrev,
  onNext,
  onReset,
  onClose,
}: {
  targets: WazeTarget[];
  /** Current target index; `targets.length` = all stops done. */
  idx: number;
  onNavigate: (i: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const total = targets.length;
  const done = idx >= total;
  const cur = done ? null : targets[idx];
  const url = cur ? wazeUrl(cur) : null;
  const slot = cur ? fmtSlot(cur.slotFrom, cur.slotTo) : null;

  return (
    <div className="mb-3 rounded-xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-[14px] font-extrabold text-ff-ink">
          <Navigation size={16} className="text-ff-green-800" /> Навигация с Waze
        </h3>
        <button
          onClick={onClose}
          aria-label="Затвори"
          className="grid h-7 w-7 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2 hover:text-ff-ink"
        >
          <X size={16} />
        </button>
      </div>

      {done ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[13px] font-bold text-ff-green-800">Всички спирки минати ✓</p>
          <button
            onClick={onReset}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[13px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2"
          >
            <RotateCcw size={14} /> Започни отначало
          </button>
        </div>
      ) : (
        <>
          <p className="mb-1 text-[12.5px] font-bold text-ff-muted">
            {cur!.label} · {idx + 1} от {total}
          </p>
          <p className="text-[15px] font-extrabold text-ff-ink">{cur!.customer ?? 'Клиент'}</p>
          {cur!.address && (
            <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ff-ink-2">
              <MapPin size={13} className="shrink-0 text-ff-muted" /> {cur!.address}
            </p>
          )}
          {slot && (
            <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ff-ink-2">
              <Clock size={13} className="shrink-0 text-ff-muted" /> {slot}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {url ? (
              <button
                onClick={() => onNavigate(idx)}
                className="inline-flex items-center gap-1.5 rounded-[9px] bg-ff-green-100 px-4 py-2.5 text-[14px] font-extrabold text-ff-green-800 transition hover:brightness-95"
              >
                <Navigation size={15} /> Навигирай с Waze →
              </button>
            ) : (
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-ff-amber-soft bg-ff-amber-softer px-3 py-2 text-[12.5px] font-bold text-ff-amber-600">
                <AlertTriangle size={14} /> Тази спирка не е на картата
                <button onClick={onNext} className="ml-1 rounded-md bg-white/50 px-2 py-0.5 underline">
                  Пропусни
                </button>
              </div>
            )}
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={onPrev}
                disabled={idx === 0}
                aria-label="Предишна спирка"
                className="grid h-9 w-9 place-items-center rounded-lg border border-ff-border bg-ff-surface text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                onClick={onNext}
                aria-label="Следваща спирка"
                className="grid h-9 w-9 place-items-center rounded-lg border border-ff-border bg-ff-surface text-ff-ink-2 transition hover:bg-ff-surface-2"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>

          <p className="mt-2.5 text-[12px] text-ff-muted">
            Waze тръгва от текущото ти място до тази спирка. След доставка цъкни «Следваща» или бутона за навигация към следващата.
          </p>
        </>
      )}
    </div>
  );
}
