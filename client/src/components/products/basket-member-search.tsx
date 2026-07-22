'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { ProductOption } from '@/lib/types';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';

function labelOf(o: ProductOption, farmerNameById?: Map<string, string>): string {
  const owner = farmerNameById && o.farmerId ? farmerNameById.get(o.farmerId) : undefined;
  return `${o.name}${o.weight ? ` (${o.weight})` : ''}${owner ? ` — ${owner}` : ''}`;
}

/**
 * Search-to-pick replacement for a plain `<select>` of basket-member candidates.
 * A tenant with many products (a co-op catalog easily runs 15-20+) made the
 * native dropdown a scroll-and-squint exercise with no way to type a name.
 *
 * Single-select: typing filters the list; picking a row sets `value` and
 * collapses back to showing that product's label, like `ProductAssignPicker`'s
 * search box but for a single choice instead of a checked set. The parent still
 * owns `value` — clearing it externally (e.g. after "Добави" resets the pick)
 * clears the input's text too.
 */
export function BasketMemberSearch({
  options,
  value,
  onChange,
  farmerNameById,
}: {
  options: ProductOption[];
  value: string;
  onChange: (id: string) => void;
  /** Pass only when the tenant has multiple farmers — shows „ — <owner>" per row. */
  farmerNameById?: Map<string, string>;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // External reset (parent clears `value` after adding the pick) clears the text too.
  useEffect(() => {
    if (value === '') setQuery('');
  }, [value]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? options.filter((o) => labelOf(o, farmerNameById).toLowerCase().includes(q)) : options),
    [q, options, farmerNameById],
  );

  function pick(o: ProductOption) {
    onChange(o.id);
    setQuery(labelOf(o, farmerNameById));
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = filtered[activeIndex];
      if (o) pick(o);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ff-muted-2" />
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={listId}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
          setOpen(true);
          if (value) onChange(''); // typing again invalidates the previous pick
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder="Търси продукт…"
        className={`${field} w-full pl-8`}
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-[220px] overflow-y-auto rounded-lg border border-ff-border-2 bg-ff-surface shadow-ff-lg"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-center text-[12.5px] text-ff-muted">Няма съвпадения</div>
          ) : (
            filtered.map((o, i) => (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={o.id === value}
                // Fires before the input's onBlur closes the list — a plain
                // onClick would never run, since blur already hid the dropdown.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
                className={`block w-full truncate px-3 py-2 text-left text-[13.5px] font-semibold text-ff-ink ${
                  i === activeIndex ? 'bg-ff-green-50' : 'hover:bg-ff-surface-2'
                }`}
              >
                {labelOf(o, farmerNameById)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
