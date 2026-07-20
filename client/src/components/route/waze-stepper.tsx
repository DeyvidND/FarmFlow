'use client';

import {
  Navigation,
  X,
  ChevronLeft,
  ChevronRight,
  MapPin,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react';
import { wazeUrl, type WazeTarget } from './waze';

export function WazeStepper({
  targets,
  idx,
  onNavigate,
  onJump,
  onPrev,
  onNext,
  onReset,
  onClose,
}: {
  targets: WazeTarget[];
  /** Current target index; `targets.length` = all stops done. */
  idx: number;
  onNavigate: (i: number) => void;
  /** Move the current stop without opening Waze — for the progress dots. */
  onJump: (i: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const total = targets.length;
  const done = idx >= total;
  const cur = done ? null : targets[idx];
  const url = cur ? wazeUrl(cur) : null;

  return (
    <div
      className="animate-ff-fade fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="animate-ff-pop max-h-[90vh] w-[420px] max-w-full overflow-y-auto overscroll-contain rounded-2xl border border-ff-border bg-ff-surface p-5 shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Навигация с Waze"
      >
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

        {/* progress: one segment per stop, filled up to the current one — clicking
            a segment jumps straight to that stop instead of stepping through prev/next */}
        <div className="mb-3 flex items-center gap-1">
          {targets.map((t, i) => (
            <button
              key={t.key}
              onClick={() => onJump(i)}
              title={`${i + 1}. ${t.customer ?? t.label}`}
              aria-label={`Спирка ${i + 1} от ${total}`}
              className={`h-1.5 flex-1 rounded-full transition ${
                i < idx || done
                  ? 'bg-ff-green-500'
                  : i === idx
                    ? 'bg-ff-green-300'
                    : 'bg-ff-border'
              }`}
            />
          ))}
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
            <div className="mt-3">
              {url ? (
                <button
                  onClick={() => onNavigate(idx)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-[9px] bg-ff-green-100 px-4 py-2.5 text-[14px] font-extrabold text-ff-green-800 transition hover:brightness-95"
                >
                  <Navigation size={15} /> Навигирай с Waze →
                </button>
              ) : (
                <div className="flex items-center gap-1.5 rounded-lg border border-ff-amber-soft bg-ff-amber-softer px-3 py-2 text-[12.5px] font-bold text-ff-amber-600">
                  <AlertTriangle size={14} /> Тази спирка не е на картата
                  <button onClick={onNext} className="ml-1 rounded-md bg-white/50 px-2 py-0.5 underline">
                    Пропусни
                  </button>
                </div>
              )}
            </div>

            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={onPrev}
                disabled={idx === 0}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-ff-border bg-ff-surface py-2 text-[13px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft size={16} /> Предишна
              </button>
              <button
                onClick={onNext}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-ff-border bg-ff-surface py-2 text-[13px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2"
              >
                Следваща <ChevronRight size={16} />
              </button>
            </div>

            <p className="mt-2.5 text-[12px] text-ff-muted">
              Waze не поддържа маршрути с много спирки — приема само по една дестинация наведнъж,
              затова е спирка по спирка. Тръгва от текущото ти място до тази спирка; след доставка
              цъкни «Следваща» или бутона за навигация към следващата. Точките горе показват
              напредъка — цъкни на коя да е, за да скочиш направо до нея.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
