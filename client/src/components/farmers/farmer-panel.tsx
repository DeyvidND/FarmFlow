'use client';

import { useState } from 'react';
import { X, Check, Send, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Avatar } from './avatar';
import { MediaManager } from '@/components/media/media-manager';
import { CoverCropEditor } from '@/components/media/cover-crop-editor';
import { ProductAssignPicker } from '@/components/products/product-assign-picker';
import {
  ApiError,
  assignProducts,
  createFarmer,
  grantFarmerAccess,
  revokeFarmerAccess,
  updateFarmer,
} from '@/lib/api-client';
import type { Farmer, ProductOption, CoverCrop, FarmerAccess } from '@/lib/types';

const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export function FarmerPanel({
  farmer,
  products = [],
  access,
  onClose,
  onSaved,
  onProductsChanged,
  onAccessChange,
}: {
  farmer: Partial<Farmer>;
  products?: ProductOption[];
  /** Current panel-login state for this farmer (undefined = no login yet). */
  access?: FarmerAccess;
  onClose: () => void;
  onSaved: (f: Farmer) => void;
  /** Fired after bulk product (un)links so the list can refresh its chips. */
  onProductsChanged?: (updates: { id: string; farmerId: string | null }[]) => void;
  /** Bubble a login state change (invite / revoke) up so the card badge updates. */
  onAccessChange?: (farmerId: string, next: FarmerAccess | undefined) => void;
}) {
  const isNew = !farmer.id;
  const [name, setName] = useState(farmer.name ?? '');
  const [role, setRole] = useState(farmer.role ?? '');
  const [bio, setBio] = useState(farmer.bio ?? '');
  const [phone, setPhone] = useState(farmer.phone ?? '+359 ');
  const [email, setEmail] = useState(farmer.email ?? '');
  const [since, setSince] = useState(farmer.since ?? '2026');
  // Panel-login state — one email field below feeds both the daily-delivery digest
  // and (when access is granted) the producer's login.
  const [acc, setAcc] = useState<FarmerAccess | undefined>(access);
  const [grantOnCreate, setGrantOnCreate] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  // Tint is no longer editable (the color picker was removed); keep the stored
  // value for the avatar / role-label fallback only.
  const tint = farmer.tint ?? '#2C5530';
  const [imageUrl, setImageUrl] = useState(farmer.imageUrl ?? null);
  const [coverCrop, setCoverCrop] = useState<CoverCrop | null>(farmer.coverCrop ?? null);
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
        coverCrop,
      };
      const saved = isNew ? await createFarmer(data) : await updateFarmer(farmer.id!, data);
      // New farmer + "give panel access" ticked → invite right away with the same
      // email (no need to find the separate card section). Swallow invite errors so
      // a failed email doesn't lose the just-created farmer — owner can retry.
      if (isNew && grantOnCreate && data.email) {
        try {
          const res = await grantFarmerAccess(saved.id, data.email);
          onAccessChange?.(saved.id, res);
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : 'Поканата не бе изпратена');
        }
      }
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

  // Invite / re-invite an existing farmer using the email field above — the same
  // address that feeds the daily-delivery digest, so there's only ever one email.
  async function invite() {
    if (!farmer.id) return;
    if (!email.trim()) {
      toast.error('Въведи имейл на фермера');
      return;
    }
    setInviteBusy(true);
    try {
      const res = await grantFarmerAccess(farmer.id, email.trim());
      setAcc(res);
      onAccessChange?.(farmer.id, res);
      toast.success('Поканата е изпратена');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally {
      setInviteBusy(false);
    }
  }

  async function revokeAccess() {
    if (!farmer.id) return;
    setInviteBusy(true);
    try {
      await revokeFarmerAccess(farmer.id);
      setAcc(undefined);
      onAccessChange?.(farmer.id, undefined);
      toast.success('Достъпът е премахнат');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally {
      setInviteBusy(false);
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
    // A different cover image invalidates the saved framing — back to centered.
    setCoverCrop(null);
    if (farmer.id) onSaved({ ...(farmer as Farmer), imageUrl: url, coverCrop: null });
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

          {!isNew && imageUrl && (
            <CoverCropEditor imageUrl={imageUrl} value={coverCrop} aspect={3 / 2} onChange={setCoverCrop} />
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
            Имейл
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="напр. petar@ferma.bg"
              className={field}
            />
            <span className="text-[11px] font-semibold text-ff-muted-2">
              Същият имейл се ползва и за дневния списък с доставки, и за входа в панела.
            </span>
          </label>

          {/* Panel access — invite straight from here with the email above. */}
          <div className="rounded-xl border border-ff-border-2 bg-ff-surface-2 p-3.5">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted">
              <KeyRound size={14} /> Достъп до панела
            </div>
            {isNew ? (
              <label className="flex cursor-pointer items-start gap-2.5 text-[13px] font-semibold text-ff-ink-2">
                <input
                  type="checkbox"
                  checked={grantOnCreate}
                  onChange={(e) => setGrantOnCreate(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-ff-green-600"
                />
                <span>
                  Дай му личен достъп до панела с този имейл — ще получи покана да си
                  създаде профил и да вижда само своите продукти, поръчки и плащания.
                </span>
              </label>
            ) : acc ? (
              <div className="flex flex-col gap-2.5">
                <span className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-ff-ink-2">
                  {acc.invitePending ? (
                    <><Send size={13} className="text-ff-amber-600" /> Поканен · {acc.loginEmail}</>
                  ) : (
                    <><Check size={13} className="text-ff-green-700" /> Активен · {acc.loginEmail}</>
                  )}
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" disabled={inviteBusy} onClick={invite}>
                    <Send size={14} /> Изпрати поканата отново
                  </Button>
                  <Button size="sm" variant="ghost" disabled={inviteBusy} onClick={revokeAccess}>
                    <X size={14} /> Откажи достъп
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-[12.5px] text-ff-muted">
                  Този фермер още няма достъп до панела.
                </p>
                <Button size="sm" variant="primary" disabled={inviteBusy || !email.trim()} onClick={invite}>
                  <Send size={14} /> Покани в панела
                </Button>
              </div>
            )}
          </div>
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
