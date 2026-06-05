'use client';

import * as React from 'react';
import { Info, RefreshCw, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { Button } from '@/components/ui/button';
import { ECONT_HELP } from '@/lib/delivery-data';
import {
  saveEcontCredentials,
  syncEcontNomenclature,
  listEcontOffices,
  ApiError,
} from '@/lib/api-client';
import type { DeliveryConfig, EcontOfficeLive } from '@/lib/types';
import {
  DSection,
  DLabel,
  Segmented,
  DBadge,
  Divider,
  Collapsible,
  CityAutocomplete,
  HelpModal,
  fieldCls,
  subHeadCls,
  subDescCls,
} from './ui';

type Mut = (fn: (d: DeliveryConfig) => void) => void;
type Toast = { success: (m: string) => void; info?: (m: string) => void; error: (m: string) => void };

export function EcontConnectionSection({
  cfg,
  mut,
  toast,
}: {
  cfg: DeliveryConfig;
  mut: Mut;
  toast: Toast;
}) {
  const e = cfg.econt;
  const [check, setCheck] = React.useState<'idle' | 'loading' | 'ok' | 'fail'>('idle');
  const [pwChanging, setPwChanging] = React.useState(!e.configured);
  const [pw, setPw] = React.useState('');
  const [help, setHelp] = React.useState(false);

  // Live offices for the sender's town (loaded once Econt is connected).
  const [senderOffices, setSenderOffices] = React.useState<EcontOfficeLive[]>([]);
  const [loadingOffices, setLoadingOffices] = React.useState(false);

  React.useEffect(() => {
    if (!e.configured || !e.sender.cityId) {
      setSenderOffices([]);
      return;
    }
    let active = true;
    setLoadingOffices(true);
    listEcontOffices(e.sender.cityId)
      .then((r) => active && setSenderOffices(r))
      .catch(() => active && setSenderOffices([]))
      .finally(() => active && setLoadingOffices(false));
    return () => {
      active = false;
    };
  }, [e.configured, e.sender.cityId]);

  const runCheck = async () => {
    // Already connected and not changing the password — nothing to re-validate
    // (the server holds the encrypted password).
    if (e.configured && !pwChanging) {
      setCheck('ok');
      toast.success('Еконт вече е свързан');
      return;
    }
    if (!e.username || pw.length < 3) {
      setCheck('fail');
      toast.error('Въведи потребител и парола за Еконт');
      return;
    }
    setCheck('loading');
    try {
      // Validates the credentials live against Econt, then stores them (password
      // encrypted server-side). Flipping `configured` is what makes the storefront
      // offer the Econt delivery options.
      await saveEcontCredentials({ env: e.env, username: e.username, password: pw });
      setCheck('ok');
      setPwChanging(false);
      setPw('');
      mut((d) => {
        d.econt.configured = true;
      });
      toast.success('Връзката с Еконт е успешна и запазена');
    } catch (err) {
      setCheck('fail');
      toast.error(err instanceof ApiError ? err.message : 'Невалидни данни за Еконт');
    }
  };

  const headerBadge =
    check === 'ok' ? (
      <DBadge tone="green">Свързано</DBadge>
    ) : check === 'fail' ? (
      <DBadge tone="red">Грешка</DBadge>
    ) : e.configured ? (
      <DBadge tone="green">Свързано</DBadge>
    ) : (
      <DBadge tone="gray">Непроверено</DBadge>
    );

  const headerActions = (
    <div className="flex items-center gap-2.5">
      <Button variant="ghost" size="sm" onClick={() => setHelp(true)}>
        <Info size={16} /> Обяснения
      </Button>
      {headerBadge}
    </div>
  );

  return (
    <DSection
      title="Еконт (куриерска доставка)"
      helper="Свържи акаунта си в Еконт веднъж — после печаташ товарителници и смяташ цени направо оттук."
      action={headerActions}
      info={
        <>
          <b>Еконт</b> е куриерът. Стъпките са прости: <b>1)</b> свържи акаунта си,{' '}
          <b>2)</b> попълни кой е подателят (фермата), <b>3)</b> включи методите „До офис“ / „До адрес“
          в секция „Методи на доставка“. Не знаеш откъде да започнеш? Натисни „Обяснения“.
        </>
      }
    >
      <div className="flex flex-col gap-[18px]">
        {/* optional — a farm that delivers on its own never needs this */}
        <div className="flex items-start gap-2.5 rounded-[10px] border border-ff-border-2 bg-ff-surface-2 px-3.5 py-3 text-[13px] text-ff-ink-2">
          <span className="mt-px shrink-0 rounded-full bg-ff-badge-bg px-2 py-0.5 text-[11px] font-extrabold text-ff-badge-ink">
            по желание
          </span>
          <span>
            Това е само ако искаш доставка <b>с куриер</b>. Доставяш само сам или клиентът идва да
            си вземе поръчката? Спокойно прескочи Еконт.
          </span>
        </div>

        {/* 1 — credentials */}
        <div>
          <h3 className={subHeadCls}>1. Свържи акаунта си в Еконт</h3>
          <p className={subDescCls}>
            Въведи потребителя и паролата, които Еконт ти е дал за онлайн заявки. Намираш ги в
            профила си на econt.com или в договора — нямаш ли ги, обади се на Еконт.
          </p>
          <div className="grid items-end gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            <DLabel label="Потребител за Еконт" hint="От профила ти в Еконт.">
              <input
                value={e.username ?? ''}
                placeholder="напр. ime_firma"
                onChange={(ev) => mut((d) => (d.econt.username = ev.target.value))}
                className={fieldCls}
              />
            </DLabel>
            <DLabel label="Парола за Еконт">
              {e.configured && !pwChanging ? (
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
          <div className="mt-3.5 max-w-[260px]">
            <DLabel label="Вид акаунт" hint="„Реален“ за истински пратки.">
              <Segmented
                value={e.env}
                onChange={(v) => mut((d) => (d.econt.env = v))}
                options={[
                  { value: 'prod', label: 'Реален' },
                  { value: 'demo', label: 'Тест' },
                ]}
              />
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
          <p className={subDescCls}>
            Оттук тръгват пратките. Попълва се автоматично във всяка товарителница.
          </p>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            <DLabel label="Име на подател">
              <input
                value={e.sender.name}
                onChange={(ev) => mut((d) => (d.econt.sender.name = ev.target.value))}
                className={fieldCls}
              />
            </DLabel>
            <DLabel label="Телефон">
              <input
                value={e.sender.phone}
                onChange={(ev) => mut((d) => (d.econt.sender.phone = ev.target.value))}
                className={fieldCls}
              />
            </DLabel>
            <DLabel label="Град" hint="На живо от Еконт.">
              <CityAutocomplete
                value={e.sender.cityName}
                disabled={!e.configured}
                notReadyHint="Първо свържи Еконт акаунта по-горе."
                onPick={(c) =>
                  mut((d) => {
                    d.econt.sender.cityId = c.id;
                    d.econt.sender.cityName = c.name;
                    d.econt.sender.officeCode = undefined; // belonged to the old town
                  })
                }
              />
            </DLabel>
          </div>

          <div className="mt-3.5">
            <DLabel label="Подаване">
              <Segmented
                value={e.sender.mode}
                onChange={(v) => mut((d) => (d.econt.sender.mode = v))}
                options={[
                  { value: 'office', label: 'От офис' },
                  { value: 'address', label: 'От адрес' },
                ]}
              />
            </DLabel>
            <div className="mt-3 max-w-[460px]">
              {e.sender.mode === 'office' ? (
                <DLabel label="Офис на подаване">
                  {!e.configured ? (
                    <div className={cn(fieldCls, 'flex items-center text-ff-muted')}>
                      Свържи Еконт, за да избереш офис
                    </div>
                  ) : loadingOffices ? (
                    <div className={cn(fieldCls, 'flex items-center text-ff-muted')}>Зареждане…</div>
                  ) : senderOffices.length === 0 ? (
                    <div className={cn(fieldCls, 'flex items-center text-ff-muted')}>
                      Няма офиси в „{e.sender.cityName}“
                    </div>
                  ) : (
                    <select
                      value={e.sender.officeCode ?? ''}
                      onChange={(ev) => mut((d) => (d.econt.sender.officeCode = ev.target.value))}
                      className={cn(fieldCls, 'cursor-pointer appearance-none')}
                    >
                      <option value="" disabled>
                        Избери офис…
                      </option>
                      {senderOffices.map((o) => (
                        <option key={o.code} value={o.code}>
                          {o.name}
                          {o.address ? ` — ${o.address}` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </DLabel>
              ) : (
                <DLabel label="Адрес на подаване">
                  <input
                    value={e.sender.address ?? ''}
                    placeholder="ул., №, град"
                    onChange={(ev) => mut((d) => (d.econt.sender.address = ev.target.value))}
                    className={fieldCls}
                  />
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
                value={e.defaultPackage.weightKg}
                inputMode="decimal"
                onChange={(ev) =>
                  mut((d) => (d.econt.defaultPackage.weightKg = parseFloat(ev.target.value) || 0))
                }
                className={fieldCls}
              />
            </DLabel>
            <DLabel label="Описание на съдържанието">
              <input
                value={e.defaultPackage.contents}
                onChange={(ev) => mut((d) => (d.econt.defaultPackage.contents = ev.target.value))}
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
              {e.cod.enabled && (
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-bold text-ff-ink-2">Таксата плаща:</span>
                  <Segmented
                    value={e.cod.feePayer}
                    onChange={(v) => mut((d) => (d.econt.cod.feePayer = v))}
                    options={[
                      { value: 'customer', label: 'Клиент' },
                      { value: 'farm', label: 'Ферма' },
                    ]}
                  />
                </div>
              )}
              <ToggleSwitch checked={e.cod.enabled} onChange={(v) => mut((d) => (d.econt.cod.enabled = v))} />
            </div>
          </div>
        </div>

        {/* advanced — grouped, collapsed by default */}
        <Collapsible
          title="Разширени настройки"
          hint="Размер на товарителницата, размери на пакета, авто-създаване. Стандартните стойности работят за повечето ферми."
        >
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            <DLabel label="Размери Д×Ш×В (см, опц.)">
              <input
                value={e.defaultPackage.dimensions ?? ''}
                placeholder="30×20×15"
                onChange={(ev) => mut((d) => (d.econt.defaultPackage.dimensions = ev.target.value))}
                className={fieldCls}
              />
            </DLabel>
            <DLabel label="Размер на товарителницата">
              <Segmented
                value={e.label.paper}
                onChange={(v) => mut((d) => (d.econt.label.paper = v))}
                options={[
                  { value: 'A4', label: 'A4' },
                  { value: 'A6', label: 'A6 (етикет)' },
                ]}
              />
            </DLabel>
          </div>
          <div className="mt-3.5 flex items-center justify-between rounded-[10px] border border-ff-border bg-ff-surface-2 px-3.5 py-3">
            <div>
              <div className="text-[14px] font-bold text-ff-ink">Авто-товарителница</div>
              <div className="mt-px text-[12px] text-ff-muted">Създавай автоматично при платена поръчка.</div>
            </div>
            <ToggleSwitch
              checked={e.label.autoCreate}
              onChange={(v) => mut((d) => (d.econt.label.autoCreate = v))}
            />
          </div>
        </Collapsible>

        <Divider />

        {/* nomenclature */}
        <div className="flex flex-wrap items-center justify-between gap-3.5">
          <div>
            <div className="text-[14px] font-bold text-ff-ink">Градове и офиси</div>
            <div className="mt-0.5 text-[12.5px] text-ff-muted">
              Последна синхронизация: {e.nomenclature.lastSyncedAt} ·{' '}
              <span className="ff-fig">{e.nomenclature.cities.toLocaleString('bg')}</span> населени места ·{' '}
              <span className="ff-fig">{e.nomenclature.offices.toLocaleString('bg')}</span> офиса
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                const r = await syncEcontNomenclature();
                mut((d) => {
                  d.econt.nomenclature.lastSyncedAt = 'току-що';
                  d.econt.nomenclature.cities = r.cities;
                  d.econt.nomenclature.offices = r.offices;
                });
                toast.success(`Обновени: ${r.cities} населени места, ${r.offices} офиса`);
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'Неуспешно обновяване');
              }
            }}
          >
            <RefreshCw size={16} /> Обнови градове и офиси
          </Button>
        </div>
      </div>

      {help && (
        <HelpModal
          eyebrow={ECONT_HELP.eyebrow}
          title={ECONT_HELP.title}
          intro={ECONT_HELP.intro}
          steps={ECONT_HELP.steps}
          tips={ECONT_HELP.tips}
          onClose={() => setHelp(false)}
        />
      )}
    </DSection>
  );
}
