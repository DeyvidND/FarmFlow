'use client';

import { useMemo, useState } from 'react';
import { Search, Check } from 'lucide-react';
import type { ProductOption } from '@/lib/types';

/** A cross-dimension bucket the products can be grouped under: categories when
 *  assigning to a farmer, farmers when assigning to a category. */
export interface PickerGroup {
  id: string;
  label: string;
}

const NONE = ''; // bucket key for products with no group value

/**
 * Searchable, checkboxed product list for bulk-linking products to a farmer or a
 * subcategory from its drawer. Controlled: the parent owns the `checked` set and
 * persists the diff on save. A product already linked to a *different* owner shows
 * a "свързан другаде" hint — checking it moves it here.
 *
 * When `groups` + `groupField` are given, the list is grouped by that *other*
 * dimension (category in the farmer drawer, farmer in the category drawer) and a
 * group is floated to the top as soon as it holds a checked product — so picking
 * one wine surfaces the rest of that category next to it. Grouping is skipped
 * while searching (search is global) and when there's only one bucket.
 */
export function ProductAssignPicker({
  products,
  checked,
  onToggle,
  ownerId,
  field,
  groups,
  groupField,
  groupNoun,
}: {
  products: ProductOption[];
  checked: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  ownerId: string;
  field: 'farmerId' | 'subcategoryId';
  /** The cross-dimension buckets (with labels) to group by. Omit for a flat list. */
  groups?: PickerGroup[];
  /** Which product field maps a product to a group. Must differ from `field`. */
  groupField?: 'farmerId' | 'subcategoryId';
  /** Singular noun for the "no group" bucket, e.g. „категория" / „фермер". */
  groupNoun?: string;
}) {
  const [q, setQ] = useState('');
  const s = q.trim().toLowerCase();
  const filtered = useMemo(
    () => (s ? products.filter((p) => p.name.toLowerCase().includes(s)) : products),
    [s, products],
  );

  const labelOf = useMemo(() => {
    const m = new Map<string, string>();
    (groups ?? []).forEach((g) => m.set(g.id, g.label));
    return m;
  }, [groups]);

  // Bucketed + affinity-sorted view; null when we should fall back to a flat list.
  const grouped = useMemo(() => {
    if (s || !groupField || !groups) return null;

    const buckets = new Map<string, ProductOption[]>();
    for (const p of filtered) {
      const key = (p[groupField] as string | null) ?? NONE;
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(p);
    }
    if (buckets.size < 2) return null; // one bucket → grouping adds nothing

    // Group values that already hold a checked product → these float to the top.
    const affinity = new Set<string>();
    for (const p of filtered) {
      if (checked.has(p.id)) affinity.add((p[groupField] as string | null) ?? NONE);
    }

    // Base order: given groups first, then any extra present buckets, „без …" last.
    const base = [
      ...(groups.map((g) => g.id).filter((id) => buckets.has(id))),
      ...[...buckets.keys()].filter((k) => k !== NONE && !labelOf.has(k)),
      ...(buckets.has(NONE) ? [NONE] : []),
    ];
    const orderedKeys = base
      .map((key, i) => ({ key, i, aff: affinity.has(key) ? 0 : 1 }))
      .sort((a, b) => a.aff - b.aff || a.i - b.i)
      .map((x) => x.key);

    return orderedKeys.map((key) => {
      // Checked rows first within a bucket so the selection stays visible on top.
      const items = [...buckets.get(key)!].sort(
        (a, b) => Number(checked.has(b.id)) - Number(checked.has(a.id)),
      );
      const label = key === NONE ? `Без ${groupNoun ?? 'група'}` : labelOf.get(key) ?? key;
      const selected = items.filter((p) => checked.has(p.id)).length;
      return { key, label, items, selected };
    });
  }, [s, groupField, groups, filtered, checked, labelOf, groupNoun]);

  function row(p: ProductOption) {
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
        {elsewhere && <span className="shrink-0 text-[11px] font-bold text-ff-muted">свързан другаде</span>}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-bold text-ff-ink-2">Избрани продукти</span>
        <span className="text-[12px] font-extrabold text-ff-green-700">{checked.size}</span>
      </div>

      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ff-muted-2" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Търси продукт…"
          className="w-full rounded-sm border border-ff-border bg-ff-surface-2 py-2 pl-8 pr-3 text-[16px] sm:text-[13.5px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500"
        />
      </div>

      <div className="max-h-[240px] overflow-y-auto rounded-lg border border-ff-border-2">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12.5px] text-ff-muted">Няма продукти</div>
        ) : grouped ? (
          grouped.map((g) => (
            <div key={g.key} className="[&:not(:last-child)]:border-b [&:not(:last-child)]:border-ff-border-2">
              <div className="sticky top-0 z-[1] flex items-center justify-between bg-ff-surface-2 px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wide text-ff-muted">
                <span className="truncate">{g.label}</span>
                <span className="shrink-0 pl-2 text-ff-green-700">
                  {g.selected > 0 ? `${g.selected}/${g.items.length}` : g.items.length}
                </span>
              </div>
              <div className="divide-y divide-ff-border-2">{g.items.map(row)}</div>
            </div>
          ))
        ) : (
          <div className="divide-y divide-ff-border-2">{filtered.map(row)}</div>
        )}
      </div>

      <p className="text-[11.5px] text-ff-muted">
        Отметни продуктите за този профил. „Свързан другаде“ ще се премести тук при запазване.
      </p>
    </div>
  );
}
