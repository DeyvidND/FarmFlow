'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Search, Pencil, Trash2, CheckCircle2 } from 'lucide-react';
import {
  ApiError,
  getEcontConfig, getSpeedyConfig,
  saveEcontProfile, saveSpeedyProfile,
  saveEcontSenders, saveSpeedySenders,
  listEcontCities, listEcontOffices,
  listSpeedySites, listSpeedyOffices,
  type EcontPickupPoint, type SpeedyPickupPoint,
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
 * Pickup-point list manager. Shows all saved sender points for a carrier;
 * lets the user activate, edit, delete, or add points — then saves the whole
 * book via saveEcontSenders / saveSpeedySenders. Package + COD stay per-farm
 * under „Разширени" and are saved via the existing saveEcontProfile / saveSpeedyProfile.
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

  // ── List state ───────────────────────────────────────────────────────────
  type EPoint = EcontPickupPoint;
  type SPoint = SpeedyPickupPoint;
  const [ePoints, setEPoints] = useState<EPoint[]>([]);
  const [sPoints, setSPoints] = useState<SPoint[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);

  // ── Configured flag ──────────────────────────────────────────────────────
  const [eConfigured, setEConfigured] = useState(false);
  const [sConfigured, setSConfigured] = useState(false);

  // ── Package + COD (farm-level) ───────────────────────────────────────────
  const [ePkg, setEPkg] = useState<{ weightKg?: number; contents?: string }>({});
  const [eCod, setECod] = useState<{ enabled?: boolean; feePayer?: 'customer' | 'farm' }>({ enabled: true, feePayer: 'customer' });
  const [sPkg, setSPkg] = useState<{ parcelsCount?: number; weightKg?: number; contents?: string }>({});
  const [sCod, setSCod] = useState<{ enabled?: boolean; processingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER' }>({ enabled: true, processingType: 'CASH' });

  // ── Office lists (keyed to the currently-editing point) ─────────────────
  const [eOffices, setEOffices] = useState<EcontOfficeLive[]>([]);
  const [sOffices, setSOffices] = useState<SpeedyOffice[]>([]);

  const [saving, setSaving] = useState(false);

  // ── Helpers ──────────────────────────────────────────────────────────────
  const ePoint = ePoints.find((p) => p.id === editingId);
  const sPoint = sPoints.find((p) => p.id === editingId);

  const updateEPoint = useCallback((patch: Partial<EPoint>) => {
    setEPoints((ps) => ps.map((p) => (p.id === editingId ? { ...p, ...patch } : p)));
  }, [editingId]);

  const updateSPoint = useCallback((patch: Partial<SPoint>) => {
    setSPoints((ps) => ps.map((p) => (p.id === editingId ? { ...p, ...patch } : p)));
  }, [editingId]);

  // ── Load on open ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setEditingId(null);
    setAdvanced(false);
    if (carrier === 'econt') {
      getEcontConfig().then((c) => {
        setEConfigured(!!c.configured);
        const pts = (c.senders ?? (c.sender ? [{ id: 'p1', label: 'Основна', mode: 'office' as const, ...c.sender }] : [])) as EPoint[];
        setEPoints(pts);
        setActiveId(c.activeSenderId ?? pts[0]?.id ?? '');
        if (c.defaultPackage) setEPkg({ weightKg: c.defaultPackage.weightKg, contents: c.defaultPackage.contents });
        if (c.cod) setECod({ enabled: c.cod.enabled ?? true, feePayer: c.cod.feePayer ?? 'customer' });
      }).catch((e) => toast.error(`Econt: ${errMsg(e)}`));
    } else {
      getSpeedyConfig().then((c) => {
        setSConfigured(!!c.configured);
        const pts = (c.senders ?? (c.sender ? [{ id: 'p1', label: 'Основна', mode: 'office' as const, ...c.sender }] : [])) as SPoint[];
        setSPoints(pts);
        setActiveId(c.activeSenderId ?? pts[0]?.id ?? '');
        if (c.defaultPackage) setSPkg({ parcelsCount: c.defaultPackage.parcelsCount, weightKg: c.defaultPackage.weightKg, contents: c.defaultPackage.contents });
        if (c.cod) setSCod({ enabled: c.cod.enabled ?? true, processingType: c.cod.processingType ?? 'CASH' });
      }).catch((e) => toast.error(`Speedy: ${errMsg(e)}`));
    }
  }, [open, carrier]);

  // ── Office fetch — Econt — keyed to editing point's cityId ───────────────
  useEffect(() => {
    if (carrier !== 'econt' || !eConfigured || !ePoint?.cityId) { setEOffices([]); return; }
    let active = true;
    listEcontOffices(ePoint.cityId).then((r) => active && setEOffices(r)).catch(() => active && setEOffices([]));
    return () => { active = false; };
  }, [carrier, eConfigured, ePoint?.cityId]);

  // ── Office fetch — Speedy — keyed to editing point's siteId ──────────────
  useEffect(() => {
    if (carrier !== 'speedy' || !sConfigured || !sPoint?.siteId) { setSOffices([]); return; }
    let active = true;
    listSpeedyOffices(sPoint.siteId).then((r) => active && setSOffices(r)).catch(() => active && setSOffices([]));
    return () => { active = false; };
  }, [carrier, sConfigured, sPoint?.siteId]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const addPoint = () => {
    const id = crypto.randomUUID().slice(0, 8);
    if (carrier === 'econt') {
      const np: EPoint = { id, label: 'Нова точка', mode: 'office' };
      setEPoints((ps) => [...ps, np]);
    } else {
      const np: SPoint = { id, label: 'Нова точка', mode: 'office' };
      setSPoints((ps) => [...ps, np]);
    }
    setEditingId(id);
  };

  const deletePoint = (id: string) => {
    if (carrier === 'econt') {
      const next = ePoints.filter((p) => p.id !== id);
      setEPoints(next);
      if (activeId === id) setActiveId(next[0]?.id ?? '');
    } else {
      const next = sPoints.filter((p) => p.id !== id);
      setSPoints(next);
      if (activeId === id) setActiveId(next[0]?.id ?? '');
    }
    if (editingId === id) setEditingId(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (carrier === 'econt') {
        await saveEcontSenders({ senders: ePoints, activeId });
        await saveEcontProfile({ defaultPackage: { weightKg: ePkg.weightKg, contents: ePkg.contents }, cod: eCod });
      } else {
        await saveSpeedySenders({ senders: sPoints, activeId });
        await saveSpeedyProfile({ defaultPackage: sPkg, cod: sCod });
      }
      toast.success('Точките са запазени');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const isEcont = carrier === 'econt';
  const points = isEcont ? ePoints : sPoints;
  const configured = isEcont ? eConfigured : sConfigured;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-[580px] max-h-[90vh] overflow-y-auto rounded-2xl bg-ff-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-[18px] font-extrabold">
          Точки на подаване — {isEcont ? 'Еконт' : 'Speedy'}
        </h2>
        <p className="mt-1 text-[13px] text-ff-muted">
          Управлявай адресите, от които подаваш пратки. Активната точка влиза автоматично в товарителниците.
        </p>

        {/* ── Point list ── */}
        <div className="mt-4 space-y-2">
          {points.length === 0 && (
            <p className="text-[13px] text-ff-muted">Няма добавени точки. Добави поне една.</p>
          )}
          {points.map((pt) => {
            const isActive = pt.id === activeId;
            const isEditing = pt.id === editingId;
            const nameDisplay = isEcont
              ? (pt as EPoint).name
              : (pt as SPoint).contactName;
            const officeDisplay = isEcont
              ? ((pt as EPoint).officeCode ? `офис ${(pt as EPoint).officeCode}` : '')
              : ((pt as SPoint).officeId != null ? `офис ${(pt as SPoint).officeId}` : '');
            const cityDisplay = isEcont
              ? ((pt as EPoint).cityName ?? '')
              : ((pt as SPoint).siteName ?? '');
            const place = officeDisplay || cityDisplay;

            return (
              <div key={pt.id} className="rounded-xl border border-ff-border bg-ff-surface-2">
                {/* Row header */}
                <div className="flex items-center gap-2 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-bold text-ff-ink">{pt.label}</span>
                      {isActive && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-ff-green-100 px-2 py-0.5 text-[11.5px] font-bold text-ff-green-800">
                          <CheckCircle2 size={11} /> Активна
                        </span>
                      )}
                    </div>
                    {(nameDisplay || place) && (
                      <div className="text-[12.5px] text-ff-muted">
                        {nameDisplay}{nameDisplay && place ? ' · ' : ''}{place}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!isActive && (
                      <button type="button" onClick={() => setActiveId(pt.id)}
                        className="rounded-lg border border-ff-border px-2.5 py-1 text-[12px] font-bold text-ff-ink-2 hover:text-ff-ink">
                        Избери
                      </button>
                    )}
                    <button type="button" onClick={() => setEditingId(isEditing ? null : pt.id)}
                      className={cn('rounded-lg border px-2.5 py-1 text-[12px] font-bold transition-colors',
                        isEditing ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-800' : 'border-ff-border text-ff-ink-2 hover:text-ff-ink')}>
                      <Pencil size={13} />
                    </button>
                    <button type="button" onClick={() => deletePoint(pt.id)} disabled={points.length <= 1}
                      className="rounded-lg border border-ff-border px-2.5 py-1 text-[12px] font-bold text-ff-amber-600 hover:text-ff-amber-700 disabled:cursor-not-allowed disabled:opacity-40">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {/* Inline editor */}
                {isEditing && (
                  <div className="border-t border-ff-border px-3.5 pb-3.5 pt-3 space-y-3">
                    {/* Label */}
                    <div>
                      <label className={lbl}>Име на точката</label>
                      <input className={inp} value={pt.label}
                        onChange={(e) => {
                          if (isEcont) updateEPoint({ label: e.target.value });
                          else updateSPoint({ label: e.target.value });
                        }} />
                    </div>

                    {/* ── Econt fields ── */}
                    {isEcont && (() => {
                      const ep = pt as EPoint;
                      return (
                        <>
                          {!configured && (
                            <p className="text-[12.5px] text-ff-amber-600">
                              Свържи Econt акаунта в „Куриерски акаунти", за да избираш град и офис на живо.
                            </p>
                          )}
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <label className={lbl}>Име на подател</label>
                              <input className={inp} value={ep.name ?? ''} onChange={(e) => updateEPoint({ name: e.target.value })} />
                            </div>
                            <div>
                              <label className={lbl}>Телефон</label>
                              <input className={inp} value={ep.phone ?? ''} onChange={(e) => updateEPoint({ phone: e.target.value })} />
                            </div>
                          </div>
                          <div>
                            <label className={lbl}>Град</label>
                            <Autocomplete
                              value={ep.cityName ?? ''} disabled={!configured}
                              notReadyHint="Първо свържи Econt акаунта."
                              search={listEcontCities}
                              onPick={(c) => updateEPoint({ cityId: c.id, cityName: c.name, officeCode: undefined })}
                            />
                          </div>
                          <div>
                            <label className={lbl}>Подаване</label>
                            <Seg
                              value={ep.mode === 'address' ? 'address' : 'office'}
                              onChange={(v) => updateEPoint({ mode: v })}
                              options={[{ value: 'office', label: 'От офис' }, { value: 'address', label: 'От адрес' }]}
                            />
                          </div>
                          {ep.mode === 'address' ? (
                            <div>
                              <label className={lbl}>Адрес на подаване</label>
                              <input className={inp} value={ep.address ?? ''} onChange={(e) => updateEPoint({ address: e.target.value })} />
                            </div>
                          ) : (
                            <div>
                              <label className={lbl}>Офис на подаване</label>
                              {!configured
                                ? <div className={cn(inp, 'flex items-center text-ff-muted')}>Свържи Econt</div>
                                : eOffices.length === 0
                                  ? <div className={cn(inp, 'flex items-center text-ff-muted')}>{ep.cityName ? `Няма офиси в „${ep.cityName}"` : 'Първо избери град'}</div>
                                  : (
                                    <select className={cn(inp, 'cursor-pointer')} value={ep.officeCode ?? ''}
                                      onChange={(e) => updateEPoint({ officeCode: e.target.value })}>
                                      <option value="" disabled>Избери офис…</option>
                                      {eOffices.map((o) => <option key={o.code} value={o.code}>{o.name}{o.address ? ` — ${o.address}` : ''}</option>)}
                                    </select>
                                  )}
                            </div>
                          )}
                        </>
                      );
                    })()}

                    {/* ── Speedy fields ── */}
                    {!isEcont && (() => {
                      const sp = pt as SPoint;
                      return (
                        <>
                          {!configured && (
                            <p className="text-[12.5px] text-ff-amber-600">
                              Свържи Speedy акаунта в „Куриерски акаунти", за да избираш населено място и офис на живо.
                            </p>
                          )}
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <label className={lbl}>Име/контакт на подател</label>
                              <input className={inp} value={sp.contactName ?? ''} onChange={(e) => updateSPoint({ contactName: e.target.value })} />
                            </div>
                            <div>
                              <label className={lbl}>Телефон</label>
                              <input className={inp} value={sp.phone ?? ''} onChange={(e) => updateSPoint({ phone: e.target.value })} />
                            </div>
                          </div>
                          <div>
                            <label className={lbl}>Населено място</label>
                            <Autocomplete
                              value={sp.siteName ?? ''} disabled={!configured}
                              notReadyHint="Първо свържи Speedy акаунта."
                              search={listSpeedySites}
                              onPick={(s) => updateSPoint({ siteId: s.id, siteName: s.name, officeId: undefined })}
                            />
                          </div>
                          <div>
                            <label className={lbl}>Подаване</label>
                            <Seg
                              value={sp.mode === 'address' ? 'address' : 'office'}
                              onChange={(v) => updateSPoint({ mode: v })}
                              options={[{ value: 'office', label: 'От офис' }, { value: 'address', label: 'От адрес' }]}
                            />
                          </div>
                          {sp.mode === 'address' ? (
                            <div>
                              <label className={lbl}>Улица и номер</label>
                              <input className={inp} value={sp.streetNo ?? ''} onChange={(e) => updateSPoint({ streetNo: e.target.value })} />
                            </div>
                          ) : (
                            <div>
                              <label className={lbl}>Офис на подаване</label>
                              {!configured
                                ? <div className={cn(inp, 'flex items-center text-ff-muted')}>Свържи Speedy</div>
                                : sOffices.length === 0
                                  ? <div className={cn(inp, 'flex items-center text-ff-muted')}>{sp.siteName ? `Няма офиси в „${sp.siteName}"` : 'Първо избери населено място'}</div>
                                  : (
                                    <select className={cn(inp, 'cursor-pointer')} value={sp.officeId ?? ''}
                                      onChange={(e) => updateSPoint({ officeId: parseInt(e.target.value, 10) || undefined })}>
                                      <option value="" disabled>Избери офис…</option>
                                      {sOffices.map((o) => <option key={o.id} value={o.id}>{o.name}{o.address ? ` — ${o.address}` : ''}</option>)}
                                    </select>
                                  )}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })}

          {/* Add point button */}
          <button type="button" onClick={addPoint}
            className="mt-1 text-[13px] font-bold text-ff-green-700 hover:underline">
            + Добави точка
          </button>
        </div>

        {/* ── Advanced (package + COD, farm-level) ── */}
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="mt-4 text-[13px] font-bold text-ff-green-700"
        >
          {advanced ? '− Скрий разширени' : '+ Разширени (пакет, наложен платеж)'}
        </button>

        {advanced && isEcont && (
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

        {advanced && !isEcont && (
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
