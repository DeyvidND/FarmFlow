'use client';

import { useState } from 'react';
import { X, GripVertical, ChevronUp, ChevronDown, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { RouteStop } from '@/lib/types';
import { moveInOrder, dragInOrder } from './route-order';

/**
 * Compact drag/reorder modal for a courier's delivery sequence. The full stop
 * cards in the side list are tall (address + phone + email + products), so
 * reordering there means a lot of scrolling. This modal shows one dense line
 * per stop — position · name · address — so a whole day fits with little or no
 * scroll and can be reordered fast, by drag or ↑↓. Nothing is applied until
 * „Запази"; „Отказ" discards the draft.
 */
export function ReorderStopsModal({
  stops,
  dateLabel,
  isManual,
  onSave,
  onReset,
  onClose,
}: {
  /** Current stops in their present (auto or manual) order. */
  stops: RouteStop[];
  dateLabel: string;
  /** Whether a manual order is already in effect (shows the reset action). */
  isManual: boolean;
  /** Persist the chosen order (list of stop ids, in sequence). */
  onSave: (orderedIds: string[]) => void;
  /** Drop the manual order — fall back to the auto-optimized sequence. */
  onReset: () => void;
  onClose: () => void;
}) {
  const [ids, setIds] = useState<string[]>(() => stops.map((s) => s.id));
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const byId = new Map(stops.map((s) => [s.id, s]));

  const move = (i: number, dir: -1 | 1) => setIds((cur) => moveInOrder(cur, i, dir));

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
          Плъзни ред или ползвай ↑↓. Промените се прилагат след „Запази“.
        </p>

        <div className="flex-1 overflow-y-auto py-1">
          {ids.map((id, i) => {
            const s = byId.get(id);
            if (!s) return null;
            return (
              <div
                key={id}
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (overIndex !== i) setOverIndex(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex != null && dragIndex !== i)
                    setIds((cur) => dragInOrder(cur, dragIndex, i));
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                className={cn(
                  'flex items-center gap-2 border-b border-ff-border-2 px-4 py-2 last:border-0',
                  overIndex === i && dragIndex !== i && 'bg-ff-green-50 ring-2 ring-inset ring-ff-green-400',
                  dragIndex === i && 'opacity-50',
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
                <span className="flex shrink-0 gap-1">
                  <button
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    title="Нагоре"
                    className="grid h-7 w-7 place-items-center rounded-md text-ff-muted transition hover:bg-ff-surface-2 hover:text-ff-ink-2 disabled:opacity-30"
                  >
                    <ChevronUp size={16} />
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={i === ids.length - 1}
                    title="Надолу"
                    className="grid h-7 w-7 place-items-center rounded-md text-ff-muted transition hover:bg-ff-surface-2 hover:text-ff-ink-2 disabled:opacity-30"
                  >
                    <ChevronDown size={16} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-ff-border px-5 py-4">
          {isManual ? (
            <button
              onClick={onReset}
              title="Върни автоматичния ред (най-малко километри)"
              className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ff-ink-2 hover:text-ff-ink"
            >
              <RotateCcw size={15} /> Върни авто-реда
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Отказ
            </Button>
            <Button variant="primary" size="sm" onClick={() => onSave(ids)}>
              Запази реда
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
