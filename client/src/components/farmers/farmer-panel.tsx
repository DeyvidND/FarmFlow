'use client';

import { useEffect, useRef, useState } from 'react';
import { X, Check, Send, KeyRound, Sparkles, Images, FileText } from 'lucide-react';
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

// Font is 16px on phones (prevents iOS Safari auto-zoom on focus, which yanks the
// whole drawer sideways) and drops back to the denser 14.5px on ≥sm screens.
const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[16px] sm:text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export function FarmerPanel({
  farmer,
  products = [],
  subcategories = [],
  access,
  focusInvite = false,
  multiFarmer = false,
  onClose,
  onSaved,
  onProductsChanged,
  onAccessChange,
}: {
  farmer: Partial<Farmer>;
  products?: ProductOption[];
  /** Marketplace tenant — only then are the per-producer finance override inputs
   *  (комисиона % / месечна такса) shown. Single-farm tenants see zero change. */
  multiFarmer?: boolean;
  /** Categories, so the product picker can group products by category and float
   *  the one you're picking from to the top. */
  subcategories?: { id: string; name: string }[];
  /** Current panel-login state for this farmer (undefined = no login yet). */
  access?: FarmerAccess;
  /** Opened via the card „Покани" → scroll to + focus the invite section so the
   *  owner sees the email field and the „Покани в панела" button immediately
   *  instead of landing on a generic edit form. */
  focusInvite?: boolean;
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
  const [city, setCity] = useState(farmer.city ?? '');
  const [commissionPct, setCommissionPct] = useState(
    farmer.commissionRateBps != null ? String(farmer.commissionRateBps / 100) : '',
  );
  const [monthlyFee, setMonthlyFee] = useState(
    farmer.subscriptionFeeStotinki != null ? String(farmer.subscriptionFeeStotinki / 100) : '',
  );
  // Legal seller identity (farmer-as-seller marketplace) — КЗП/НАП disclosure. Persists
  // to the `farmers.legal` jsonb column and IS surfaced publicly on the storefront (this
  // is required seller disclosure, unlike the finance overrides above). A farmer without
  // it can't be flipped to a live seller. `kind` selects which id matters: individual →
  // регистрационен № (Наредба 3), sole_trader (ЕТ) / company → ЕИК.
  const [legalKind, setLegalKind] = useState<'' | 'individual' | 'sole_trader' | 'company'>(
    farmer.legal?.kind ?? '',
  );
  const [legalName, setLegalName] = useState(farmer.legal?.name ?? '');
  const [eik, setEik] = useState(farmer.legal?.eik ?? '');
  const [vatNumber, setVatNumber] = useState(farmer.legal?.vatNumber ?? '');
  const [legalAddress, setLegalAddress] = useState(farmer.legal?.address ?? '');
  const [regNo, setRegNo] = useState(farmer.legal?.regNo ?? '');
  // Tier-2 „Бранд идентичност" — operator-controlled paid branding. `brandingEnabled`
  // is the gate; when on, the marketplace renders the branded subpage and the panel
  // raises the photo cap so the gallery has more than one image. Primary brand color
  // reuses `tint` (re-editable only inside this section). See tier2-brand-identity-spec.
  const [brandingEnabled, setBrandingEnabled] = useState(farmer.branding?.enabled ?? false);
  const [brandColor, setBrandColor] = useState(farmer.tint ?? '#2C5530');
  const [accent, setAccent] = useState(farmer.branding?.accent ?? '');
  const [gallery, setGallery] = useState<'wide' | 'mosaic' | 'row' | 'grid'>(
    farmer.branding?.gallery ?? 'mosaic',
  );
  const [badges, setBadges] = useState<string[]>(farmer.branding?.badges ?? []);
  const toggleBadge = (k: string) =>
    setBadges((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
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

  // Deep-link from the card „Покани": pull the invite section into view and put the
  // cursor in the email field (or, if an email is already filled, on the invite
  // button) so it's obvious what to do — no hunting below the fold.
  const accessRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusInvite) return;
    const t = setTimeout(() => {
      accessRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      emailRef.current?.focus();
    }, 60); // let the panel slide-in finish before scrolling
    return () => clearTimeout(t);
  }, [focusInvite]);

  async function save() {
    if (!name.trim()) {
      toast.error('Въведи име на фермера');
      return;
    }
    setSaving(true);
    try {
      // Legal seller identity — send the object only when the operator filled at least
      // one field; an all-blank form clears it back to null. `confirmedAt` stamps each
      // non-empty save as "last confirmed by the operator" (audit trail).
      const legalParts = {
        kind: legalKind || undefined,
        name: legalName.trim() || undefined,
        eik: eik.trim() || undefined,
        vatNumber: vatNumber.trim() || undefined,
        address: legalAddress.trim() || undefined,
        regNo: regNo.trim() || undefined,
      };
      const hasLegal = Object.values(legalParts).some(Boolean);
      const data = {
        name: name.trim(),
        role: role.trim(),
        bio: bio.trim(),
        phone: phone.trim(),
        email: email.trim() || null,
        since: since.trim(),
        city: city.trim() || null,
        coverCrop,
        legal: hasLegal ? { ...legalParts, confirmedAt: new Date().toISOString() } : null,
        commissionRateBps: commissionPct.trim() === '' ? null : Math.round(parseFloat(commissionPct) * 100),
        subscriptionFeeStotinki: monthlyFee.trim() === '' ? null : Math.round(parseFloat(monthlyFee) * 100),
        // Tier-2: when branding is on, the primary brand color (tint) is editable here
        // and the branding control layer persists. Off → keep any prior config but flip
        // the gate closed, so re-enabling restores the operator's settings.
        ...(brandingEnabled ? { tint: brandColor } : {}),
        branding: brandingEnabled
          ? {
              enabled: true as const,
              plan: 'tier2' as const,
              accent: accent.trim() || undefined,
              gallery,
              badges,
              unlockedAt: farmer.branding?.unlockedAt ?? new Date().toISOString(),
              unlockedBy: farmer.branding?.unlockedBy,
            }
          : farmer.branding
            ? { ...farmer.branding, enabled: false as const }
            : null,
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
            className="grid h-11 w-11 place-items-center rounded-[11px] border border-ff-border bg-ff-surface-2 text-ff-ink-2"
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
            <p className="text-[12.5px] text-ff-muted">Първо запази фермера, после добави снимка.</p>
          ) : (
            <MediaManager resource="farmers" ownerId={farmer.id!} onCoverChange={onCoverChange} maxPhotos={brandingEnabled ? 6 : 1} />
          )}

          {!isNew && imageUrl && (
            <CoverCropEditor imageUrl={imageUrl} value={coverCrop} aspect={3 / 2} onChange={setCoverCrop} />
          )}

          <label className={labelCls}>
            Име
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Петър Петров" className={field} autoFocus={!focusInvite} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Специалност / роля
              <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="напр. Пчелар — мед" className={field} />
            </label>
            <label className={labelCls}>
              Град
              <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="напр. Варна" className={field} />
            </label>
          </div>
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
          {multiFarmer && (
            <div className="rounded-xl border border-ff-border-2 bg-ff-surface-2 p-3.5">
              <div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted">
                <FileText size={14} /> Юридически данни · продавач
              </div>
              <p className="mt-1.5 text-[12px] leading-snug text-ff-muted">
                На пазара всеки фермер е продавачът — тези данни се показват на клиента (кой
                е насрещната страна) и служат за отчитане пред НАП. Задължителни, преди
                фермерът да продава сам.
              </p>
              <div className="mt-3 flex flex-col gap-3">
                <label className={labelCls}>
                  Вид продавач
                  <select
                    value={legalKind}
                    onChange={(e) => setLegalKind(e.target.value as typeof legalKind)}
                    className={field}
                  >
                    <option value="">— избери —</option>
                    <option value="individual">Физическо лице / земеделски производител</option>
                    <option value="sole_trader">ЕТ (едноличен търговец)</option>
                    <option value="company">Фирма (ЕООД / ООД / АД)</option>
                  </select>
                </label>
                <label className={labelCls}>
                  Юридическо / фирмено име
                  <input
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    placeholder={legalKind === 'individual' ? 'напр. Димка Иванова Четова' : 'напр. ЕТ „Димка Четова"'}
                    className={field}
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className={labelCls}>
                    {legalKind === 'individual' ? 'Рег. № зем. производител' : 'ЕИК / БУЛСТАТ'}
                    <input
                      value={legalKind === 'individual' ? regNo : eik}
                      onChange={(e) =>
                        legalKind === 'individual' ? setRegNo(e.target.value) : setEik(e.target.value)
                      }
                      inputMode="numeric"
                      placeholder={legalKind === 'individual' ? 'Наредба 3' : 'напр. 203912345'}
                      className={field}
                    />
                  </label>
                  <label className={labelCls}>
                    ДДС № (по избор)
                    <input
                      value={vatNumber}
                      onChange={(e) => setVatNumber(e.target.value)}
                      placeholder="напр. BG203912345"
                      className={field}
                    />
                  </label>
                </div>
                <label className={labelCls}>
                  Адрес на управление / кореспонденция
                  <input
                    value={legalAddress}
                    onChange={(e) => setLegalAddress(e.target.value)}
                    placeholder="напр. гр. Варна, ул. Приморска 12"
                    className={field}
                  />
                </label>
                {farmer.legal?.confirmedAt && (
                  <p className="text-[11px] font-semibold text-ff-muted">
                    Последно потвърдено: {new Date(farmer.legal.confirmedAt).toLocaleDateString('bg-BG')}
                  </p>
                )}
              </div>
            </div>
          )}
          {multiFarmer && (
            <div className="grid grid-cols-2 gap-3">
              <label className={labelCls}>
                Комисиона % (празно = по подразбиране)
                <input value={commissionPct} onChange={(e) => setCommissionPct(e.target.value)} inputMode="decimal" placeholder="5" className={field} />
              </label>
              <label className={labelCls}>
                Месечна такса € (празно = по подразбиране)
                <input value={monthlyFee} onChange={(e) => setMonthlyFee(e.target.value)} inputMode="decimal" placeholder="12" className={field} />
              </label>
            </div>
          )}
          {multiFarmer && !isNew && (
            <div className="rounded-xl border border-ff-border-2 bg-ff-surface-2 p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted">
                    <Sparkles size={14} /> Бранд идентичност · Tier 2
                  </div>
                  <p className="mt-1.5 text-[12px] leading-snug text-ff-muted">
                    Платена. Едър портрет, галерия и собствен цвят на страницата на фермера в пазара.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={brandingEnabled}
                  onClick={() => setBrandingEnabled((v) => !v)}
                  className={`relative mt-0.5 h-8 w-[54px] shrink-0 rounded-full transition-colors ${
                    brandingEnabled ? 'bg-ff-green-600' : 'bg-ff-border'
                  }`}
                >
                  <span
                    className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${
                      brandingEnabled ? 'left-[25px]' : 'left-1'
                    }`}
                  />
                </button>
              </div>

              {brandingEnabled && (
                <div className="mt-4 flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-3">
                    <label className={labelCls}>
                      Основен цвят
                      <span className="flex items-center gap-2 rounded-sm border border-ff-border bg-ff-surface px-2.5 py-2">
                        <input
                          type="color"
                          value={brandColor}
                          onChange={(e) => setBrandColor(e.target.value)}
                          className="h-7 w-7 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                          aria-label="Основен цвят"
                        />
                        <span className="text-[13px] font-bold uppercase text-ff-ink">{brandColor}</span>
                      </span>
                    </label>
                    <label className={labelCls}>
                      Акцент (по избор)
                      <span className="flex items-center gap-2 rounded-sm border border-ff-border bg-ff-surface px-2.5 py-2">
                        <input
                          type="color"
                          value={accent || '#E7A33E'}
                          onChange={(e) => setAccent(e.target.value)}
                          className="h-7 w-7 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                          aria-label="Акцент"
                        />
                        <span className="text-[13px] font-bold uppercase text-ff-ink">{accent || '—'}</span>
                      </span>
                    </label>
                  </div>

                  <div className={labelCls}>
                    Оформление на галерията
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {([
                        ['wide', 'Едра'],
                        ['mosaic', 'Мозайка'],
                        ['row', 'Три в ред'],
                        ['grid', 'Решетка'],
                      ] as const).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setGallery(key)}
                          className={`rounded-lg border px-2 py-2 text-[11.5px] font-bold transition-colors ${
                            gallery === key
                              ? 'border-ff-green-500 bg-ff-green-100 text-ff-green-700'
                              : 'border-ff-border bg-ff-surface text-ff-ink-2'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className={labelCls}>
                    Значки
                    <div className="flex flex-wrap gap-2">
                      {([
                        ['verified', 'Проверен фермер'],
                        ['bio', 'Био'],
                        ['awarded', 'Награждаван'],
                      ] as const).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => toggleBadge(key)}
                          className={`rounded-full border px-3 py-1.5 text-[12.5px] font-bold transition-colors ${
                            badges.includes(key)
                              ? 'border-ff-green-600 bg-ff-green-600 text-white'
                              : 'border-ff-border bg-ff-surface text-ff-ink-2'
                          }`}
                        >
                          {badges.includes(key) ? '✓ ' : '＋ '}
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ff-muted">
                    <Images size={14} /> Качи до 6 снимки горе — първата е портретът, останалите стават галерията.
                  </p>
                </div>
              )}
            </div>
          )}

          <label className={labelCls}>
            Имейл
            <input
              ref={emailRef}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="напр. petar@ferma.bg"
              className={field}
            />
            <span className="text-[11px] font-semibold text-ff-muted">
              Същият имейл се ползва и за дневния списък с доставки, и за входа в панела.
            </span>
          </label>

          {/* Panel access — invite straight from here with the email above. */}
          <div
            ref={accessRef}
            className={`rounded-xl border bg-ff-surface-2 p-3.5 transition-shadow ${
              focusInvite ? 'border-ff-green-500 shadow-[0_0_0_3px_var(--ff-green-100)]' : 'border-ff-border-2'
            }`}
          >
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
              groups={subcategories.map((s) => ({ id: s.id, label: s.name }))}
              groupField="subcategoryId"
              groupNoun="категория"
            />
          )}
        </div>

        <div className="flex gap-2.5 border-t border-ff-border-2 px-6 pb-[calc(22px+env(safe-area-inset-bottom))] pt-4">
          <Button variant="primary" onClick={save} disabled={saving} className="flex-1 rounded-sm">
            <Check size={18} /> {isNew ? 'Добави фермер' : 'Запази промените'}
          </Button>
          <Button variant="ghost" onClick={onClose} className="rounded-sm">Отказ</Button>
        </div>
      </div>
    </>
  );
}
