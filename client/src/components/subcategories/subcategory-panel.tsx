'use client';

import { useState } from 'react';
import { X, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SectionPhoto } from './section-photo';
import { MediaManager } from '@/components/media/media-manager';
import { CoverCropEditor } from '@/components/media/cover-crop-editor';
import { ProductAssignPicker } from '@/components/products/product-assign-picker';
import { ApiError, assignProducts, createSubcategory, updateSubcategory } from '@/lib/api-client';
import type { Subcategory, ProductOption, CoverCrop } from '@/lib/types';

// Match the admin card display (aspect="4/3") so the editor preview matches the card.
const SECTION_BANNER_ASPECT = 4 / 3;

const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export function SubcategoryPanel({
  subcat,
  products = [],
  onClose,
  onSaved,
  onProductsChanged,
}: {
  subcat: Partial<Subcategory>;
  products?: ProductOption[];
  onClose: () => void;
  onSaved: (s: Subcategory) => void;
  /** Fired after bulk product (un)links so the list can refresh its chips. */
  onProductsChanged?: (updates: { id: string; subcategoryId: string | null }[]) => void;
}) {
  const isNew = !subcat.id;
  const [name, setName] = useState(subcat.name ?? '');
  const [description, setDescription] = useState(subcat.description ?? '');
  // Tint is no longer editable (color picker removed); keep the stored value for
  // the section-photo gradient fallback only.
  const tint = subcat.tint ?? '#4C8A54';
  const [imageUrl, setImageUrl] = useState(subcat.imageUrl ?? null);
  const [coverCrop, setCoverCrop] = useState<CoverCrop | null>(subcat.coverCrop ?? null);
  const [saving, setSaving] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(products.filter((p) => subcat.id && p.subcategoryId === subcat.id).map((p) => p.id)),
  );

  async function save() {
    if (!name.trim()) {
      toast.error('Въведи име на подкатегорията');
      return;
    }
    setSaving(true);
    try {
      const data = { name: name.trim(), description: description.trim(), coverCrop };
      const saved = isNew ? await createSubcategory(data) : await updateSubcategory(subcat.id!, data);
      // Persist product links (existing subcategory only — needs an id).
      if (!isNew && subcat.id) {
        const initial = new Set(products.filter((p) => p.subcategoryId === subcat.id).map((p) => p.id));
        const addIds = [...checked].filter((id) => !initial.has(id));
        const removeIds = [...initial].filter((id) => !checked.has(id));
        const updates: { id: string; subcategoryId: string | null }[] = [];
        if (addIds.length) {
          await assignProducts({ productIds: addIds, subcategoryId: subcat.id });
          updates.push(...addIds.map((id) => ({ id, subcategoryId: subcat.id! })));
        }
        if (removeIds.length) {
          await assignProducts({ productIds: removeIds, subcategoryId: null });
          updates.push(...removeIds.map((id) => ({ id, subcategoryId: null })));
        }
        if (updates.length) onProductsChanged?.(updates);
      }
      toast.success(isNew ? 'Подкатегорията е добавена' : 'Подкатегорията е обновена');
      onSaved(saved);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally {
      setSaving(false);
    }
  }

  const toggleProduct = (id: string, on: boolean) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  // Keep the section preview + the sections list card in sync as the gallery cover
  // (photo 0) changes — without a full reload.
  function onCoverChange(url: string | null) {
    setImageUrl(url);
    // A different cover image invalidates the saved framing — back to centered.
    setCoverCrop(null);
    if (subcat.id) onSaved({ ...(subcat as Subcategory), imageUrl: url, coverCrop: null });
  }

  return (
    <>
      <div onClick={onClose} className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.32)]" />
      <div className="ff-order-panel fixed right-0 top-0 z-50 flex h-full w-[440px] max-w-full flex-col bg-ff-surface shadow-ff-lg">
        <div className="flex items-center justify-between border-b border-ff-border-2 px-6 pb-[18px] pt-[22px]">
          <div>
            <div className="mb-0.5 text-[12.5px] font-bold text-ff-muted">{isNew ? 'НОВА ПОДКАТЕГОРИЯ' : 'РЕДАКЦИЯ'}</div>
            <h2 className="text-[22px] font-extrabold tracking-[-0.015em]">{isNew ? 'Добави подкатегория' : subcat.name}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Затвори"
            className="grid h-10 w-10 place-items-center rounded-[11px] border border-ff-border bg-ff-surface-2 text-ff-ink-2"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          <div>
            <div className="mb-1.5 text-[12.5px] font-bold text-ff-ink-2">Снимка на секцията</div>
            <SectionPhoto tint={tint} imageUrl={imageUrl} coverCrop={coverCrop} aspect="4 / 3" />
            {isNew ? (
              <p className="mt-2 text-[12.5px] text-ff-muted-2">Първо запази секцията, после добави снимка.</p>
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                <MediaManager resource="subcategories" ownerId={subcat.id!} onCoverChange={onCoverChange} maxPhotos={1} />
                {imageUrl && (
                  <CoverCropEditor
                    imageUrl={imageUrl}
                    value={coverCrop}
                    aspect={SECTION_BANNER_ASPECT}
                    onChange={setCoverCrop}
                  />
                )}
              </div>
            )}
          </div>

          <label className={labelCls}>
            Заглавие на секцията
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Сезонни плодове" className={field} autoFocus />
          </label>
          <label className={labelCls}>
            Кратко описание <span className="font-semibold text-ff-muted">(опционално)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Какво обединява тази секция…" className={`${field} resize-y leading-relaxed`} />
          </label>
          {!isNew && subcat.id && products.length > 0 && (
            <ProductAssignPicker
              products={products}
              checked={checked}
              onToggle={toggleProduct}
              ownerId={subcat.id}
              field="subcategoryId"
            />
          )}
        </div>

        <div className="flex gap-2.5 border-t border-ff-border-2 px-6 pb-[22px] pt-4">
          <Button variant="primary" onClick={save} disabled={saving} className="flex-1 rounded-sm">
            <Check size={18} /> {isNew ? 'Добави подкатегория' : 'Запази промените'}
          </Button>
          <Button variant="ghost" onClick={onClose} className="rounded-sm">Отказ</Button>
        </div>
      </div>
    </>
  );
}
