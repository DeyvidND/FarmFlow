'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { ApiError, createBulkAvailabilityWindows } from '@/lib/api-client';
import type { PickerProduct } from '@/app/(admin)/availability/page';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500 mt-1 w-full';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

/** «Задай за всички» — one quantity applied to many products at once. Pick a
 *  quantity, tick the products, save: the server sets the stock per ticked
 *  product and skips any that already have stock. */
export function BulkWindowEditor({
  products,
  onClose,
  onSaved,
}: {
  products: PickerProduct[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [quantity, setQuantity] = React.useState('');
  // Default: every product selected — the common case is "same stock for all".
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(products.map((p) => p.id)),
  );
  const [saving, setSaving] = React.useState(false);

  const allOn = selected.size === products.length && products.length > 0;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected(allOn ? new Set() : new Set(products.map((p) => p.id)));

  const save = async () => {
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) {
      toast.error('Въведи количество (поне 1)');
      return;
    }
    if (selected.size === 0) {
      toast.error('Избери поне един продукт');
      return;
    }
    setSaving(true);
    try {
      const res = await createBulkAvailabilityWindows({
        productIds: [...selected],
        quantity: qty,
      });
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
          Въведи количество, после маркирай продуктите. Едно и също количество се
          задава наведнъж за всички избрани.
        </p>

        <label className={labelCls}>
          Количество за всеки продукт (бр.)
          <input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            inputMode="numeric"
            placeholder="напр. 20"
            className={field}
          />
        </label>

        <div className="mt-4 flex items-center justify-between">
          <span className="text-[12.5px] font-bold text-ff-ink-2">
            Продукти ({selected.size}/{products.length})
          </span>
          <button
            type="button"
            onClick={toggleAll}
            className="text-[12.5px] font-bold text-ff-green-700 hover:underline"
          >
            {allOn ? 'Изчисти всички' : 'Избери всички'}
          </button>
        </div>
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto rounded-xl border border-ff-border bg-ff-surface-2 p-2">
          {products.length === 0 ? (
            <p className="px-1 py-2 text-[13px] text-ff-muted-2">Няма активни продукти.</p>
          ) : (
            products.map((p) => (
              <label
                key={p.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px] font-semibold text-ff-ink-2 hover:bg-ff-surface"
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="h-4 w-4 accent-ff-green-600"
                />
                {[p.name, p.weight].filter(Boolean).join(' ')}
              </label>
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
