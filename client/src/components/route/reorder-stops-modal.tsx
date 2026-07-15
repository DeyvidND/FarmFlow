'use client';

import { useState } from 'react';
import { X, GripVertical, ChevronUp, ChevronDown, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { RouteStop } from '@/lib/types';
import { moveInOrder, transferInLegs } from './route-order';

/** One courier leg as shown in the modal. `legIndex` is the REAL leg number
 * (the assignment board can leave gaps, e.g. legs [0, 2]); `label` matches the
 * page tab ("Маршрут 1"…), which numbers by position. */
export type ReorderLeg = {
  legIndex: number;
  label: string;
  stops: RouteStop[];
};

/**
 * Compact drag/reorder modal for the day's delivery sequence. The full stop
 * cards in the side list are tall (address + phone + email + products), so
 * reordering there means a lot of scrolling. This modal shows one dense line
 * per stop — position · name · address — so a whole day fits with little or no
 * scroll and can be reordered fast, by drag or ↑↓.
 *
 * With more than one courier it shows EVERY leg, and a stop can be moved to
 * another courier — via the per-row „Маршрут" dropdown or by dragging it into
 * that leg's section. Nothing is applied until „Запази"; „Отказ" discards the
 * draft. „Авто-разпределение" is the day-wide reset: it clears every manual
 * courier pin and manual order so the route re-splits by geography (the fix
 * for a lopsided day where a past drag-reorder pinned a whole leg).
 */
export function ReorderStopsModal({
  legs,
  dateLabel,
  onSave,
  onRebalance,
  onClose,
}: {
  legs: ReorderLeg[];
  dateLabel: string;
  /** Persist the arrangement: full ordered id list per REAL leg index. */
  onSave: (perLeg: { legIndex: number; ids: string[] }[]) => void;
  /** Day-wide reset: clear all pins + manual order, back to auto-split. */
  onRebalance: () => void;
  onClose: () => void;
}) {
  // Ordered stop ids per leg, parallel to `legs` — the draft the user edits.
  const [byLeg, setByLeg] = useState<string[][]>(() => legs.map((l) => l.stops.map((s) => s.id)));
  const [drag, setDrag] = useState<{ leg: number; idx: number } | null>(null);
  const [over, setOver] = useState<{ leg: number; idx: number } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const byId = new Map(legs.flatMap((l) => l.stops).map((s) => [s.id, s]));
  const multi = legs.length > 1;

  const move = (leg: number, i: number, dir: -1 | 1) =>
    setByLeg((cur) => cur.map((ids, li) => (li === leg ? moveInOrder(ids, i, dir) : ids)));

  /** Move a stop to `toLeg` — within a leg it's a drag reorder; across legs the
   * id leaves its leg and lands at `toIdx` (or the end) of the target. */
  const transfer = (from: { leg: number; idx: number }, toLeg: number, toIdx?: number) =>
    setByLeg((cur) => transferInLegs(cur, from, toLeg, toIdx));

  const endDrag = () => {
    setDrag(null);
    setOver(null);
  };

  return (
    <div
      className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ff-border px-5 py-4">
          <h2 className="text-[16px] font-extrabold text-ff-ink">
            Подреди реда на доставка
            <span className="ml-1.5 font-bold capitalize text-ff-muted">· {dateLabel}</span>
          </h2>
          <button onClick={onClose} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <p className="border-b border-ff-border-2 bg-ff-surface-2 px-5 py-2 text-[12px] text-ff-muted">
          Плъзни ред или ползвай ↑↓.
          {multi &&
            ' Премести поръчка при друг куриер с падащото меню или като я плъзнеш в неговия списък.'}{' '}
          Промените се прилагат след „Запази“.
        </p>

        <div className="flex-1 overflow-y-auto py-1">
          {legs.map((l, li) => (
            <div key={l.legIndex}>
              {multi && (
                <div className="sticky top-0 z-[1] border-b border-ff-border-2 bg-ff-surface px-4 py-1.5 text-[12.5px] font-extrabold text-ff-ink-2">
                  {l.label}
                  <span className="ml-1.5 font-bold text-ff-muted">
                    · {byLeg[li].length} {byLeg[li].length === 1 ? 'спирка' : 'спирки'}
                  </span>
                </div>
              )}
              {byLeg[li].map((id, i) => {
                const s = byId.get(id);
                if (!s) return null;
                return (
                  <div
                    key={id}
                    draggable
                    onDragStart={() => setDrag({ leg: li, idx: i })}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (over?.leg !== li || over?.idx !== i) setOver({ leg: li, idx: i });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (drag && !(drag.leg === li && drag.idx === i)) transfer(drag, li, i);
                      endDrag();
                    }}
                    onDragEnd={endDrag}
                    className={cn(
                      'flex items-center gap-2 border-b border-ff-border-2 px-4 py-2 last:border-0',
                      over?.leg === li &&
                        over?.idx === i &&
                        !(drag?.leg === li && drag?.idx === i) &&
                        'bg-ff-green-50 ring-2 ring-inset ring-ff-green-400',
                      drag?.leg === li && drag?.idx === i && 'opacity-50',
                    )}
                  >
                    <span className="cursor-grab text-ff-muted active:cursor-grabbing" title="Плъзни">
                      <GripVertical size={16} />
                    </span>
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ff-green-100 text-[12.5px] font-extrabold text-ff-green-800">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px]">
                      <span className="font-bold text-ff-ink">{s.customer ?? 'Клиент'}</span>
                      <span className="text-ff-muted"> · {s.address ?? 'няма адрес'}</span>
                    </span>
                    {multi && (
                      <select
                        value={li}
                        onChange={(e) => transfer({ leg: li, idx: i }, Number(e.target.value))}
                        title="Премести при друг куриер"
                        className="shrink-0 rounded-lg border border-ff-border bg-ff-surface-2 px-1.5 py-1 text-[12px] font-bold text-ff-ink outline-none"
                      >
                        {legs.map((tl, tli) => (
                          <option key={tl.legIndex} value={tli}>
                            {tl.label}
                          </option>
                        ))}
                      </select>
                    )}
                    <span className="flex shrink-0 gap-1">
                      <button
                        onClick={() => move(li, i, -1)}
                        disabled={i === 0}
                        title="Нагоре"
                        className="grid h-7 w-7 place-items-center rounded-md text-ff-muted transition hover:bg-ff-surface-2 hover:text-ff-ink-2 disabled:opacity-30"
                      >
                        <ChevronUp size={16} />
                      </button>
                      <button
                        onClick={() => move(li, i, 1)}
                        disabled={i === byLeg[li].length - 1}
                        title="Надолу"
                        className="grid h-7 w-7 place-items-center rounded-md text-ff-muted transition hover:bg-ff-surface-2 hover:text-ff-ink-2 disabled:opacity-30"
                      >
                        <ChevronDown size={16} />
                      </button>
                    </span>
                  </div>
                );
              })}
              {/* Tail drop zone: lets a dragged row land at the END of this leg
                  (incl. an emptied one) — rows alone offer no slot after the
                  last one. Rendered only mid-drag so it costs no height. */}
              {multi && drag && (
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (over?.leg !== li || over?.idx !== byLeg[li].length)
                      setOver({ leg: li, idx: byLeg[li].length });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (drag) transfer(drag, li);
                    endDrag();
                  }}
                  className={cn(
                    'mx-4 my-1 rounded-lg border border-dashed border-ff-border px-3 py-1.5 text-center text-[12px] text-ff-muted',
                    over?.leg === li &&
                      over?.idx === byLeg[li].length &&
                      'border-ff-green-400 bg-ff-green-50 text-ff-green-800',
                  )}
                >
                  Пусни тук — в края на {l.label}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-ff-border px-5 py-4">
          {confirmReset ? (
            <span className="flex items-center gap-2 text-[13px]">
              <span className="font-bold text-ff-ink-2">Изчисти всички ръчни премествания?</span>
              <button onClick={onRebalance} className="font-extrabold text-ff-amber-600 hover:underline">
                Да
              </button>
              <button
                onClick={() => setConfirmReset(false)}
                className="font-bold text-ff-muted hover:text-ff-ink"
              >
                Не
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmReset(true)}
              title="Изчисти ръчния ред и закачените куриери — маршрутът се разпределя наново по география"
              className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ff-ink-2 hover:text-ff-ink"
            >
              <RotateCcw size={15} /> Авто-разпределение
            </button>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Отказ
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onSave(legs.map((l, li) => ({ legIndex: l.legIndex, ids: byLeg[li] })))}
            >
              Запази реда
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
