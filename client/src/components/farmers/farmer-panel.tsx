'use client';

import { useState } from 'react';
import { X, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Avatar } from './avatar';
import { MediaManager } from '@/components/media/media-manager';
import { ProductAssignPicker } from '@/components/products/product-assign-picker';
import { ApiError, assignProducts, createFarmer, updateFarmer } from '@/lib/api-client';
import type { Farmer, ProductOption } from '@/lib/types';

const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export function FarmerPanel({
  farmer,
  products = [],
  onClose,
  onSaved,
  onProductsChanged,
}: {
  farmer: Partial<Farmer>;
  products?: ProductOption[];
  onClose: () => void;
  onSaved: (f: Farmer) => void;
  /** Fired after bulk product (un)links so the list can refresh its chips. */
  onProductsChanged?: (updates: { id: string; farmerId: string | null }[]) => void;
}) {
  const isNew = !farmer.id;
  const [name, setName] = useState(farmer.name ?? '');
  const [role, setRole] = useState(farmer.role ?? '');
  const [bio, setBio] = useState(farmer.bio ?? '');
  const [phone, setPhone] = useState(farmer.phone ?? '+359 ');
  const [email, setEmail] = useState(farmer.email ?? '');
  const [since, setSince] = useState(farmer.since ?? '2026');
  // Tint is no longer editable (the color picker was removed); keep the stored
  // value for the avatar / role-label fallback only.
  const tint = farmer.tint ?? '#2C5530';
  const [imageUrl, setImageUrl] = useState(farmer.imageUrl ?? null);
  const [saving, setSaving] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(products.filter((p) => farmer.id && p.farmerId === farmer.id).map((p) => p.id)),
  );

  async function save() {
    if (!name.trim()) {
      toast.error('Въведи име на фермера');
      return;
    }
    setSaving(true);
    try {
      const data = {
        name: name.trim(),
        role: role.trim(),
        bio: bio.trim(),
        phone: phone.trim(),
        email: email.trim() || null,
        since: since.trim(),
      };
      const saved = isNew ? await createFarmer(data) : await updateFarmer(farmer.id!, data);
      // Persist product links (existing farmer only — needs an id).
      if (!isNew && farmer.id) {
        const initial = new Set(products.filter((p) => p.farmerId === farmer.id).map((p) => p.id));
        const addIds = [...checked].filter((id) => !initial.has(id));
        const removeIds = [...initial].filter((id) => !checked.has(id));
        const updates: { id: string; farmerId: string | null }[] = [];
        if (addIds.length) {
          await assignProducts({ productIds: addIds, farmerId: farmer.id });
          updates.push(...addIds.map((id) => ({ id, farmerId: farmer.id! })));
        }
        if (removeIds.length) {
          await assignProducts({ productIds: removeIds, farmerId: null });
          updates.push(...removeIds.map((id) => ({ id, farmerId: null })));
        }
        if (updates.length) onProductsChanged?.(updates);
      }
      toast.success(isNew ? 'Фермерът е добавен' : 'Фермерът е обновен');
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

  // Keep the avatar preview + the farmers list card in sync as the gallery cover
  // (photo 0) changes — without a full reload.
  function onCoverChange(url: string | null) {
    setImageUrl(url);
    if (farmer.id) onSaved({ ...(farmer as Farmer), imageUrl: url });
  }

  return (
    <>
      <div onClick={onClose} className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.32)]" />
      <div className="ff-order-panel fixed right-0 top-0 z-50 flex h-full w-[440px] max-w-full flex-col bg-ff-surface shadow-ff-lg">
        <div className="flex items-center justify-between border-b border-ff-border-2 px-6 pb-[18px] pt-[22px]">
          <div>
            <div className="mb-0.5 text-[12.5px] font-bold text-ff-muted">{isNew ? 'НОВ ФЕРМЕР' : 'РЕДАКЦИЯ'}</div>
            <h2 className="text-[22px] font-extrabold tracking-[-0.015em]">{isNew ? 'Добави фермер' : farmer.name}</h2>
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
          <div className="flex items-center gap-3.5 rounded-xl border border-ff-border-2 bg-ff-surface-2 p-3.5">
            <Avatar name={name || '?'} tint={tint} imageUrl={imageUrl} size={48} ring />
            <div className="min-w-0">
              <div className="text-[15.5px] font-extrabold">{name || 'Име на фермера'}</div>
              <div className="text-[12.5px] font-bold" style={{ color: tint }}>{role || 'Специалност'}</div>
            </div>
          </div>

          {isNew ? (
            <p className="text-[12.5px] text-ff-muted-2">Първо запази фермера, после добави снимка.</p>
          ) : (
            <MediaManager resource="farmers" ownerId={farmer.id!} onCoverChange={onCoverChange} maxPhotos={1} />
          )}

          <label className={labelCls}>
            Име
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Петър Петров" className={field} autoFocus />
          </label>
          <label className={labelCls}>
            Специалност / роля
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="напр. Пчелар — мед" className={field} />
          </label>
          <label className={labelCls}>
            Кратко описание
            <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} placeholder="Какво произвежда този фермер…" className={`${field} resize-y leading-relaxed`} />
          </label>
          <div className="grid grid-cols-[1fr_110px] gap-3">
            <label className={labelCls}>
              Телефон
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className={field} />
            </label>
            <label className={labelCls}>
              От година
              <input value={since} onChange={(e) => setSince(e.target.value)} className={field} />
            </label>
          </div>
          <label className={labelCls}>
            Имейл (за дневния списък с доставки)
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="напр. petar@ferma.bg"
              className={field}
            />
          </label>
          {!isNew && farmer.id && products.length > 0 && (
            <ProductAssignPicker
              products={products}
              checked={checked}
              onToggle={toggleProduct}
              ownerId={farmer.id}
              field="farmerId"
            />
          )}
        </div>

        <div className="flex gap-2.5 border-t border-ff-border-2 px-6 pb-[22px] pt-4">
          <Button variant="primary" onClick={save} disabled={saving} className="flex-1 rounded-sm">
            <Check size={18} /> {isNew ? 'Добави фермер' : 'Запази промените'}
          </Button>
          <Button variant="ghost" onClick={onClose} className="rounded-sm">Отказ</Button>
        </div>
      </div>
    </>
  );
}
