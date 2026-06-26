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
  const [unit, setUnit] = useState(product?.unit ?? 'бр');
  const [weight, setWeight] = useState(product?.weight ?? '');
  const [farmerId, setFarmerId] = useState(product?.farmerId ?? farmers[0]?.id ?? '');
  const [subcatId, setSubcatId] = useState(product?.subcategoryId ?? subcats[0]?.id ?? '');
  const [imageUrl, setImageUrl] = useState(product?.imageUrl ?? null);
  const [coverCrop, setCoverCrop] = useState<CoverCrop | null>(product?.coverCrop ?? null);
  // Price + stock live in rows: one product is a list of ≥1 priced row. ONE row =
  // a plain product (its price = the product price, its stock = the availability
  // window — same number „Задай наличност" edits, never desync; label optional).
  // TWO+ rows = variants (вид/грамаж), each with its own price + per-variant stock.
  // Prices kept as comma-strings; stock '' = unlimited.
  type VRow = { id?: string; label: string; price: string; stock: string; salePrice: string };
  const [variants, setVariants] = useState<VRow[]>([{ label: '', price: '', stock: '', salePrice: '' }]);
  // Promotion type when there are 2+ rows: 'percent' = one % off all variants;
  // 'fixed' = a per-variant promo price. Mutually exclusive (server enforces too).
  // With 0-1 rows only 'percent' applies.
  const [promoMode, setPromoMode] = useState<'percent' | 'fixed'>(
    product?.salePriceStotinki != null ? 'fixed' : 'percent',
  );
  // Promotion: percent off + optional end date (date input wants YYYY-MM-DD).
  const [salePercent, setSalePercent] = useState(product?.salePercent ? String(product.salePercent) : '');
  const [saleEndsAt, setSaleEndsAt] = useState(product?.saleEndsAt ? product.saleEndsAt.slice(0, 10) : '');
  // Product-level fixed promo price (plain product, 'fixed' mode with one row).
  const [productSalePrice, setProductSalePrice] = useState(
    product?.salePriceStotinki != null ? (product.salePriceStotinki / 100).toFixed(2).replace('.', ',') : '',
  );
  // Create mode: no product id yet to attach photos to, so buffer the picked files
  // locally (with object-URL previews) and upload them right after the product is
  // created. Edit mode uses the server-backed MediaManager instead.
  const [pending, setPending] = useState<{ file: File; url: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  // Edit mode: seed the rows. A varianted product fills its N rows; a plain product
  // seeds exactly one row from its price + the availability-window quantity (the same
  // number „Задай наличност" shows — the two never desync).
  useEffect(() => {
    if (!isEdit || !product) return;
    let alive = true;
    (async () => {
      const [rows, windows] = await Promise.all([
        listProductVariants(product.id).catch(() => []),
        listAvailabilityWindows(product.id).catch(() => []),
      ]);
      if (!alive) return;
      if (rows.length) {
        setVariants(
          rows.map((v) => ({
            id: v.id,
            label: v.label,
            price: (v.priceStotinki / 100).toFixed(2).replace('.', ','),
            stock: v.stockQuantity == null ? '' : String(v.stockQuantity),
            salePrice: v.salePriceStotinki == null ? '' : (v.salePriceStotinki / 100).toFixed(2).replace('.', ','),
          })),
        );
        // Any variant carrying a fixed promo price → the product is in fixed mode.
        if (rows.some((v) => v.salePriceStotinki != null)) setPromoMode('fixed');
      } else {
        setVariants([
          {
            label: '',
            price: (product.priceStotinki / 100).toFixed(2).replace('.', ','),
            stock: windows[0] ? String(windows[0].quantity) : '',
            salePrice: '',
          },
        ]);
      }
    })();
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
    if (!name.trim()) {
      setErr('Въведи име');
      return;
    }
    const parsePriceStotinki = (s: string) => Math.round((parseFloat(s.replace(',', '.')) || 0) * 100);
    // Rows with a real price are the product's price(s). One = a plain product
    // (label optional); two or more = variants.
    const filled = variants.filter((v) => parsePriceStotinki(v.price) > 0);
    if (filled.length === 0) {
      setErr('Въведи цена');
      return;
    }
    const varianted = filled.length >= 2;
    if (varianted && filled.some((v) => !v.label.trim())) {
      setErr('Всеки вариант се нуждае от име (вид/грамаж)');
      return;
    }
    // Fixed-per-variant promo and the product-level % are mutually exclusive; fixed
    // mode only exists with 2+ rows.
    const fixedMode = varianted && promoMode === 'fixed';

    let variantPayload: VariantWrite[];
    let baseStotinki: number;
    // Stock destination: a plain product writes the availability window; a varianted
    // product writes per-variant stock and CLEARS the window (null) so the two stock
    // mechanisms never compete. See „Задай наличност".
    let stockToSet: number | null;
    if (varianted) {
      variantPayload = filled.map((v) => {
        const priceStotinki = parsePriceStotinki(v.price);
        const salePriceStotinki =
          fixedMode && v.salePrice.trim() !== '' ? parsePriceStotinki(v.salePrice) : null;
        return {
          ...(v.id ? { id: v.id } : {}),
          label: v.label.trim(),
          priceStotinki,
          salePriceStotinki,
          stockQuantity: v.stock.trim() === '' ? null : parseInt(v.stock, 10),
        };
      });
      if (variantPayload.some((v) => v.salePriceStotinki != null && v.salePriceStotinki >= v.priceStotinki)) {
        setErr('Промо цената трябва да е под редовната цена на варианта');
        return;
      }
      baseStotinki = Math.min(...variantPayload.map((v) => v.priceStotinki));
      stockToSet = null;
    } else {
      const row = filled[0];
      variantPayload = []; // plain product — remove any existing variants
      baseStotinki = parsePriceStotinki(row.price);
      stockToSet = row.stock.trim() === '' ? null : parseInt(row.stock, 10);
    }

    // A plain product in 'fixed' mode carries a product-level fixed promo price.
    const productSalePriceStotinki =
      !varianted && promoMode === 'fixed' && productSalePrice.trim() !== '' ? parsePriceStotinki(productSalePrice) : null;
    if (productSalePriceStotinki != null && productSalePriceStotinki >= baseStotinki) {
      setErr('Промо цената трябва да е под редовната цена');
      return;
    }
    // % applies only in percent mode; 'fixed' mode (plain or variant) clears it.
    const pct = promoMode === 'fixed' || salePercent.trim() === '' ? null : parseInt(salePercent, 10);
    const promoEnd = promoMode === 'fixed' || saleEndsAt.trim() === '' ? null : new Date(`${saleEndsAt}T23:59:59`).toISOString();
    setLoading(true);
    try {
      await onSubmit(
        {
          name: name.trim(),
          priceStotinki: baseStotinki,
          unit: unit.trim() || 'бр',
          weight: weight.trim() || undefined,
          stock: stockToSet,
          salePercent: pct,
          saleEndsAt: promoEnd,
          salePriceStotinki: productSalePriceStotinki,
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

  // Rows with a real price. One = a plain product; two or more = variants. In 'fixed'
  // mode a plain product gets one product-level promo price; variants get a per-row one.
  const filledCount = variants.filter((v) => (parseFloat(v.price.replace(',', '.')) || 0) > 0).length;
  const effectivePromoMode = promoMode;

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
            title="Цена и наличност"
            hint="Един ред = един продукт с една цена. Добави още редове за разфасовки или видове (вид/грамаж) — всеки със своя цена и наличност. Наличност празна = неограничено."
            defaultOpen
          >
            <div className="flex flex-col gap-2">
              {variants.map((v, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <div className="flex gap-2">
                    <div className="flex min-w-0 flex-[2] flex-col gap-1">
                      <input
                        value={v.label}
                        onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))}
                        placeholder="Вид / грамаж"
                        className={`${field} min-w-0`}
                      />
                      <span className="text-[11px] text-ff-muted">Празно = един вид</span>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <input
                        value={v.price}
                        onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)))}
                        inputMode="decimal"
                        placeholder="6,50 €"
                        className={`${field} min-w-0`}
                      />
                      <span className="text-[11px] text-ff-muted">Цена</span>
                    </div>
                    <div className="flex w-20 flex-col gap-1">
                      <input
                        value={v.stock}
                        onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, stock: e.target.value.replace(/[^0-9]/g, '') } : r)))}
                        inputMode="numeric"
                        placeholder="бр"
                        className={field}
                      />
                      <span className="text-[11px] text-ff-muted">празно = ∞</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setVariants((p) => p.filter((_, j) => j !== i))}
                      disabled={variants.length <= 1}
                      aria-label="Премахни ред"
                      className="mt-0.5 grid h-[42px] w-9 shrink-0 place-items-center rounded-sm text-ff-red hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:text-ff-muted-2 disabled:hover:bg-transparent"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {effectivePromoMode === 'fixed' && filledCount >= 2 && (
                    <div className="flex items-center gap-2 pl-1">
                      <span className="shrink-0 text-[11.5px] text-ff-muted">Промо цена</span>
                      <input
                        value={v.salePrice}
                        onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, salePrice: e.target.value } : r)))}
                        inputMode="decimal"
                        placeholder="напр. 5,20 € (празно = без промо)"
                        className={`${field} min-w-0 flex-1`}
                      />
                    </div>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setVariants((p) => [...p, { label: '', price: '', stock: '', salePrice: '' }])}
                className="inline-flex items-center gap-1.5 self-start text-[12.5px] font-semibold text-ff-green-700 hover:underline"
              >
                <Plus size={14} /> Добави вид / грамаж
              </button>
            </div>
          </Collapsible>

          <Collapsible
            key={`promo-${effectivePromoMode}-${product?.salePercent ? 'p' : ''}`}
            title="Промоция"
            hint="Намали цената с процент за определен срок. След срока промоцията пада автоматично. Без срок — маха се ръчно."
            defaultOpen={!!product?.salePercent || effectivePromoMode === 'fixed'}
          >
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-ff-ink">
              <label className="flex items-center gap-2">
                <input type="radio" name="promoMode" checked={promoMode === 'percent'} onChange={() => setPromoMode('percent')} />
                Намаление (%)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="promoMode" checked={promoMode === 'fixed'} onChange={() => setPromoMode('fixed')} />
                Фиксирана цена
              </label>
            </div>
            {effectivePromoMode === 'fixed' && filledCount >= 2 ? (
              <p className="text-[12.5px] text-ff-muted">
                {'Въведи „Промо цена“ в реда на всеки вариант по-горе (празно = без промо за него). Маха се ръчно — без срок.'}
              </p>
            ) : effectivePromoMode === 'fixed' ? (
              <>
                <label className={labelCls}>
                  Промо цена
                  <input
                    value={productSalePrice}
                    onChange={(e) => setProductSalePrice(e.target.value)}
                    inputMode="decimal"
                    placeholder="напр. 5,20 € (празно = без промо)"
                    className={field}
                  />
                </label>
                {(() => {
                  const base = Math.round((parseFloat((variants[0]?.price ?? '').replace(',', '.')) || 0) * 100);
                  const sale = Math.round((parseFloat(productSalePrice.replace(',', '.')) || 0) * 100);
                  if (base <= 0 || sale <= 0 || sale >= base) return null;
                  return (
                    <p className="mt-2 text-[12.5px] text-ff-muted">
                      Преглед: <span className="line-through">{moneyFromStotinki(base)}</span>{' '}
                      <span className="font-bold text-ff-green-700">{moneyFromStotinki(sale)}</span>
                    </p>
                  );
                })()}
              </>
            ) : (
            <>
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
              const variantPrices = variants
                .map((v) => Math.round((parseFloat(v.price.replace(',', '.')) || 0) * 100))
                .filter((n) => n > 0);
              const base = variantPrices.length ? Math.min(...variantPrices) : 0;
              if (!pct || pct < 1 || pct > 99 || base <= 0) return null;
              const sale = Math.round((base * (100 - pct)) / 100);
              return (
                <p className="mt-2 text-[12.5px] text-ff-muted">
                  Преглед: <span className="line-through">{moneyFromStotinki(base)}</span>{' '}
                  <span className="font-bold text-ff-green-700">{moneyFromStotinki(sale)}</span>
                  {filledCount >= 2 ? ' · важи за всеки вариант' : ''}
                </p>
              );
            })()}
            </>
            )}
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
