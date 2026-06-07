'use client';

import { useState } from 'react';
import { X, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SectionPhoto } from './section-photo';
import { MediaManager } from '@/components/media/media-manager';
import { ApiError, createSubcategory, updateSubcategory } from '@/lib/api-client';
import type { Subcategory } from '@/lib/types';

const TINTS = ['#4C8A54', '#B23B5E', '#D08B26', '#5B5BA8', '#A11E2E', '#3B3B57'];
const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export function SubcategoryPanel({
  subcat,
  onClose,
  onSaved,
}: {
  subcat: Partial<Subcategory>;
  onClose: () => void;
  onSaved: (s: Subcategory) => void;
}) {
  const isNew = !subcat.id;
  const [name, setName] = useState(subcat.name ?? '');
  const [description, setDescription] = useState(subcat.description ?? '');
  const [tint, setTint] = useState(subcat.tint ?? TINTS[0]);
  const [imageUrl, setImageUrl] = useState(subcat.imageUrl ?? null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) {
      toast.error('Въведи име на подкатегорията');
      return;
    }
    setSaving(true);
    try {
      const data = { name: name.trim(), description: description.trim(), tint };
      const saved = isNew ? await createSubcategory(data) : await updateSubcategory(subcat.id!, data);
      toast.success(isNew ? 'Подкатегорията е добавена' : 'Подкатегорията е обновена');
      onSaved(saved);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally {
      setSaving(false);
    }
  }

  // Keep the section preview + the sections list card in sync as the gallery cover
  // (photo 0) changes — without a full reload.
  function onCoverChange(url: string | null) {
    setImageUrl(url);
    if (subcat.id) onSaved({ ...(subcat as Subcategory), imageUrl: url });
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
            <SectionPhoto tint={tint} imageUrl={imageUrl} height={130} />
            {isNew ? (
              <p className="mt-2 text-[12.5px] text-ff-muted-2">Първо запази секцията, после добави снимка.</p>
            ) : (
              <div className="mt-3">
                <MediaManager resource="subcategories" ownerId={subcat.id!} onCoverChange={onCoverChange} maxPhotos={1} />
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
          <div className={labelCls}>
            Цвят на секцията
            <div className="flex flex-wrap gap-2.5">
              {TINTS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTint(t)}
                  className="grid h-[34px] w-[34px] place-items-center rounded-full"
                  style={{ background: t, boxShadow: tint === t ? `0 0 0 3px var(--ff-surface), 0 0 0 5px ${t}` : 'inset 0 0 0 1px rgba(0,0,0,0.1)' }}
                >
                  {tint === t && <Check size={16} strokeWidth={3} color="#fff" />}
                </button>
              ))}
            </div>
          </div>
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
