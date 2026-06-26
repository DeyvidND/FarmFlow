'use client';

import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible } from '@/components/delivery/ui';
import { MediaManager } from '@/components/media/media-manager';
import { CoverCropEditor } from '@/components/media/cover-crop-editor';
import { ApiError, listAvailabilityWindows, listProductVariants, type ProductWrite, type VariantWrite } from '@/lib/api-client';
import type { CoverCrop, Farmer, Product, Subcategory } from '@/lib/types';
import { moneyFromStotinki } from '@/lib/utils';

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
  onSubmit: (data: ProductWrite, files?: File[]) => Promise<void>;
  /** Edit mode only: fired when the gallery cover (photo 0) changes. */
  onCoverChange?: (url: string | null) => void;
}) {
  const isEdit = !!product;
  const [name, setName] = useState(product?.name ?? '');
  const [price, setPrice] = useState(product ? (product.priceStotinki / 100).toFixed(2).replace('.', ',') : '');
  const [unit, setUnit] = useState(product?.unit ?? 'бр');
  const [weight, setWeight] = useState(product?.weight ?? '');
  // Stock = the product's availability-window quantity (digits only; '' = unlimited).
  // On edit we load the existing window so the field shows what „Задай наличност"
  // would — the two screens edit the same number, never desync.
  const [stock, setStock] = useState('');
  const [farmerId, setFarmerId] = useState(product?.farmerId ?? farmers[0]?.id ?? '');
  const [subcatId, setSubcatId] = useState(product?.subcategoryId ?? subcats[0]?.id ?? '');
  const [imageUrl, setImageUrl] = useState(product?.imageUrl ?? null);
  const [coverCrop, setCoverCrop] = useState<CoverCrop | null>(product?.coverCrop ?? null);
  // Variants (вид/грамаж): one product, several priced rows. Prices kept as
  // comma-strings like the main price; stock '' = unlimited.
  type VRow = { id?: string; label: string; price: string; stock: string };
  const [hasVariants, setHasVariants] = useState(false);
  const [variants, setVariants] = useState<VRow[]>([]);
  // Promotion: percent off + optional end date (date input wants YYYY-MM-DD).
  const [salePercent, setSalePercent] = useState(product?.salePercent ? String(product.salePercent) : '');
  const [saleEndsAt, setSaleEndsAt] = useState(product?.saleEndsAt ? product.saleEndsAt.slice(0, 10) : '');
  // Create mode: no product id yet to attach photos to, so buffer the picked files
  // locally (with object-URL previews) and upload them right after the product is
  // created. Edit mode uses the server-backed MediaManager instead.
  const [pending, setPending] = useState<{ file: File; url: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  // Edit mode: load the product's current stock (its availability-window quantity)
  // so the field is pre-filled. One window per product → windows[0] is it.
  useEffect(() => {
    if (!isEdit || !product) return;
    let alive = true;
    listAvailabilityWindows(product.id)
      .then((windows) => {
        if (alive) setStock(windows[0] ? String(windows[0].quantity) : '');
      })
      .catch(() => {
        /* stock prefill is best-effort — leave the field empty on failure */
      });
    return () => {
      alive = false;
    };
  }, [isEdit, product]);

  // Edit mode: load existing variants so the section pre-fills and opens.
  useEffect(() => {
    if (!isEdit || !product) return;
    let alive = true;
    listProductVariants(product.id)
      .then((rows) => {
        if (!alive) return;
        if (rows.length) {
          setHasVariants(true);
          setVariants(
            rows.map((v) => ({
              id: v.id,
              label: v.label,
              price: (v.priceStotinki / 100).toFixed(2).replace('.', ','),
              stock: v.stockQuantity == null ? '' : String(v.stockQuantity),
            })),
          );
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isEdit, product]);

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
    if (!hasVariants && priceStotinki <= 0) {
      setErr('Въведи валидна цена');
      return;
    }
    // Variants → write payload (parse comma prices to stotinki; empty stock = unlimited).
    let variantPayload: VariantWrite[] | undefined;
    if (hasVariants) {
      const cleaned = variants.filter((v) => v.label.trim());
      if (!cleaned.length) {
        setErr('Добави поне един вариант или изключи вариантите');
        return;
      }
      variantPayload = cleaned.map((v) => ({
        ...(v.id ? { id: v.id } : {}),
        label: v.label.trim(),
        priceStotinki: Math.round((parseFloat(v.price.replace(',', '.')) || 0) * 100),
        stockQuantity: v.stock.trim() === '' ? null : parseInt(v.stock, 10),
      }));
      if (variantPayload.some((v) => v.priceStotinki <= 0)) {
        setErr('Всеки вариант трябва да има валидна цена');
        return;
      }
    } else {
      variantPayload = []; // explicit empty = remove any existing variants
    }
    const pct = salePercent.trim() === '' ? null : parseInt(salePercent, 10);
    const promoEnd = saleEndsAt.trim() === '' ? null : new Date(saleEndsAt).toISOString();
    const effectivePrice = hasVariants && variantPayload && variantPayload.length
      ? Math.min(...variantPayload.map((v) => v.priceStotinki))
      : priceStotinki;
    // Stock is digit-filtered on input. Empty → null clears the window (unlimited);
    // a number upserts it. Sent on create too (null is a harmless no-op there).
    const stockValue: number | null = stock.trim() === '' ? null : parseInt(stock, 10);
    setLoading(true);
    try {
      await onSubmit(
        {
          name: name.trim(),
          priceStotinki: effectivePrice,
          unit: unit.trim() || 'бр',
          weight: weight.trim() || undefined,
          stock: stockValue,
          salePercent: pct,
          saleEndsAt: promoEnd,
          variants: variantPayload,
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

          {!hasVariants && (
            <label className={labelCls}>
              Цена (€)
              <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="6,50" className={field} />
            </label>
          )}

          {!hasVariants && (
            <label className={labelCls}>
              Наличност
              <input
                value={stock}
                onChange={(e) => setStock(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                placeholder="напр. 20"
                className={field}
              />
              <span className="text-[11.5px] font-normal text-ff-muted">
                Остави празно = неограничено · винаги налично. Намалява при всяка поръчка.
              </span>
            </label>
          )}

          {!hasVariants && (
            <a href="/availability" className="-mt-1 text-[12px] font-semibold text-ff-green-700 hover:underline">
              Задай наличност на много продукти наведнъж →
            </a>
          )}

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

          <Collapsible
            title="Варианти (вид/грамаж)"
            hint="Един продукт с няколко цени — напр. мед: кристализиран/течен, или мляко в 3 разфасовки. Една снимка, отделна цена и наличност за всеки."
            defaultOpen={hasVariants}
          >
            <label className="flex items-center gap-2 text-[13px] font-semibold text-ff-ink">
              <input type="checkbox" checked={hasVariants} onChange={(e) => setHasVariants(e.target.checked)} />
              Този продукт има варианти
            </label>
            {hasVariants && (
              <div className="mt-3 flex flex-col gap-2">
                {variants.map((v, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      value={v.label}
                      onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))}
                      placeholder="Кристализиран 500 г"
                      className={`${field} flex-[2]`}
                    />
                    <input
                      value={v.price}
                      onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)))}
                      inputMode="decimal"
                      placeholder="6,50 €"
                      className={`${field} flex-1`}
                    />
                    <input
                      value={v.stock}
                      onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, stock: e.target.value.replace(/[^0-9]/g, '') } : r)))}
                      inputMode="numeric"
                      placeholder="бр"
                      className={`${field} w-16`}
                    />
                    <button
                      type="button"
                      onClick={() => setVariants((p) => p.filter((_, j) => j !== i))}
                      aria-label="Премахни вариант"
                      className="grid w-9 shrink-0 place-items-center rounded-sm text-ff-red hover:bg-ff-surface-2"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setVariants((p) => [...p, { label: '', price: '', stock: '' }])}
                  className="inline-flex items-center gap-1.5 self-start text-[12.5px] font-semibold text-ff-green-700 hover:underline"
                >
                  <Plus size={14} /> Добави вариант
                </button>
                <span className="text-[11.5px] text-ff-muted">Наличност празна = неограничено. Цената на продукта става най-евтиния вариант.</span>
              </div>
            )}
          </Collapsible>

          <Collapsible
            title="Промоция"
            hint="Намали цената с процент за определен срок. След срока промоцията пада автоматично. Без срок — маха се ръчно."
            defaultOpen={!!product?.salePercent}
          >
            <div className="grid grid-cols-2 gap-3">
              <label className={labelCls}>
                Отстъпка (%)
                <input
                  value={salePercent}
                  onChange={(e) => setSalePercent(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
                  inputMode="numeric"
                  placeholder="напр. 20"
                  className={field}
                />
              </label>
              <label className={labelCls}>
                Край (по избор)
                <input type="date" value={saleEndsAt} onChange={(e) => setSaleEndsAt(e.target.value)} className={field} />
              </label>
            </div>
            {(() => {
              const pct = parseInt(salePercent, 10);
              const base = Math.round((parseFloat(price.replace(',', '.')) || 0) * 100);
              if (!pct || pct < 1 || pct > 99 || base <= 0) return null;
              const sale = Math.round((base * (100 - pct)) / 100);
              return (
                <p className="mt-2 text-[12.5px] text-ff-muted">
                  Преглед: <span className="line-through">{moneyFromStotinki(base)}</span>{' '}
                  <span className="font-bold text-ff-green-700">{moneyFromStotinki(sale)}</span>
                  {hasVariants ? ' · важи за всеки вариант' : ''}
                </p>
              );
            })()}
          </Collapsible>

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
