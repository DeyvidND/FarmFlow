'use client';

import { useState } from 'react';
import { X, Check, Image as ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Avatar } from './avatar';
import { ApiError, createFarmer, updateFarmer, uploadFarmerImage } from '@/lib/api-client';
import type { Farmer } from '@/lib/types';

const TINTS = ['#2C5530', '#B23B5E', '#D08B26', '#5B5BA8', '#A11E2E', '#3B7D52'];
const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export function FarmerPanel({
  farmer,
  onClose,
  onSaved,
}: {
  farmer: Partial<Farmer>;
  onClose: () => void;
  onSaved: (f: Farmer) => void;
}) {
  const isNew = !farmer.id;
  const [name, setName] = useState(farmer.name ?? '');
  const [role, setRole] = useState(farmer.role ?? '');
  const [bio, setBio] = useState(farmer.bio ?? '');
  const [phone, setPhone] = useState(farmer.phone ?? '+359 ');
  const [since, setSince] = useState(farmer.since ?? '2026');
  const [tint, setTint] = useState(farmer.tint ?? TINTS[0]);
  const [imageUrl, setImageUrl] = useState(farmer.imageUrl ?? null);
  const [saving, setSaving] = useState(false);

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
        since: since.trim(),
        tint,
      };
      const saved = isNew ? await createFarmer(data) : await updateFarmer(farmer.id!, data);
      toast.success(isNew ? 'Фермерът е добавен' : 'Фермерът е обновен');
      onSaved(saved);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally {
      setSaving(false);
    }
  }

  async function onPickImage(file: File) {
    if (isNew) {
      toast.error('Първо запази фермера, после качи снимка');
      return;
    }
    try {
      const updated = await uploadFarmerImage(farmer.id!, file);
      setImageUrl(updated.imageUrl);
      onSaved(updated);
      toast.success('Снимката е качена');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    }
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

          {!isNew && (
            <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-1.5 text-[13px] font-bold text-ff-ink-2">
              <ImageIcon size={15} /> Качи снимка
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && onPickImage(e.target.files[0])}
              />
            </label>
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
          <div className={labelCls}>
            Цвят на профила
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
            <Check size={18} /> {isNew ? 'Добави фермер' : 'Запази промените'}
          </Button>
          <Button variant="ghost" onClick={onClose} className="rounded-sm">Отказ</Button>
        </div>
      </div>
    </>
  );
}
