'use client';

import * as React from 'react';
import { RefreshCw, Loader2, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { Button } from '@/components/ui/button';
import {
  saveSpeedyCredentials,
  listSpeedySites,
  listSpeedyOffices,
  ApiError,
} from '@/lib/api-client';
import type { DeliveryConfig, SpeedyConfig, SpeedySite, SpeedyOffice } from '@/lib/types';
import { DSection, DLabel, Segmented, DBadge, Divider, Collapsible, fieldCls, subHeadCls, subDescCls } from './ui';

type Mut = (fn: (d: DeliveryConfig) => void) => void;
type Toast = { success: (m: string) => void; info?: (m: string) => void; error: (m: string) => void };

/** Parse a numeric form field; empty → undefined (so we don't store 0/NaN). */
const num = (v: string): number | undefined => {
  const n = parseInt(v.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Speedy — the second courier. Mirrors the Econt section but Speedy has no
 * demo/auto distinction (it's connected-or-not) and addresses are id-based
 * (settlement + office/street). Credentials are saved to the server immediately
 * (password encrypted); the sender/package/COD profile rides the normal delivery
 * save and is protected from clobbering the stored secret server-side.
 */
export function SpeedyConnectionSection({
  cfg,
  mut,
  toast,
}: {
  cfg: DeliveryConfig;
  mut: Mut;
  toast: Toast;
}) {
  const s: SpeedyConfig = cfg.speedy ?? {};
  const sender = s.sender ?? {};
  const pkg = s.defaultPackage ?? {};
  const cod = s.cod ?? {};
  const configured = !!s.configured;

  const [check, setCheck] = React.useState<'idle' | 'loading' | 'ok' | 'fail'>('idle');
  const [pwChanging, setPwChanging] = React.useState(!configured);
  const [pw, setPw] = React.useState('');

  // Ensure the speedy blob + the nested object we touch exist before mutating.
  const patch = (fn: (sp: SpeedyConfig) => void) =>
    mut((d) => {
      d.speedy ??= {};
      fn(d.speedy);
    });

  // Live offices for the sender's settlement (loaded once Speedy is connected).
  const [senderOffices, setSenderOffices] = React.useState<SpeedyOffice[]>([]);
  const [loadingOffices, setLoadingOffices] = React.useState(false);

  React.useEffect(() => {
    if (!configured || !sender.siteId) {
      setSenderOffices([]);
      return;
    }
    let active = true;
    setLoadingOffices(true);
    listSpeedyOffices(sender.siteId)
      .then((r) => active && setSenderOffices(r))
      .catch(() => active && setSenderOffices([]))
      .finally(() => active && setLoadingOffices(false));
    return () => {
      active = false;
    };
  }, [configured, sender.siteId]);

  const runCheck = async () => {
    if (configured && !pwChanging) {
      setCheck('ok');
      toast.success('Speedy вече е свързан');
      return;
    }
    if (!s.userName || pw.length < 3) {
      setCheck('fail');
      toast.error('Въведи потребител и парола за Speedy');
      return;
    }
    setCheck('loading');
    try {
      await saveSpeedyCredentials({
        env: 'prod',
        userName: s.userName,
        password: pw,
        clientSystemId: s.clientSystemId,
        defaultServiceId: s.defaultServiceId,
      });
      setCheck('ok');
      setPwChanging(false);
      setPw('');
      patch((sp) => {
        sp.configured = true;
        sp.env = 'prod';
      });
      toast.success('Връзката със Speedy е успешна и запазена');
    } catch (err) {
      setCheck('fail');
      toast.error(err instanceof ApiError ? err.message : 'Невалидни данни за Speedy');
    }
  };

  const headerBadge =
    check === 'ok' || (configured && check !== 'fail') ? (
      <DBadge tone="green">Свързано</DBadge>
    ) : check === 'fail' ? (
      <DBadge tone="red">Грешка</DBadge>
    ) : (
      <DBadge tone="gray">Непроверено</DBadge>
    );

  return (
    <DSection
      title="Speedy (втори куриер)"
      helper="По желание — свържи и Speedy, за да сравняваш цени и да даваш на клиента избор между двата куриера."
      action={headerBadge}
      info={
        <>
          <b>Speedy</b> е втори куриер до офис или до адрес. Свържи акаунта си веднъж, попълни подателя
          и системата прави товарителниците. Ако и <b>Еконт</b> е свързан, клиентът вижда по-евтиния
          (или ти избираш кой куриер да пуска поръчките — в „Когато и двата куриера са включени“).
        </>
      }
    >
      <div className="flex flex-col gap-[18px]">
        <div className="flex items-start gap-2.5 rounded-[10px] border border-ff-border-2 bg-ff-surface-2 px-3.5 py-3 text-[13px] text-ff-ink-2">
          <span className="mt-px shrink-0 rounded-full bg-ff-badge-bg px-2 py-0.5 text-[11px] font-extrabold text-ff-badge-ink">
            по желание
          </span>
          <span>
            Speedy не е задължителен. Можеш да работиш само с Еконт, само с лична доставка, или с двата
            куриера едновременно.
          </span>
        </div>

        {/* 1 — credentials */}
        <div>
          <h3 className={subHeadCls}>1. Свържи акаунта си в Speedy</h3>
          <p className={subDescCls}>
            Потребител и парола за <b>Speedy API</b> (от договора ти със Speedy). Различни са от логина
            за speedy.bg. Нямаш ли достъп до API, поискай го от Speedy.
          </p>
          <div className="grid items-end gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            <DLabel label="Потребител за Speedy">
              <input
                value={s.userName ?? ''}
                placeholder="напр. 1234567"
                onChange={(ev) => patch((sp) => (sp.userName = ev.target.value))}
                className={fieldCls}
              />
            </DLabel>
            <DLabel label="Парола за Speedy">
              {configured && !pwChanging ? (
                <div className="flex items-center gap-2.5">
                  <span className={cn(fieldCls, 'flex flex-1 items-center text-ff-muted')}>
                    •••••••• (запазена)
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPwChanging(true);
                      setPw('');
                    }}
                  >
                    Смени
                  </Button>
                </div>
              ) : (
                <input
                  type="password"
                  value={pw}
                  placeholder="••••••••"
                  onChange={(ev) => setPw(ev.target.value)}
                  className={fieldCls}
                />
              )}
            </DLabel>
          </div>
          <div className="mt-3.5 flex items-center">
            <Button variant="outline" size="sm" onClick={runCheck} disabled={check === 'loading'}>
              {check === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              {check === 'loading' ? 'Проверка…' : 'Провери връзката'}
            </Button>
            {check === 'ok' && (
              <span className="ml-3 text-[13px] font-bold text-ff-green-700">Връзката е успешна</span>
            )}
            {check === 'fail' && <span className="ml-3 text-[13px] font-bold text-ff-red">Невалидни данни</span>}
          </div>
        </div>

        <Divider />

        {/* 2 — sender profile */}
        <div>
          <h3 className={subHeadCls}>2. Профил на подател (фермата)</h3>
          <p className={subDescCls}>Оттук тръгват пратките. Попълва се автоматично във всяка товарителница.</p>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            <DLabel label="Име/контакт на подател">
              <input
                value={sender.contactName ?? ''}
                onChange={(ev) => patch((sp) => ((sp.sender ??= {}).contactName = ev.target.value))}
                className={fieldCls}
              />
            </DLabel>
            <DLabel label="Телефон">
              <input
                value={sender.phone ?? ''}
                onChange={(ev) => patch((sp) => ((sp.sender ??= {}).phone = ev.target.value))}
                className={fieldCls}
              />
            </DLabel>
            <DLabel label="Населено място" hint="На живо от Speedy.">
              <SiteAutocomplete
                value={sender.siteName ?? ''}
                disabled={!configured}
                notReadyHint="Първо свържи Speedy акаунта по-горе."
                onPick={(site) =>
                  patch((sp) => {
                    sp.sender ??= {};
                    sp.sender.siteId = site.id;
                    sp.sender.siteName = site.name;
                    sp.sender.officeId = undefined; // belonged to the old settlement
                  })
                }
              />
            </DLabel>
          </div>

          <div className="mt-3.5">
            <DLabel label="Подаване">
              <Segmented
                value={sender.mode === 'address' ? 'address' : 'office'}
                onChange={(v) => patch((sp) => ((sp.sender ??= {}).mode = v))}
                options={[
                  { value: 'office', label: 'От офис' },
                  { value: 'address', label: 'От адрес' },
                ]}
              />
            </DLabel>
            <div className="mt-3 max-w-[460px]">
              {sender.mode === 'address' ? (
                <DLabel label="Улица и номер на подаване">
                  <input
                    value={sender.streetNo ?? ''}
                    placeholder="ул., №"
                    onChange={(ev) => patch((sp) => ((sp.sender ??= {}).streetNo = ev.target.value))}
                    className={fieldCls}
                  />
                </DLabel>
              ) : (
                <DLabel label="Офис на подаване">
                  {!configured ? (
                    <div className={cn(fieldCls, 'flex items-center text-ff-muted')}>
                      Свържи Speedy, за да избереш офис
                    </div>
                  ) : loadingOffices ? (
                    <div className={cn(fieldCls, 'flex items-center text-ff-muted')}>Зареждане…</div>
                  ) : senderOffices.length === 0 ? (
                    <div className={cn(fieldCls, 'flex items-center text-ff-muted')}>
                      {sender.siteName ? `Няма офиси в „${sender.siteName}“` : 'Първо избери населено място'}
                    </div>
                  ) : (
                    <select
                      value={sender.officeId ?? ''}
                      onChange={(ev) => patch((sp) => ((sp.sender ??= {}).officeId = num(ev.target.value)))}
                      className={cn(fieldCls, 'cursor-pointer appearance-none')}
                    >
                      <option value="" disabled>
                        Избери офис…
                      </option>
                      {senderOffices.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                          {o.address ? ` — ${o.address}` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </DLabel>
              )}
            </div>
          </div>
        </div>

        <Divider />

        {/* 3 — default package + COD */}
        <div>
          <h3 className={subHeadCls}>3. Пакет и плащане</h3>
          <p className={subDescCls}>Стандартното тегло на пратките ти и дали клиентът плаща при доставка.</p>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            <DLabel label="Тегло по подразбиране (кг)">
              <input
                value={pkg.weightKg ?? ''}
                inputMode="decimal"
                onChange={(ev) =>
                  patch((sp) => ((sp.defaultPackage ??= {}).weightKg = parseFloat(ev.target.value) || 0))
                }
                className={fieldCls}
              />
            </DLabel>
            <DLabel label="Брой пакети">
              <input
                value={pkg.parcelsCount ?? ''}
                inputMode="numeric"
                placeholder="1"
                onChange={(ev) => patch((sp) => ((sp.defaultPackage ??= {}).parcelsCount = num(ev.target.value)))}
                className={fieldCls}
              />
            </DLabel>
            <DLabel label="Описание на съдържанието">
              <input
                value={pkg.contents ?? ''}
                onChange={(ev) => patch((sp) => ((sp.defaultPackage ??= {}).contents = ev.target.value))}
                className={fieldCls}
              />
            </DLabel>
          </div>

          <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-ff-border bg-ff-surface-2 px-3.5 py-3">
            <div>
              <div className="text-[14px] font-bold text-ff-ink">Наложен платеж</div>
              <div className="mt-px text-[12px] text-ff-muted">Клиентът плаща в момента на доставката.</div>
            </div>
            <div className="flex items-center gap-4">
              {cod.enabled && (
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-bold text-ff-ink-2">Превод:</span>
                  <Segmented
                    value={cod.processingType === 'POSTAL_MONEY_TRANSFER' ? 'POSTAL_MONEY_TRANSFER' : 'CASH'}
                    onChange={(v) => patch((sp) => ((sp.cod ??= {}).processingType = v))}
                    options={[
                      { value: 'CASH', label: 'В брой' },
                      { value: 'POSTAL_MONEY_TRANSFER', label: 'Пощенски' },
                    ]}
                  />
                </div>
              )}
              <ToggleSwitch checked={!!cod.enabled} onChange={(v) => patch((sp) => ((sp.cod ??= {}).enabled = v))} />
            </div>
          </div>
        </div>

        {/* advanced — grouped, collapsed by default */}
        <Collapsible
          title="Разширени настройки"
          hint="Код на услугата, system id, авто-създаване. Стандартните стойности работят за повечето ферми."
        >
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            <DLabel label="Код на услуга (serviceId)" hint="Обичайната ти куриерска услуга в Speedy.">
              <input
                value={s.defaultServiceId ?? ''}
                inputMode="numeric"
                placeholder="напр. 505"
                onChange={(ev) => patch((sp) => (sp.defaultServiceId = num(ev.target.value)))}
                className={fieldCls}
              />
            </DLabel>
            <DLabel label="Client system id (опц.)">
              <input
                value={s.clientSystemId ?? ''}
                inputMode="numeric"
                onChange={(ev) => patch((sp) => (sp.clientSystemId = num(ev.target.value)))}
                className={fieldCls}
              />
            </DLabel>
          </div>
          <div className="mt-3.5 flex items-center justify-between rounded-[10px] border border-ff-border bg-ff-surface-2 px-3.5 py-3">
            <div>
              <div className="text-[14px] font-bold text-ff-ink">Авто-товарителница</div>
              <div className="mt-px text-[12px] text-ff-muted">Създавай автоматично при платена поръчка.</div>
            </div>
            <ToggleSwitch
              checked={s.label?.autoCreate ?? true}
              onChange={(v) => patch((sp) => ((sp.label ??= {}).autoCreate = v))}
            />
          </div>
        </Collapsible>
      </div>
    </DSection>
  );
}

/**
 * Carrier policy — only meaningful when the farm runs BOTH carriers live (Econt
 * auto + Speedy configured). Picks who wins a до-адрес order: the customer, the
 * cheaper quote, or a forced carrier. Hidden otherwise so it's never a dead control.
 */
export function CarrierPolicySection({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  const policy = cfg.carrierPolicy ?? 'customer';
  return (
    <DSection
      title="Когато и двата куриера са включени"
      helper="И Еконт, и Speedy са свързани — избери кой обслужва поръчките до адрес."
      info={
        <>
          „По избор на клиента“ показва на клиента двата куриера и той избира. „По-евтиния“ смята
          цените на двата и пуска по-изгодния. Или фиксираш един куриер за всички поръчки.
        </>
      }
    >
      <Segmented
        value={policy}
        onChange={(v) => mut((d) => (d.carrierPolicy = v))}
        options={[
          { value: 'customer', label: 'По избор на клиента' },
          { value: 'cheapest', label: 'По-евтиния' },
          { value: 'econt', label: 'Само Еконт' },
          { value: 'speedy', label: 'Само Speedy' },
        ]}
      />
    </DSection>
  );
}

/**
 * Settlement (нас. място) autocomplete backed by live Speedy nomenclature. Parallels
 * `CityAutocomplete` (Econt) but hits `listSpeedySites`. When `disabled` (Speedy not
 * connected) it shows `notReadyHint` instead of searching.
 */
function SiteAutocomplete({
  value,
  placeholder = 'Търси населено място…',
  disabled,
  notReadyHint,
  onPick,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  notReadyHint?: string;
  onPick: (site: SpeedySite) => void;
}) {
  const [q, setQ] = React.useState(value);
  const [open, setOpen] = React.useState(false);
  const [list, setList] = React.useState<SpeedySite[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => setQ(value), [value]);

  React.useEffect(() => {
    if (!open || disabled) return;
    let active = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      listSpeedySites(q)
        .then((r) => active && setList(r))
        .catch(() => active && setList([]))
        .finally(() => active && setLoading(false));
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(t);
    };
  }, [q, open, disabled]);

  return (
    <div className="relative">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ff-muted" />
      <input
        value={q}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 160)}
        className={cn(fieldCls, 'pl-9 disabled:cursor-not-allowed disabled:opacity-60')}
      />
      {open && !disabled && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-[240px] overflow-y-auto rounded-[9px] border border-ff-border bg-ff-surface shadow-ff-md">
          {loading ? (
            <div className="px-3.5 py-3 text-[12.5px] text-ff-muted">Търсене…</div>
          ) : list.length === 0 ? (
            <div className="px-3.5 py-3 text-[12.5px] text-ff-muted">
              Няма населени места{q ? ` за „${q}“` : ''}.
            </div>
          ) : (
            list.map((site) => (
              <button
                key={site.id}
                type="button"
                onMouseDown={() => {
                  onPick(site);
                  setQ(site.name);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left hover:bg-ff-green-50"
              >
                <span className="text-[14px] font-semibold text-ff-ink">{site.name}</span>
                {site.postCode && <span className="ff-fig text-[12px] text-ff-muted">{site.postCode}</span>}
              </button>
            ))
          )}
        </div>
      )}
      {open && disabled && notReadyHint && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 rounded-[9px] border border-ff-border bg-ff-surface px-3.5 py-3 text-[12.5px] text-ff-muted shadow-ff-md">
          {notReadyHint}
        </div>
      )}
    </div>
  );
}
