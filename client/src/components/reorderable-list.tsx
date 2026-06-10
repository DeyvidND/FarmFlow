'use client';

import { useState, type ReactNode } from 'react';
import { GripVertical, ChevronUp, ChevronDown } from 'lucide-react';

export interface ReorderableListProps<T> {
  items: T[];
  getId: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** Called with the full id list in its new order after any move. */
  onReorder: (orderedIds: string[]) => void;
  className?: string;
}

/**
 * Controlled reorder list with BOTH interaction styles: drag-and-drop (desktop)
 * and up/down arrow buttons (mobile / keyboard). It owns no order state — it
 * renders `items` as given and emits the new id order; the parent reorders its
 * own list (optimistically) and feeds it back. Works for any row content.
 */
export function ReorderableList<T>({
  items,
  getId,
  renderItem,
  onReorder,
  className,
}: ReorderableListProps<T>) {
  const [dragId, setDragId] = useState<string | null>(null);
  const ids = items.map(getId);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...ids];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    onReorder(next);
  };

  const btn =
    'grid h-5 w-6 place-items-center text-ff-muted transition-colors hover:text-ff-ink disabled:cursor-not-allowed disabled:opacity-30';

  return (
    <ul className={className ?? 'flex flex-col gap-2'}>
      {items.map((item, i) => {
        const id = getId(item);
        return (
          <li
            key={id}
            draggable
            onDragStart={() => setDragId(id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId == null) return;
              const from = ids.indexOf(dragId);
              if (from !== -1) move(from, i);
              setDragId(null);
            }}
            className={`flex items-center gap-2.5 rounded-xl border border-ff-border bg-ff-surface p-2.5 shadow-ff-sm transition-opacity ${
              dragId === id ? 'opacity-50' : ''
            }`}
          >
            <span className="cursor-grab text-ff-muted active:cursor-grabbing" aria-hidden>
              <GripVertical size={18} />
            </span>
            <div className="min-w-0 flex-1">{renderItem(item, i)}</div>
            <div className="flex flex-col">
              <button
                type="button"
                aria-label="Премести нагоре"
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
                className={btn}
              >
                <ChevronUp size={16} />
              </button>
              <button
                type="button"
                aria-label="Премести надолу"
                disabled={i === items.length - 1}
                onClick={() => move(i, i + 1)}
                className={btn}
              >
                <ChevronDown size={16} />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
