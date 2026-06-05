'use client';

import { useRef } from 'react';
import { Pencil, Trash2, Link2 } from 'lucide-react';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ProductThumb } from './product-thumb';
import { moneyFromStotinki } from '@/lib/utils';
import { stockMeta } from '@/lib/products';
import type { Product } from '@/lib/types';

interface Props {
  product: Product;
  index: number;
  busy?: boolean;
  onToggle: (on: boolean) => void;
  onUpload: (file: File) => void;
  onDelete: () => void;
  /** Opens the full product editor modal (price, stock, photos, links). */
  onEdit: () => void;
  /** Shown when the farmer/subcategory toggles are on. */
  farmerLabel?: string | null;
  subcatLabel?: string | null;
}

export function ProductCard({
  product,
  index,
  busy,
  onToggle,
  onUpload,
  onDelete,
  onEdit,
  farmerLabel,
  subcatLabel,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const sm = stockMeta(product.stockQuantity);

  return (
    <div
      className="flex flex-col rounded-xl border border-ff-border bg-ff-surface p-3.5 shadow-ff-sm transition-opacity"
      style={{ opacity: product.isActive ? 1 : 0.62, animation: `ff-fade-up .35s ease ${index * 0.03}s both` }}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = '';
        }}
      />
      <ProductThumb imageUrl={product.imageUrl} uploading={busy} onPick={() => fileRef.current?.click()} />

      <div className="mt-[13px] flex items-start justify-between gap-2">
        <div>
          <div className="text-[15.5px] font-extrabold leading-tight">{product.name}</div>
          <div className="mt-0.5 text-[12.5px] text-ff-muted">
            {[product.weight, product.category].filter(Boolean).join(' · ')}
          </div>
        </div>
        <ToggleSwitch small checked={product.isActive} disabled={busy} onChange={onToggle} />
      </div>

      {(farmerLabel !== undefined || subcatLabel !== undefined) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {farmerLabel !== undefined && (
            <span className="inline-flex items-center gap-1 rounded-full border border-ff-border bg-ff-surface-2 px-2 py-0.5 text-[11.5px] font-bold text-ff-ink-2">
              <Link2 size={11} /> {farmerLabel ?? 'Без фермер'}
            </span>
          )}
          {subcatLabel !== undefined && (
            <span className="inline-flex items-center gap-1 rounded-full border border-ff-border bg-ff-surface-2 px-2 py-0.5 text-[11.5px] font-bold text-ff-ink-2">
              {subcatLabel ?? 'Без секция'}
            </span>
          )}
        </div>
      )}

      <div className="mt-3.5 flex items-baseline justify-between">
        <span className="ff-fig text-[22px] font-extrabold tracking-[-0.02em]">
          {moneyFromStotinki(product.priceStotinki)}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <span className="h-[7px] w-[7px] rounded-full" style={{ background: sm.color }} />
        <span className="text-[12.5px] font-bold" style={{ color: sm.color }}>
          {sm.label}
        </span>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={onEdit}
          disabled={busy}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-[9px] border border-ff-border bg-ff-surface-2 px-2 py-2 text-[13px] font-bold text-ff-ink-2 transition-colors hover:bg-ff-green-50 hover:text-ff-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Pencil size={15} /> Редактирай
        </button>
        <button
          onClick={onDelete}
          disabled={busy}
          aria-label="Изтрий"
          title="Изтрий"
          className="grid place-items-center rounded-[9px] border border-ff-border bg-ff-surface-2 px-3 py-2 text-ff-red transition-colors hover:bg-ff-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}
