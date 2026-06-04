'use client';

import * as React from 'react';
import { Info, RefreshCw, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { Button } from '@/components/ui/button';
import { BG_CITIES, ECONT_OFFICES, ECONT_HELP } from '@/lib/delivery-data';
import { saveEcontCredentials, syncEcontNomenclature, ApiError } from '@/lib/api-client';
import type { DeliveryConfig } from '@/lib/types';
import {
  DSection,
  DLabel,
  Segmented,
  DBadge,
  Divider,
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
  const [cityQ, setCityQ] = React.useState(e.sender.cityName);
  const [cityOpen, setCityOpen] = React.useState(false);
  const [help, setHelp] = React.useState(false);

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

  const cities = BG_CITIES.filter((c) => c.name.toLowerCase().includes(cityQ.toLowerCase()));
  const senderOffices = ECONT_OFFICES.filter((o) => o.cityName === e.sender.cityName);

  return (
    <DSection
      title="Еконт интеграция"
      helper="Свържи акаунта си в Еконт, за да създаваш товарителници и да изчисляваш цени автоматично."
      action={headerActions}
      info={
        <>
          Свързваш акаунта си в <b>Еконт</b> (куриера), за да печаташ товарителници направо оттук — без
          да влизаш в сайта на Еконт. Не знаеш откъде да започнеш? Натисни „Обяснения“ горе вдясно.
        </>
      }
    >
      <div className="flex flex-col gap-[18px]">
        {/* credentials */}
        <div className="grid items-end gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
          <DLabel label="Среда">
            <Segmented
              value={e.env}
              onChange={(v) => mut((d) => (d.econt.env = v))}
              options={[
                { value: 'demo', label: 'Тест' },
                { value: 'prod', label: 'Реален' },
              ]}
            />
          </DLabel>
          <DLabel label="API потребител">
            <input
              value={e.username ?? ''}
              placeholder="потребителско име"
              onChange={(ev) => mut((d) => (d.econt.username = ev.target.value))}
              className={fieldCls}
            />
          </DLabel>
          <DLabel label="API парола">
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
        <div className="flex items-center">
          <Button variant="outline" size="sm" onClick={runCheck} disabled={check === 'loading'}>
            {check === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            {check === 'loading' ? 'Проверка…' : 'Провери връзката'}
          </Button>
          {check === 'ok' && (
            <span className="ml-3 text-[13px] font-bold text-ff-green-700">Връзката е успешна</span>
          )}
          {check === 'fail' && <span className="ml-3 text-[13px] font-bold text-ff-red">Невалидни данни</span>}
        </div>

        <Divider />

        {/* sender profile */}
        <div>
          <h3 className={subHeadCls}>Профил на подател</h3>
          <p className={subDescCls}>
            Данните на фермата ти — оттук тръгват пратките. Попълват се автоматично в товарителницата.
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
            <DLabel label="Град" hint="Търси по име на населено място.">
              <div className="relative">
                <input
                  value={cityQ}
                  onChange={(ev) => {
                    setCityQ(ev.target.value);
                    setCityOpen(true);
                  }}
                  onFocus={() => setCityOpen(true)}
                  onBlur={() => window.setTimeout(() => setCityOpen(false), 150)}
                  className={fieldCls}
                />
                {cityOpen && cities.length > 0 && (
                  <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-[220px] overflow-y-auto rounded-[9px] border border-ff-border bg-ff-surface shadow-ff-md">
                    {cities.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onMouseDown={() => {
                          mut((d) => {
                            d.econt.sender.cityId = c.id;
                            d.econt.sender.cityName = c.name;
                          });
                          setCityQ(c.name);
                          setCityOpen(false);
                        }}
                        className="block w-full px-3.5 py-2.5 text-left text-[14px] font-semibold text-ff-ink hover:bg-ff-green-50"
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
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
                  <select
                    value={e.sender.officeCode ?? ''}
                    onChange={(ev) => mut((d) => (d.econt.sender.officeCode = ev.target.value))}
                    className={cn(fieldCls, 'cursor-pointer appearance-none')}
                  >
                    {senderOffices.length === 0 && <option>Няма офиси за този град</option>}
                    {senderOffices.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.name} — {o.address}
                      </option>
                    ))}
                  </select>
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

        {/* default package */}
        <div>
          <h3 className={subHeadCls}>Пакет по подразбиране</h3>
          <p className={subDescCls}>
            Стандартните тегло и размери на пратките ти. Спестява попълване при всяка поръчка.
          </p>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
            <DLabel label="Тегло (кг)">
              <input
                value={e.defaultPackage.weightKg}
                inputMode="decimal"
                onChange={(ev) =>
                  mut((d) => (d.econt.defaultPackage.weightKg = parseFloat(ev.target.value) || 0))
                }
                className={fieldCls}
              />
            </DLabel>
            <DLabel label="Размери Д×Ш×В (см, опц.)">
              <input
                value={e.defaultPackage.dimensions ?? ''}
                placeholder="30×20×15"
                onChange={(ev) => mut((d) => (d.econt.defaultPackage.dimensions = ev.target.value))}
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
        </div>

        <Divider />

        {/* COD + label */}
        <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-[14px] font-bold text-ff-ink">Наложен платеж (COD)</div>
                <div className="mt-px text-[12px] text-ff-muted">Клиентът плаща при доставка.</div>
              </div>
              <ToggleSwitch checked={e.cod.enabled} onChange={(v) => mut((d) => (d.econt.cod.enabled = v))} />
            </div>
            {e.cod.enabled && (
              <DLabel label="Кой плаща таксата за наложен платеж">
                <Segmented
                  value={e.cod.feePayer}
                  onChange={(v) => mut((d) => (d.econt.cod.feePayer = v))}
                  options={[
                    { value: 'customer', label: 'Клиент' },
                    { value: 'farm', label: 'Ферма' },
                  ]}
                />
              </DLabel>
            )}
          </div>
          <div>
            <DLabel label="Размер на товарителницата">
              <Segmented
                value={e.label.paper}
                onChange={(v) => mut((d) => (d.econt.label.paper = v))}
                options={[
                  { value: 'A4', label: 'A4' },
                  { value: 'A6', label: 'A6' },
                ]}
              />
            </DLabel>
            <div className="mt-3.5 flex items-center justify-between">
              <div>
                <div className="text-[14px] font-bold text-ff-ink">Авто-товарителница</div>
                <div className="mt-px text-[12px] text-ff-muted">Създавай при платена поръчка.</div>
              </div>
              <ToggleSwitch
                checked={e.label.autoCreate}
                onChange={(v) => mut((d) => (d.econt.label.autoCreate = v))}
              />
            </div>
          </div>
        </div>

        <Divider />

        {/* nomenclature */}
        <div className="flex flex-wrap items-center justify-between gap-3.5">
          <div>
            <div className="text-[14px] font-bold text-ff-ink">Номенклатури (градове и офиси)</div>
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
