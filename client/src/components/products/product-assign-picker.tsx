'use client';

import { useMemo, useState } from 'react';
import { Search, Check } from 'lucide-react';
import type { ProductOption } from '@/lib/types';

/**
 * Searchable, checkboxed product list for bulk-linking products to a farmer or a
 * subcategory from its drawer. Controlled: the parent owns the `checked` set and
 * persists the diff on save. A product already linked to a *different* owner shows
 * a "свързан другаде" hint — checking it moves it here.
 */
export function ProductAssignPicker({
  products,
  checked,
  onToggle,
  ownerId,
  field,
}: {
  products: ProductOption[];
  checked: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  ownerId: string;
  field: 'farmerId' | 'subcategoryId';
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? products.filter((p) => p.name.toLowerCase().includes(s)) : products;
  }, [q, products]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-bold text-ff-ink-2">Свързани продукти</span>
        <span className="text-[12px] font-extrabold text-ff-green-700">{checked.size}</span>
      </div>

      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ff-muted-2" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Търси продукт…"
          className="w-full rounded-sm border border-ff-border bg-ff-surface-2 py-2 pl-8 pr-3 text-[13.5px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500"
        />
      </div>

      <div className="max-h-[240px] divide-y divide-ff-border-2 overflow-y-auto rounded-lg border border-ff-border-2">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12.5px] text-ff-muted">Няма продукти</div>
        ) : (
          filtered.map((p) => {
            const on = checked.has(p.id);
            const elsewhere = !on && p[field] != null && p[field] !== ownerId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onToggle(p.id, !on)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-ff-green-50"
              >
                <span
                  className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded border ${
                    on ? 'border-ff-green-600 bg-ff-green-600 text-white' : 'border-ff-border bg-ff-surface'
                  }`}
                >
                  {on && <Check size={13} strokeWidth={3} />}
                </span>
                <span className="flex-1 truncate text-[13.5px] font-semibold text-ff-ink">{p.name}</span>
                {elsewhere && <span className="shrink-0 text-[11px] font-bold text-ff-muted-2">свързан другаде</span>}
              </button>
            );
          })
        )}
      </div>

      <p className="text-[11.5px] text-ff-muted-2">
        Отметни продуктите за този профил. „Свързан другаде“ ще се премести тук при запазване.
      </p>
    </div>
  );
}
