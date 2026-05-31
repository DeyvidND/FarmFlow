'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import type { Product } from '@/lib/types';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export function CreateProductDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (data: Partial<Product>) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const [unit, setUnit] = useState('бр');
  const [weight, setWeight] = useState('');
  const [category, setCategory] = useState('');
  const [tint, setTint] = useState('#4C8A54');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  function close() {
    setName('');
    setPrice('');
    setStock('');
    setUnit('бр');
    setWeight('');
    setCategory('');
    setTint('#4C8A54');
    setErr('');
    onClose();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    const priceStotinki = Math.round((parseFloat(price.replace(',', '.')) || 0) * 100);
    if (!name.trim()) {
      setErr('Въведи име');
      return;
    }
    if (priceStotinki <= 0) {
      setErr('Въведи валидна цена');
      return;
    }
    setLoading(true);
    try {
      await onCreate({
        name: name.trim(),
        priceStotinki,
        unit: unit.trim() || 'бр',
        weight: weight.trim() || undefined,
        category: category.trim() || undefined,
        tint,
        stockQuantity: stock === '' ? undefined : parseInt(stock, 10) || 0,
        isActive: true,
      });
      close();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Неуспешно създаване');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={close}>
      <div
        className="animate-ff-pop w-[440px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[18px] font-extrabold">Нов продукт</h2>
          <button onClick={close} aria-label="Затвори" className="grid h-8 w-8 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className={labelCls}>
            Име
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ягоди" className={field} autoFocus />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Тегло
              <input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="500 г" className={field} />
            </label>
            <label className={labelCls}>
              Категория
              <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Плодове" className={field} />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Цена (лв)
              <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="6,50" className={field} />
            </label>
            <label className={labelCls}>
              Наличност (бр.)
              <input value={stock} onChange={(e) => setStock(e.target.value)} inputMode="numeric" placeholder="неогранич." className={field} />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Единица
              <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="бр" className={field} />
            </label>
            <label className={labelCls}>
              Цвят
              <input
                type="color"
                value={tint}
                onChange={(e) => setTint(e.target.value)}
                className="h-[42px] w-full cursor-pointer rounded-sm border border-ff-border bg-ff-surface-2 px-1"
              />
            </label>
          </div>

          {err && <p className="text-[13px] font-semibold text-ff-red">{err}</p>}

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={close} className="rounded-sm">
              Отказ
            </Button>
            <Button variant="primary" type="submit" disabled={loading} className="rounded-sm">
              {loading ? 'Запазване…' : 'Създай'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
