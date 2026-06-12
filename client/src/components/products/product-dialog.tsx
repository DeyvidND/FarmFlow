'use client';

import { useRef, useState } from 'react';
import { ImagePlus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MediaManager } from '@/components/media/media-manager';
import { CoverCropEditor } from '@/components/media/cover-crop-editor';
import { ApiError } from '@/lib/api-client';
import type { CoverCrop, Farmer, Product, Subcategory } from '@/lib/types';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

/**
 * Create + edit a product. In edit mode (`product` set) it also exposes the
 * farmer / subcategory link selects (when the matching tenant toggle is on).
 */
export function ProductDialog({
  open,
  product,
  farmers,
  subcats,
  multiFarmer,
  multiSubcat,
  onClose,
  onSubmit,
  onCoverChange,
}: {
  open: boolean;
  product?: Product | null;
  farmers: Farmer[];
  subcats: Subcategory[];
  multiFarmer: boolean;
  multiSubcat: boolean;
  onClose: () => void;
  onSubmit: (data: Partial<Product>, files?: File[]) => Promise<void>;
  /** Edit mode only: fired when the gallery cover (photo 0) changes. */
  onCoverChange?: (url: string | null) => void;
}) {
  const isEdit = !!product;
  const [name, setName] = useState(product?.name ?? '');
  const [price, setPrice] = useState(product ? (product.priceStotinki / 100).toFixed(2).replace('.', ',') : '');
  const [stock, setStock] = useState(product?.stockQuantity == null ? '' : String(product.stockQuantity));
  const [unit, setUnit] = useState(product?.unit ?? 'бр');
  const [weight, setWeight] = useState(product?.weight ?? '');
  const [farmerId, setFarmerId] = useState(product?.farmerId ?? farmers[0]?.id ?? '');
  const [subcatId, setSubcatId] = useState(product?.subcategoryId ?? subcats[0]?.id ?? '');
  const [imageUrl, setImageUrl] = useState(product?.imageUrl ?? null);
  const [coverCrop, setCoverCrop] = useState<CoverCrop | null>(product?.coverCrop ?? null);
  // Create mode: no product id yet to attach photos to, so buffer the picked files
  // locally (with object-URL previews) and upload them right after the product is
  // created. Edit mode uses the server-backed MediaManager instead.
  const [pending, setPending] = useState<{ file: File; url: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  function addPending(files: FileList | null) {
    if (!files?.length) return;
    setPending((prev) => [...prev, ...Array.from(files).map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  }

  function removePending(i: number) {
    setPending((prev) => {
      URL.revokeObjectURL(prev[i]?.url);
      return prev.filter((_, j) => j !== i);
    });
  }

  // The gallery cover changed (photo 0 added/removed/reordered). Sync the local
  // preview and invalidate the saved framing — a new photo needs re-framing.
  function onCover(url: string | null) {
    setImageUrl(url);
    setCoverCrop(null);
    onCoverChange?.(url);
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
      await onSubmit(
        {
          name: name.trim(),
          priceStotinki,
          unit: unit.trim() || 'бр',
          weight: weight.trim() || undefined,
          // Empty = unlimited stock → send null explicitly (the column defaults to 0
          // = out of stock, which would contradict the "неограничено" placeholder).
          stockQuantity: stock === '' ? null : parseInt(stock, 10) || 0,
          ...(isEdit ? { coverCrop } : { isActive: true }),
          ...(multiFarmer ? { farmerId: farmerId || null } : {}),
          ...(multiSubcat ? { subcategoryId: subcatId || null } : {}),
        },
        isEdit ? undefined : pending.map((p) => p.file),
      );
      onClose();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Неуспешно записване');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="animate-ff-pop max-h-[92vh] w-[440px] max-w-full overflow-y-auto rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[18px] font-extrabold">{isEdit ? 'Редакция на продукт' : 'Нов продукт'}</h2>
          <button onClick={onClose} aria-label="Затвори" className="grid h-8 w-8 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          {isEdit && product && (
            <MediaManager resource="products" ownerId={product.id} onCoverChange={onCover} />
          )}

          {isEdit && imageUrl && (
            // The storefront card shape depends on the shop's layout — most are wide
            // (4:3), some square (1:1) or tall (4:5). Let the farmer preview the
            // framing in each shape so the focal point looks right whichever is used.
            <CoverCropEditor
              imageUrl={imageUrl}
              value={coverCrop}
              aspect={4 / 3}
              aspects={[
                { label: 'Широка', value: 4 / 3, shape: 'wide' as const },
                { label: 'Квадрат', value: 1, shape: 'square' as const },
                { label: 'Висока', value: 4 / 5, shape: 'tall' as const },
              ]}
              onChange={setCoverCrop}
            />
          )}

          {!isEdit && (
            <div className="flex flex-col gap-2">
              <div className="text-[12.5px] font-bold text-ff-ink-2">Снимки {pending.length ? `(${pending.length})` : ''}</div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
                {pending.map((p, i) => (
                  <div key={p.url} className="group relative aspect-square overflow-hidden rounded-lg border border-ff-border bg-ff-surface-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt="" className="h-full w-full object-cover" />
                    {i === 0 && (
                      <span className="absolute left-1 top-1 rounded bg-ff-green-600/90 px-1.5 py-0.5 text-[9.5px] font-bold text-white">Корица</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removePending(i)}
                      aria-label="Премахни снимка"
                      className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded bg-white/85 text-ff-red opacity-0 transition group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="grid aspect-square place-items-center rounded-lg border border-dashed border-ff-border-2 bg-ff-surface-2 text-ff-muted transition hover:border-ff-green-500 hover:text-ff-ink"
                >
                  <span className="inline-flex flex-col items-center gap-1 text-[10.5px] font-semibold">
                    <ImagePlus size={18} /> Добави
                  </span>
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                hidden
                onChange={(e) => {
                  addPending(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
          )}

          <label className={labelCls}>
            Име
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ягоди" className={field} autoFocus={!isEdit} />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Тегло
              <input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="500 г" className={field} />
            </label>
            <label className={labelCls}>
              Единица
              <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="бр" className={field} />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Цена (€)
              <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="6,50" className={field} />
            </label>
            <label className={labelCls}>
              Наличност (бр.)
              <input value={stock} onChange={(e) => setStock(e.target.value)} inputMode="numeric" placeholder="неогранич." className={field} />
              <span className="text-[10.5px] font-semibold text-ff-muted-2">празно = без лимит</span>
            </label>
          </div>

          {multiFarmer && farmers.length > 0 && (
            <label className={labelCls}>
              Фермер
              <select value={farmerId} onChange={(e) => setFarmerId(e.target.value)} className={`${field} cursor-pointer appearance-none`}>
                {farmers.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                    {f.role ? ` — ${f.role}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          {multiSubcat && subcats.length > 0 && (
            <label className={labelCls}>
              Категория
              <select value={subcatId} onChange={(e) => setSubcatId(e.target.value)} className={`${field} cursor-pointer appearance-none`}>
                {subcats.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {err && <p className="text-[13px] font-semibold text-ff-red">{err}</p>}

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={onClose} className="rounded-sm">
              Отказ
            </Button>
            <Button variant="primary" type="submit" disabled={loading} className="rounded-sm">
              {loading ? 'Запазване…' : isEdit ? 'Запази' : 'Създай'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
