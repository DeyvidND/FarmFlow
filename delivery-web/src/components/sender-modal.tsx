'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Search } from 'lucide-react';
import {
  ApiError,
  getEcontConfig, getSpeedyConfig,
  saveEcontProfile, saveSpeedyProfile,
  listEcontCities, listEcontOffices,
  listSpeedySites, listSpeedyOffices,
  type EcontSender, type SpeedySender,
  type EcontOfficeLive, type SpeedyOffice,
} from '@/lib/api-client';
import { cn } from '@/lib/utils';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const inp = 'h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3.5 text-[14px] outline-none focus:border-ff-green-500';
const lbl = 'mb-1 block text-[12.5px] font-bold text-ff-muted';

function Seg<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex flex-wrap gap-[3px] rounded-[9px] border border-ff-border bg-ff-surface-2 p-[3px]">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={cn('rounded-[7px] px-[13px] py-[7px] text-[13px] font-bold transition-colors',
            value === o.value ? 'bg-ff-surface text-ff-green-800 shadow-ff-sm' : 'text-ff-ink-2 hover:text-ff-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Autocomplete({ value, disabled, notReadyHint, search, onPick }: {
  value: string;
  disabled?: boolean;
  notReadyHint?: string;
  search: (q: string) => Promise<{ id: number; name: string; postCode: string | null }[]>;
  onPick: (row: { id: number; name: string }) => void;
}) {
  const [q, setQ] = useState(value);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ id: number; name: string; postCode: string | null }[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => setQ(value), [value]);
  useEffect(() => {
    if (!open || disabled) return;
    let active = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      search(q).then((r) => active && setList(r)).catch(() => active && setList([])).finally(() => active && setLoading(false));
    }, 220);
    return () => { active = false; window.clearTimeout(t); };
  }, [q, open, disabled, search]);
  return (
    <div className="relative">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ff-muted" />
      <input value={q} disabled={disabled} placeholder="Търси населено място…"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 160)}
        className={cn(inp, 'pl-9 disabled:cursor-not-allowed disabled:opacity-60')} />
      {open && !disabled && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-[240px] overflow-y-auto rounded-[9px] border border-ff-border bg-ff-surface shadow-ff-md">
          {loading ? <div className="px-3.5 py-3 text-[12.5px] text-ff-muted">Търсене…</div>
            : list.length === 0 ? <div className="px-3.5 py-3 text-[12.5px] text-ff-muted">Няма резултати.</div>
            : list.map((r) => (
              <button key={r.id} type="button"
                onMouseDown={() => { onPick(r); setQ(r.name); setOpen(false); }}
                className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left hover:bg-ff-green-50">
                <span className="text-[14px] font-semibold text-ff-ink">{r.name}</span>
                {r.postCode && <span className="text-[12px] text-ff-muted">{r.postCode}</span>}
              </button>
            ))}
        </div>
      )}
      {open && disabled && notReadyHint && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 rounded-[9px] border border-ff-border bg-ff-surface px-3.5 py-3 text-[12.5px] text-ff-muted shadow-ff-md">{notReadyHint}</div>
      )}
    </div>
  );
}

/**
 * Edit one carrier's sender (name/phone + drop-off office/address), with package +
 * COD collapsed under „Разширени". Replaces the standalone „Профил на подател" page —
 * opened from the SenderStrip on Пратки/Внос.
 */
export function SenderModal({
  carrier,
  open,
  onClose,
  onSaved,
}: {
  carrier: 'econt' | 'speedy';
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);

  // ── Econt state (used when carrier === 'econt') ──────────────────────────
  const [eConfigured, setEConfigured] = useState(false);
  const [eSender, setESender] = useState<EcontSender>({ mode: 'office' });
  const [ePkg, setEPkg] = useState<{ weightKg?: number; contents?: string }>({});
  const [eCod, setECod] = useState<{ enabled?: boolean; feePayer?: 'customer' | 'farm' }>({ enabled: true, feePayer: 'customer' });
  const [eOffices, setEOffices] = useState<EcontOfficeLive[]>([]);
  const [eSaving, setESaving] = useState(false);

  // ── Speedy state (used when carrier === 'speedy') ────────────────────────
  const [sConfigured, setSConfigured] = useState(false);
  const [sSender, setSSender] = useState<SpeedySender>({ mode: 'office' });
  const [sPkg, setSPkg] = useState<{ parcelsCount?: number; weightKg?: number; contents?: string }>({});
  const [sCod, setSCod] = useState<{ enabled?: boolean; processingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER' }>({ enabled: true, processingType: 'CASH' });
  const [sOffices, setSOffices] = useState<SpeedyOffice[]>([]);
  const [sSaving, setSSaving] = useState(false);

  // Load the config for the active carrier when the modal opens.
  useEffect(() => {
    if (!open) return;
    if (carrier === 'econt') {
      getEcontConfig().then((c) => {
        setEConfigured(!!c.configured);
        if (c.sender) setESender({ mode: 'office', ...c.sender });
        if (c.defaultPackage) setEPkg({ weightKg: c.defaultPackage.weightKg, contents: c.defaultPackage.contents });
        if (c.cod) setECod({ enabled: c.cod.enabled ?? true, feePayer: c.cod.feePayer ?? 'customer' });
      }).catch((e) => toast.error(`Econt: ${errMsg(e)}`));
    } else {
      getSpeedyConfig().then((c) => {
        setSConfigured(!!c.configured);
        if (c.sender) setSSender({ mode: 'office', ...c.sender });
        if (c.defaultPackage) setSPkg({ parcelsCount: c.defaultPackage.parcelsCount, weightKg: c.defaultPackage.weightKg, contents: c.defaultPackage.contents });
        if (c.cod) setSCod({ enabled: c.cod.enabled ?? true, processingType: c.cod.processingType ?? 'CASH' });
      }).catch((e) => toast.error(`Speedy: ${errMsg(e)}`));
    }
  }, [open, carrier]);

  // Fetch Econt offices when city changes.
  useEffect(() => {
    if (carrier !== 'econt' || !eConfigured || !eSender.cityId) { setEOffices([]); return; }
    let active = true;
    listEcontOffices(eSender.cityId).then((r) => active && setEOffices(r)).catch(() => active && setEOffices([]));
    return () => { active = false; };
  }, [carrier, eConfigured, eSender.cityId]);

  // Fetch Speedy offices when site changes.
  useEffect(() => {
    if (carrier !== 'speedy' || !sConfigured || !sSender.siteId) { setSOffices([]); return; }
    let active = true;
    listSpeedyOffices(sSender.siteId).then((r) => active && setSOffices(r)).catch(() => active && setSOffices([]));
    return () => { active = false; };
  }, [carrier, sConfigured, sSender.siteId]);

  const saving = carrier === 'econt' ? eSaving : sSaving;

  const handleSave = async () => {
    if (carrier === 'econt') {
      setESaving(true);
      try {
        await saveEcontProfile({ sender: eSender, defaultPackage: { weightKg: ePkg.weightKg, contents: ePkg.contents }, cod: eCod });
        toast.success('Подателят е запазен');
        onSaved();
        onClose();
      } catch (e) {
        toast.error(errMsg(e));
      } finally {
        setESaving(false);
      }
    } else {
      setSSaving(true);
      try {
        await saveSpeedyProfile({ sender: sSender, defaultPackage: sPkg, cod: sCod });
        toast.success('Подателят е запазен');
        onSaved();
        onClose();
      } catch (e) {
        toast.error(errMsg(e));
      } finally {
        setSSaving(false);
      }
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-[560px] rounded-2xl bg-ff-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-[18px] font-extrabold">
          Подател — {carrier === 'econt' ? 'Еконт' : 'Speedy'}
        </h2>
        <p className="mt-1 text-[13px] text-ff-muted">
          Тези данни влизат автоматично във всяка товарителница. Попълнени са от профила
          ти — смени само ако е нужно.
        </p>

        <div className="mt-4 space-y-3">
          {/* ── Econt fields ── */}
          {carrier === 'econt' && (
            <>
              {!eConfigured && (
                <p className="text-[12.5px] text-ff-amber-600">
                  Свържи Econt акаунта в „Куриерски акаунти", за да избираш град и офис на живо.
                </p>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={lbl}>Име на подател</label>
                  <input className={inp} value={eSender.name ?? ''} onChange={(e) => setESender({ ...eSender, name: e.target.value })} />
                </div>
                <div>
                  <label className={lbl}>Телефон</label>
                  <input className={inp} value={eSender.phone ?? ''} onChange={(e) => setESender({ ...eSender, phone: e.target.value })} />
                </div>
              </div>
              <div>
                <label className={lbl}>Град</label>
                <Autocomplete
                  value={eSender.cityName ?? ''} disabled={!eConfigured}
                  notReadyHint="Първо свържи Econt акаунта."
                  search={listEcontCities}
                  onPick={(c) => setESender({ ...eSender, cityId: c.id, cityName: c.name, officeCode: undefined })}
                />
              </div>
              <div>
                <label className={lbl}>Подаване</label>
                <Seg
                  value={eSender.mode === 'address' ? 'address' : 'office'}
                  onChange={(v) => setESender({ ...eSender, mode: v })}
                  options={[{ value: 'office', label: 'От офис' }, { value: 'address', label: 'От адрес' }]}
                />
              </div>
              {eSender.mode === 'address' ? (
                <div>
                  <label className={lbl}>Адрес на подаване</label>
                  <input className={inp} value={eSender.address ?? ''} onChange={(e) => setESender({ ...eSender, address: e.target.value })} />
                </div>
              ) : (
                <div>
                  <label className={lbl}>Офис на подаване</label>
                  {!eConfigured
                    ? <div className={cn(inp, 'flex items-center text-ff-muted')}>Свържи Econt</div>
                    : eOffices.length === 0
                      ? <div className={cn(inp, 'flex items-center text-ff-muted')}>{eSender.cityName ? `Няма офиси в „${eSender.cityName}"` : 'Първо избери град'}</div>
                      : (
                        <select className={cn(inp, 'cursor-pointer')} value={eSender.officeCode ?? ''} onChange={(e) => setESender({ ...eSender, officeCode: e.target.value })}>
                          <option value="" disabled>Избери офис…</option>
                          {eOffices.map((o) => <option key={o.code} value={o.code}>{o.name}{o.address ? ` — ${o.address}` : ''}</option>)}
                        </select>
                      )}
                </div>
              )}
            </>
          )}

          {/* ── Speedy fields ── */}
          {carrier === 'speedy' && (
            <>
              {!sConfigured && (
                <p className="text-[12.5px] text-ff-amber-600">
                  Свържи Speedy акаунта в „Куриерски акаунти", за да избираш населено място и офис на живо.
                </p>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={lbl}>Име/контакт на подател</label>
                  <input className={inp} value={sSender.contactName ?? ''} onChange={(e) => setSSender({ ...sSender, contactName: e.target.value })} />
                </div>
                <div>
                  <label className={lbl}>Телефон</label>
                  <input className={inp} value={sSender.phone ?? ''} onChange={(e) => setSSender({ ...sSender, phone: e.target.value })} />
                </div>
              </div>
              <div>
                <label className={lbl}>Населено място</label>
                <Autocomplete
                  value={sSender.siteName ?? ''} disabled={!sConfigured}
                  notReadyHint="Първо свържи Speedy акаунта."
                  search={listSpeedySites}
                  onPick={(s) => setSSender({ ...sSender, siteId: s.id, siteName: s.name, officeId: undefined })}
                />
              </div>
              <div>
                <label className={lbl}>Подаване</label>
                <Seg
                  value={sSender.mode === 'address' ? 'address' : 'office'}
                  onChange={(v) => setSSender({ ...sSender, mode: v })}
                  options={[{ value: 'office', label: 'От офис' }, { value: 'address', label: 'От адрес' }]}
                />
              </div>
              {sSender.mode === 'address' ? (
                <div>
                  <label className={lbl}>Улица и номер</label>
                  <input className={inp} value={sSender.streetNo ?? ''} onChange={(e) => setSSender({ ...sSender, streetNo: e.target.value })} />
                </div>
              ) : (
                <div>
                  <label className={lbl}>Офис на подаване</label>
                  {!sConfigured
                    ? <div className={cn(inp, 'flex items-center text-ff-muted')}>Свържи Speedy</div>
                    : sOffices.length === 0
                      ? <div className={cn(inp, 'flex items-center text-ff-muted')}>{sSender.siteName ? `Няма офиси в „${sSender.siteName}"` : 'Първо избери населено място'}</div>
                      : (
                        <select className={cn(inp, 'cursor-pointer')} value={sSender.officeId ?? ''} onChange={(e) => setSSender({ ...sSender, officeId: parseInt(e.target.value, 10) || undefined })}>
                          <option value="" disabled>Избери офис…</option>
                          {sOffices.map((o) => <option key={o.id} value={o.id}>{o.name}{o.address ? ` — ${o.address}` : ''}</option>)}
                        </select>
                      )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Advanced (package + COD) ── */}
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="mt-4 text-[13px] font-bold text-ff-green-700"
        >
          {advanced ? '− Скрий разширени' : '+ Разширени (пакет, наложен платеж)'}
        </button>

        {advanced && carrier === 'econt' && (
          <div className="mt-2 space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={lbl}>Тегло по подразбиране (кг)</label>
                <input className={inp} inputMode="decimal" value={ePkg.weightKg ?? ''} onChange={(e) => setEPkg({ ...ePkg, weightKg: parseFloat(e.target.value) || 0 })} />
              </div>
              <div>
                <label className={lbl}>Съдържание</label>
                <input className={inp} value={ePkg.contents ?? ''} onChange={(e) => setEPkg({ ...ePkg, contents: e.target.value })} />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-ff-border bg-ff-surface-2 px-3.5 py-3">
              <span className="text-[13.5px] font-bold text-ff-ink">Наложен платеж</span>
              <div className="flex items-center gap-3">
                {eCod.enabled && (
                  <Seg
                    value={eCod.feePayer ?? 'customer'}
                    onChange={(v) => setECod({ ...eCod, feePayer: v })}
                    options={[{ value: 'customer', label: 'Клиент' }, { value: 'farm', label: 'Ферма' }]}
                  />
                )}
                <input type="checkbox" checked={!!eCod.enabled} onChange={(e) => setECod({ ...eCod, enabled: e.target.checked })} className="h-5 w-5" />
              </div>
            </div>
          </div>
        )}

        {advanced && carrier === 'speedy' && (
          <div className="mt-2 space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className={lbl}>Тегло (кг)</label>
                <input className={inp} inputMode="decimal" value={sPkg.weightKg ?? ''} onChange={(e) => setSPkg({ ...sPkg, weightKg: parseFloat(e.target.value) || 0 })} />
              </div>
              <div>
                <label className={lbl}>Брой пакети</label>
                <input className={inp} inputMode="numeric" value={sPkg.parcelsCount ?? ''} onChange={(e) => setSPkg({ ...sPkg, parcelsCount: parseInt(e.target.value, 10) || undefined })} />
              </div>
              <div>
                <label className={lbl}>Съдържание</label>
                <input className={inp} value={sPkg.contents ?? ''} onChange={(e) => setSPkg({ ...sPkg, contents: e.target.value })} />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-ff-border bg-ff-surface-2 px-3.5 py-3">
              <span className="text-[13.5px] font-bold text-ff-ink">Наложен платеж</span>
              <div className="flex items-center gap-3">
                {sCod.enabled && (
                  <Seg
                    value={sCod.processingType === 'POSTAL_MONEY_TRANSFER' ? 'POSTAL_MONEY_TRANSFER' : 'CASH'}
                    onChange={(v) => setSCod({ ...sCod, processingType: v })}
                    options={[{ value: 'CASH', label: 'В брой' }, { value: 'POSTAL_MONEY_TRANSFER', label: 'Пощенски' }]}
                  />
                )}
                <input type="checkbox" checked={!!sCod.enabled} onChange={(e) => setSCod({ ...sCod, enabled: e.target.checked })} className="h-5 w-5" />
              </div>
            </div>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-ff-border px-4 py-2 text-[13.5px] font-bold"
          >
            Затвори
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-xl bg-ff-green-700 px-4 py-2 text-[13.5px] font-bold text-white disabled:opacity-60"
          >
            {saving ? 'Запазвам…' : 'Запази'}
          </button>
        </div>
      </div>
    </div>
  );
}
