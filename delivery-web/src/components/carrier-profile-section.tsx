'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Truck, Zap, Search } from 'lucide-react';
import {
  ApiError, getEcontConfig, getSpeedyConfig, saveEcontProfile, saveSpeedyProfile,
  listEcontCities, listEcontOffices, listSpeedySites, listSpeedyOffices,
  type EcontConfig, type SpeedyConfig, type EcontSender, type SpeedySender,
  type EcontCity, type EcontOfficeLive, type SpeedySite, type SpeedyOffice,
} from '@/lib/api-client';
import { cn } from '@/lib/utils';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const inp = 'h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3.5 text-[14px] outline-none focus:border-ff-green-500';
const lbl = 'mb-1 block text-[12.5px] font-bold text-ff-muted';
const card = 'rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-5 shadow-ff-sm';
const btn = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60';

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
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

/** Settlement/town autocomplete over a live nomenclature search. */
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

function EcontProfileCard() {
  const [cfg, setCfg] = useState<EcontConfig | null>(null);
  const [sender, setSender] = useState<EcontSender>({ mode: 'office' });
  const [pkg, setPkg] = useState<{ weightKg?: number; contents?: string }>({});
  const [cod, setCod] = useState<{ enabled?: boolean; feePayer?: 'customer' | 'farm' }>({ enabled: true, feePayer: 'customer' });
  const [offices, setOffices] = useState<EcontOfficeLive[]>([]);
  const [saving, setSaving] = useState(false);
  const configured = !!cfg?.configured;

  useEffect(() => {
    getEcontConfig().then((c) => {
      setCfg(c);
      if (c.sender) setSender({ mode: 'office', ...c.sender });
      if (c.defaultPackage) setPkg({ weightKg: c.defaultPackage.weightKg, contents: c.defaultPackage.contents });
      if (c.cod) setCod({ enabled: c.cod.enabled ?? true, feePayer: c.cod.feePayer ?? 'customer' });
    }).catch((e) => toast.error(`Econt: ${errMsg(e)}`));
  }, []);

  useEffect(() => {
    if (!configured || !sender.cityId) { setOffices([]); return; }
    let active = true;
    listEcontOffices(sender.cityId).then((r) => active && setOffices(r)).catch(() => active && setOffices([]));
    return () => { active = false; };
  }, [configured, sender.cityId]);

  const save = async () => {
    setSaving(true);
    try {
      await saveEcontProfile({ sender, defaultPackage: { weightKg: pkg.weightKg, contents: pkg.contents }, cod });
      toast.success('Профилът на Econt е запазен');
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };

  return (
    <div className={card}>
      <div className="mb-4 flex items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-[10px] bg-ff-green-50 text-ff-green-700"><Truck size={19} /></div>
        <h2 className="font-display text-[18px] font-extrabold">Econt — подател</h2>
      </div>
      {!configured && <p className="mb-3 text-[12.5px] text-ff-amber-600">Свържи Econt акаунта в „Куриерски акаунти“, за да избираш град и офис на живо.</p>}
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className={lbl}>Име на подател</label><input className={inp} value={sender.name ?? ''} onChange={(e) => setSender({ ...sender, name: e.target.value })} /></div>
          <div><label className={lbl}>Телефон</label><input className={inp} value={sender.phone ?? ''} onChange={(e) => setSender({ ...sender, phone: e.target.value })} /></div>
        </div>
        <div>
          <label className={lbl}>Град</label>
          <Autocomplete value={sender.cityName ?? ''} disabled={!configured} notReadyHint="Първо свържи Econt акаунта."
            search={listEcontCities}
            onPick={(c) => setSender({ ...sender, cityId: c.id, cityName: c.name, officeCode: undefined })} />
        </div>
        <div>
          <label className={lbl}>Подаване</label>
          <Seg value={sender.mode === 'address' ? 'address' : 'office'} onChange={(v) => setSender({ ...sender, mode: v })}
            options={[{ value: 'office', label: 'От офис' }, { value: 'address', label: 'От адрес' }]} />
        </div>
        {sender.mode === 'address' ? (
          <div><label className={lbl}>Адрес на подаване</label><input className={inp} value={sender.address ?? ''} onChange={(e) => setSender({ ...sender, address: e.target.value })} /></div>
        ) : (
          <div>
            <label className={lbl}>Офис на подаване</label>
            {!configured ? <div className={cn(inp, 'flex items-center text-ff-muted')}>Свържи Econt</div>
              : offices.length === 0 ? <div className={cn(inp, 'flex items-center text-ff-muted')}>{sender.cityName ? `Няма офиси в „${sender.cityName}“` : 'Първо избери град'}</div>
              : (
                <select className={cn(inp, 'cursor-pointer')} value={sender.officeCode ?? ''} onChange={(e) => setSender({ ...sender, officeCode: e.target.value })}>
                  <option value="" disabled>Избери офис…</option>
                  {offices.map((o) => <option key={o.code} value={o.code}>{o.name}{o.address ? ` — ${o.address}` : ''}</option>)}
                </select>
              )}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className={lbl}>Тегло по подразбиране (кг)</label><input className={inp} inputMode="decimal" value={pkg.weightKg ?? ''} onChange={(e) => setPkg({ ...pkg, weightKg: parseFloat(e.target.value) || 0 })} /></div>
          <div><label className={lbl}>Съдържание</label><input className={inp} value={pkg.contents ?? ''} onChange={(e) => setPkg({ ...pkg, contents: e.target.value })} /></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-ff-border bg-ff-surface-2 px-3.5 py-3">
          <span className="text-[13.5px] font-bold text-ff-ink">Наложен платеж</span>
          <div className="flex items-center gap-3">
            {cod.enabled && (
              <Seg value={cod.feePayer ?? 'customer'} onChange={(v) => setCod({ ...cod, feePayer: v })}
                options={[{ value: 'customer', label: 'Клиент' }, { value: 'farm', label: 'Ферма' }]} />
            )}
            <input type="checkbox" checked={!!cod.enabled} onChange={(e) => setCod({ ...cod, enabled: e.target.checked })} className="h-5 w-5" />
          </div>
        </div>
      </div>
      <button type="button" onClick={save} disabled={saving} className={btn + ' mt-4 w-full'}>{saving ? 'Запазвам…' : 'Запази профила'}</button>
    </div>
  );
}

function SpeedyProfileCard() {
  const [cfg, setCfg] = useState<SpeedyConfig | null>(null);
  const [sender, setSender] = useState<SpeedySender>({ mode: 'office' });
  const [pkg, setPkg] = useState<{ parcelsCount?: number; weightKg?: number; contents?: string }>({});
  const [cod, setCod] = useState<{ enabled?: boolean; processingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER' }>({ enabled: true, processingType: 'CASH' });
  const [offices, setOffices] = useState<SpeedyOffice[]>([]);
  const [saving, setSaving] = useState(false);
  const configured = !!cfg?.configured;

  useEffect(() => {
    getSpeedyConfig().then((c) => {
      setCfg(c);
      if (c.sender) setSender({ mode: 'office', ...c.sender });
      if (c.defaultPackage) setPkg({ parcelsCount: c.defaultPackage.parcelsCount, weightKg: c.defaultPackage.weightKg, contents: c.defaultPackage.contents });
      if (c.cod) setCod({ enabled: c.cod.enabled ?? true, processingType: c.cod.processingType ?? 'CASH' });
    }).catch((e) => toast.error(`Speedy: ${errMsg(e)}`));
  }, []);

  useEffect(() => {
    if (!configured || !sender.siteId) { setOffices([]); return; }
    let active = true;
    listSpeedyOffices(sender.siteId).then((r) => active && setOffices(r)).catch(() => active && setOffices([]));
    return () => { active = false; };
  }, [configured, sender.siteId]);

  const save = async () => {
    setSaving(true);
    try {
      await saveSpeedyProfile({ sender, defaultPackage: pkg, cod });
      toast.success('Профилът на Speedy е запазен');
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };

  return (
    <div className={card}>
      <div className="mb-4 flex items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-[10px] bg-ff-amber-softer text-ff-amber-600"><Zap size={19} /></div>
        <h2 className="font-display text-[18px] font-extrabold">Speedy — подател</h2>
      </div>
      {!configured && <p className="mb-3 text-[12.5px] text-ff-amber-600">Свържи Speedy акаунта в „Куриерски акаунти“, за да избираш населено място и офис на живо.</p>}
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className={lbl}>Име/контакт на подател</label><input className={inp} value={sender.contactName ?? ''} onChange={(e) => setSender({ ...sender, contactName: e.target.value })} /></div>
          <div><label className={lbl}>Телефон</label><input className={inp} value={sender.phone ?? ''} onChange={(e) => setSender({ ...sender, phone: e.target.value })} /></div>
        </div>
        <div>
          <label className={lbl}>Населено място</label>
          <Autocomplete value={sender.siteName ?? ''} disabled={!configured} notReadyHint="Първо свържи Speedy акаунта."
            search={listSpeedySites}
            onPick={(s) => setSender({ ...sender, siteId: s.id, siteName: s.name, officeId: undefined })} />
        </div>
        <div>
          <label className={lbl}>Подаване</label>
          <Seg value={sender.mode === 'address' ? 'address' : 'office'} onChange={(v) => setSender({ ...sender, mode: v })}
            options={[{ value: 'office', label: 'От офис' }, { value: 'address', label: 'От адрес' }]} />
        </div>
        {sender.mode === 'address' ? (
          <div><label className={lbl}>Улица и номер</label><input className={inp} value={sender.streetNo ?? ''} onChange={(e) => setSender({ ...sender, streetNo: e.target.value })} /></div>
        ) : (
          <div>
            <label className={lbl}>Офис на подаване</label>
            {!configured ? <div className={cn(inp, 'flex items-center text-ff-muted')}>Свържи Speedy</div>
              : offices.length === 0 ? <div className={cn(inp, 'flex items-center text-ff-muted')}>{sender.siteName ? `Няма офиси в „${sender.siteName}“` : 'Първо избери населено място'}</div>
              : (
                <select className={cn(inp, 'cursor-pointer')} value={sender.officeId ?? ''} onChange={(e) => setSender({ ...sender, officeId: parseInt(e.target.value, 10) || undefined })}>
                  <option value="" disabled>Избери офис…</option>
                  {offices.map((o) => <option key={o.id} value={o.id}>{o.name}{o.address ? ` — ${o.address}` : ''}</option>)}
                </select>
              )}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div><label className={lbl}>Тегло (кг)</label><input className={inp} inputMode="decimal" value={pkg.weightKg ?? ''} onChange={(e) => setPkg({ ...pkg, weightKg: parseFloat(e.target.value) || 0 })} /></div>
          <div><label className={lbl}>Брой пакети</label><input className={inp} inputMode="numeric" value={pkg.parcelsCount ?? ''} onChange={(e) => setPkg({ ...pkg, parcelsCount: parseInt(e.target.value, 10) || undefined })} /></div>
          <div><label className={lbl}>Съдържание</label><input className={inp} value={pkg.contents ?? ''} onChange={(e) => setPkg({ ...pkg, contents: e.target.value })} /></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-ff-border bg-ff-surface-2 px-3.5 py-3">
          <span className="text-[13.5px] font-bold text-ff-ink">Наложен платеж</span>
          <div className="flex items-center gap-3">
            {cod.enabled && (
              <Seg value={cod.processingType === 'POSTAL_MONEY_TRANSFER' ? 'POSTAL_MONEY_TRANSFER' : 'CASH'} onChange={(v) => setCod({ ...cod, processingType: v })}
                options={[{ value: 'CASH', label: 'В брой' }, { value: 'POSTAL_MONEY_TRANSFER', label: 'Пощенски' }]} />
            )}
            <input type="checkbox" checked={!!cod.enabled} onChange={(e) => setCod({ ...cod, enabled: e.target.checked })} className="h-5 w-5" />
          </div>
        </div>
      </div>
      <button type="button" onClick={save} disabled={saving} className={btn + ' mt-4 w-full'}>{saving ? 'Запазвам…' : 'Запази профила'}</button>
    </div>
  );
}

/** Sender / package / COD profile editor for both carriers — the piece moved out of
 *  the farmer panel into dostavki. Credentials live in „Куриерски акаунти“. */
export function CarrierProfileSection() {
  return (
    <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
      <h2 className="text-[16px] font-extrabold">Профил на подател</h2>
      <p className="mt-1 mb-4 text-[13.5px] text-ff-muted">
        Данните на подателя, теглото по подразбиране и наложения платеж — влизат автоматично във всяка товарителница.
      </p>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <EcontProfileCard />
        <SpeedyProfileCard />
      </div>
    </div>
  );
}
