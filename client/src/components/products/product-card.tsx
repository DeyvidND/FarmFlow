'use client';

import { useRef, useState } from 'react';
import { Pencil, Check, Trash2, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ProductThumb } from './product-thumb';
import { moneyFromStotinki } from '@/lib/utils';
import { stockMeta } from '@/lib/products';
import type { Product } from '@/lib/types';

const editInput =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-[11px] py-2 text-[14.5px] font-bold text-ff-ink outline-none focus:border-ff-green-500';

interface Props {
  product: Product;
  index: number;
  editing: boolean;
  busy?: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onSave: (priceStotinki: number, stockQuantity: number) => void;
  onToggle: (on: boolean) => void;
  onUpload: (file: File) => void;
  onDelete: () => void;
  /** Shown when the farmer/subcategory toggles are on. */
  farmerLabel?: string | null;
  subcatLabel?: string | null;
  /** Opens the full product dialog (relink + full edit); only when linking is enabled. */
  onEditFull?: () => void;
}

export function ProductCard({
  product,
  index,
  editing,
  busy,
  onStartEdit,
  onCancel,
  onSave,
  onToggle,
  onUpload,
  onDelete,
  farmerLabel,
  subcatLabel,
  onEditFull,
}: Props) {
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  function start() {
    setPrice((product.priceStotinki / 100).toFixed(2).replace('.', ','));
    setStock(product.stockQuantity == null ? '' : String(product.stockQuantity));
    onStartEdit();
  }

  function submit() {
    const p = Math.round((parseFloat(price.replace(',', '.')) || 0) * 100);
    const s = parseInt(stock, 10);
    onSave(p, Number.isNaN(s) ? 0 : s);
  }

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

      {editing ? (
        <div className="mt-[13px] flex flex-col gap-[9px]">
          <label className="flex flex-col gap-1 text-[11.5px] font-bold text-ff-muted">
            Цена (лв)
            <input
              autoFocus
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className={editInput}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] font-bold text-ff-muted">
            Наличност (бр.)
            <input
              inputMode="numeric"
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              className={editInput}
            />
          </label>
          <div className="mt-0.5 flex gap-2">
            <Button variant="primary" disabled={busy} onClick={submit} className="flex-1 rounded-sm px-2.5 py-2 text-[13.5px]">
              <Check size={16} /> Запази
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onCancel} className="rounded-sm px-3 py-2 text-[13.5px]">
              Отказ
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={onDelete}
              aria-label="Изтрий"
              className="rounded-sm px-3 py-2 text-[13.5px]"
            >
              <Trash2 size={16} />
            </Button>
          </div>
        </div>
      ) : (
        <>
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
              onClick={start}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-[9px] border border-ff-border bg-ff-surface-2 px-2 py-2 text-[13px] font-bold text-ff-ink-2 transition-colors hover:bg-ff-green-50 hover:text-ff-ink"
            >
              <Pencil size={15} /> Редактирай
            </button>
            {onEditFull && (
              <button
                onClick={onEditFull}
                title="Свържи / пълна редакция"
                className="flex items-center justify-center gap-1.5 rounded-[9px] border border-ff-border bg-ff-surface-2 px-3 py-2 text-[13px] font-bold text-ff-ink-2 transition-colors hover:bg-ff-green-50 hover:text-ff-ink"
              >
                <Link2 size={15} /> Свържи
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
