'use client';

import * as React from 'react';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, createBulkAvailabilityWindows } from '@/lib/api-client';
import type { PickerProduct } from '@/app/(admin)/availability/page';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const digits = (v: string) => v.replace(/[^0-9]/g, '');

/** «Задай за всички» — set stock per product in one pass. Every product has its
 *  own quantity field; the top helper fills them all with the same number for the
 *  common "same stock for all" case, after which each can still be tweaked.
 *  Saving sends only products with a quantity ≥ 1; the server skips products that
 *  already have stock or aren't owned by the caller. */
export function BulkWindowEditor({
  products,
  onClose,
  onSaved,
}: {
  products: PickerProduct[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [qty, setQty] = React.useState<Record<string, string>>({});
  const [fillAll, setFillAll] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [search, setSearch] = React.useState('');

  const q = search.trim().toLowerCase();
  const visibleProducts = q
    ? products.filter((p) => [p.name, p.weight].filter(Boolean).join(' ').toLowerCase().includes(q))
    : products;

  const setOne = (id: string, v: string) => setQty((prev) => ({ ...prev, [id]: digits(v) }));
  const applyFill = () => {
    const v = digits(fillAll);
    if (!v) {
      toast.error('Въведи число за попълване');
      return;
    }
    setQty(Object.fromEntries(products.map((p) => [p.id, v])));
  };
  const clearAll = () => setQty({});

  // Products with a valid quantity → the payload; also drives the counter.
  const items = products
    .map((p) => ({ productId: p.id, quantity: parseInt(qty[p.id] ?? '', 10) }))
    .filter((it) => Number.isInteger(it.quantity) && it.quantity >= 1);

  const save = async () => {
    if (!items.length) {
      toast.error('Въведи количество за поне един продукт');
      return;
    }
    setSaving(true);
    try {
      const res = await createBulkAvailabilityWindows({ items });
      if (res.created.length) {
        toast.success(`Зададена наличност за ${res.created.length} продукта`);
      }
      const overlaps = res.skipped.filter((s) => s.reason === 'overlap').length;
      if (overlaps) {
        toast(`${overlaps} продукта вече имат наличност — прескочени`);
      }
      if (!res.created.length && !overlaps) {
        toast.error('Нищо не бе зададено');
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-md flex-col rounded-2xl bg-ff-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 font-display text-lg font-bold text-ff-ink">Задай за всички</h2>
        <p className="mb-4 text-[13px] text-ff-ink-2">
          Въведи количество за всеки продукт. Празно поле = продуктът се пропуска. За
          еднакво количество ползвай „Попълни всички“.
        </p>

        {/* Convenience: fill every product field with the same number. */}
        <div className="flex items-end gap-2">
          <label className="flex flex-1 flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2">
            Попълни всички с (бр.)
            <input
              value={fillAll}
              onChange={(e) => setFillAll(digits(e.target.value))}
              inputMode="numeric"
              placeholder="напр. 20"
              className={`${field} w-full`}
            />
          </label>
          <button
            type="button"
            onClick={applyFill}
            className="mb-0.5 shrink-0 rounded-lg border border-ff-border px-3 py-2.5 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
          >
            Попълни
          </button>
        </div>

        <label className="relative mt-4">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ff-muted-2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Търси продукт…"
            className={`${field} w-full pl-9`}
          />
        </label>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-[12.5px] font-bold text-ff-ink-2">
            Продукти ({items.length}/{products.length} с количество)
          </span>
          <button
            type="button"
            onClick={clearAll}
            className="text-[12.5px] font-bold text-ff-green-700 hover:underline"
          >
            Изчисти всички
          </button>
        </div>
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto rounded-xl border border-ff-border bg-ff-surface-2 p-2">
          {products.length === 0 ? (
            <p className="px-1 py-2 text-[13px] text-ff-muted-2">Няма активни продукти.</p>
          ) : visibleProducts.length === 0 ? (
            <p className="px-1 py-2 text-[13px] text-ff-muted-2">Няма продукти, отговарящи на търсенето.</p>
          ) : (
            visibleProducts.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-ff-surface"
              >
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ff-ink-2">
                  {[p.name, p.weight].filter(Boolean).join(' ')}
                </span>
                <input
                  value={qty[p.id] ?? ''}
                  onChange={(e) => setOne(p.id, e.target.value)}
                  inputMode="numeric"
                  placeholder="бр."
                  aria-label={`Количество за ${p.name}`}
                  className={`${field} w-20 shrink-0 py-1.5 text-center`}
                />
              </div>
            ))
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-semibold text-ff-ink-2 hover:bg-ff-surface-2"
          >
            Отказ
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-ff-green-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
          >
            {saving ? 'Запазвам…' : 'Задай за избраните'}
          </button>
        </div>
      </div>
    </div>
  );
}
