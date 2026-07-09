'use client';

import * as React from 'react';
import Link from 'next/link';
import { Building2, Home, CalendarDays, MapPin, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { METHOD_META, type SlotStatus } from '@/lib/delivery-data';
import { WD, WindowFields } from '@/components/slots/recurrence-card';
import type {
  DeliveryConfig,
  DeliveryMethod,
  DeliveryMethodKey,
  PricingType,
} from '@/lib/types';
import { DSection, DLabel, Segmented, LvInput, InfoNote, fieldCls } from './ui';

type Mut = (fn: (d: DeliveryConfig) => void) => void;

const METHOD_ICON: Record<DeliveryMethodKey, LucideIcon> = {
  econtOffice: Building2,
  econtAddress: Home,
  ownSlots: CalendarDays,
  pickup: MapPin,
};

const PRICE_OPTS: { value: PricingType; label: string }[] = [
  { value: 'free', label: 'Безплатна' },
  { value: 'flat', label: 'Фиксирана' },
];

/**
 * Per-method **configuration** (label, price, eta, payer, pickup address). The
 * on/off switch lives in „Методи и цени" (/setup) — so this only renders
 * the config for methods that are switched on, in the order set by the config.
 */
export function MethodsSection({
  cfg,
  mut,
  slotStatus,
}: {
  cfg: DeliveryConfig;
  mut: Mut;
  slotStatus: SlotStatus;
}) {
  const econtMode = cfg.econt.mode ?? (cfg.econt.configured ? 'auto' : 'off');
  const order = cfg.methods.order.filter((k) => {
    if (!cfg.methods[k].enabled) return false;
    if (k === 'econtOffice') return econtMode === 'auto';
    if (k === 'econtAddress') return econtMode !== 'off';
    return true;
  });

  return (
    <DSection
      title="Настройки на методите"
      helper="Цена, етикет и срок за всеки включен начин на доставка."
      info={
        <>
          Това са детайлите на методите, които си включил в панела. Всеки показва цената, която
          клиентът плаща, и текста, който вижда при поръчка.
        </>
      }
    >
      {order.length === 0 ? (
        <div className="flex flex-col items-start gap-2.5 rounded-xl border border-ff-border-2 bg-ff-surface-2 px-4 py-4 text-[13.5px] text-ff-ink-2">
          Няма включени методи за доставка.
          <Link href="/settings?config=setup" className="text-[13px] font-bold text-ff-green-700 hover:underline">
            Включи метод от „Методи и цени” →
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {order.map((key) => (
            <MethodCard
              key={key}
              mkey={key}
              m={cfg.methods[key]}
              mut={mut}
              slotStatus={slotStatus}
            />
          ))}
        </div>
      )}

      {/* In manual Econt mode „До офис" can't be offered — say so, or the farmer
          wonders why office-pickup never appears for customers. */}
      {cfg.methods.econtAddress.enabled && econtMode === 'manual' && (
        <div className="mt-2.5 rounded-[10px] border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-3 text-[13px] leading-relaxed text-ff-ink-2">
          „До офис на Еконт“ се показва на клиента само в <b>автоматичен режим</b>. В ръчен
          режим работи единствено доставка „До адрес“. Превключи режима от секцията „Еконт“ по-долу.
        </div>
      )}
    </DSection>
  );
}

function MethodCard({
  mkey,
  m,
  mut,
  slotStatus,
}: {
  mkey: DeliveryMethodKey;
  m: DeliveryMethod;
  mut: Mut;
  slotStatus: SlotStatus;
}) {
  const meta = METHOD_META[mkey];
  const Icon = METHOD_ICON[mkey];
  const patch = (fn: (x: DeliveryMethod) => void) => mut((d) => fn(d.methods[mkey]));
  const hasPricing = mkey !== 'pickup';

  return (
    <div className="overflow-hidden rounded-xl border border-ff-green-100 bg-ff-green-50">
      <div className="flex items-center gap-3 px-[15px] py-3">
        <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border border-ff-border-2 bg-ff-green-100 text-ff-green-700">
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-extrabold text-ff-ink">{m.label || meta.name}</div>
          <div className="mt-px text-[12.5px] text-ff-muted">{meta.desc}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3.5 border-t border-ff-green-100 bg-ff-surface px-[15px] py-4 sm:grid-cols-2">
        {mkey === 'pickup' ? (
          <>
            <div className="sm:col-span-2">
              <DLabel label="Адрес за вземане">
                <textarea
                  value={m.address ?? ''}
                  rows={2}
                  onChange={(e) => patch((x) => (x.address = e.target.value))}
                  className={cn(fieldCls, 'resize-y font-medium')}
                />
              </DLabel>
            </div>
            {m.pickupWeekday == null && (
              <DLabel label="Работно време">
                <input
                  value={m.hours ?? ''}
                  onChange={(e) => patch((x) => (x.hours = e.target.value))}
                  className={fieldCls}
                />
              </DLabel>
            )}
            <div className="sm:col-span-2 flex flex-col gap-2 rounded-[10px] border border-ff-border bg-ff-surface-2 px-3.5 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-bold text-ff-ink-2">
                  Фиксиран ден и час (по желание — напр. пазар)
                </span>
                {m.pickupWeekday != null && (
                  <button
                    type="button"
                    onClick={() =>
                      patch((x) => {
                        x.pickupWeekday = undefined;
                        x.pickupFrom = undefined;
                        x.pickupTo = undefined;
                      })
                    }
                    className="text-[12px] font-bold text-ff-ink-2 underline-offset-2 hover:text-ff-green-700 hover:underline"
                  >
                    Изчисти
                  </button>
                )}
              </div>
              <p className="text-[12px] text-ff-muted">
                Зададеш ли ден и час, клиентите виждат точен график вместо текста в „Работно време“.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {WD.map((d) => (
                  <button
                    key={d.i}
                    type="button"
                    onClick={() => patch((x) => (x.pickupWeekday = d.i))}
                    className={cn(
                      'h-9 w-9 rounded-lg border text-[12.5px] font-bold transition-colors',
                      m.pickupWeekday === d.i
                        ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-700'
                        : 'border-ff-border text-ff-ink-2 hover:border-ff-green-300',
                    )}
                  >
                    {d.l}
                  </button>
                ))}
              </div>
              {m.pickupWeekday != null && (
                <WindowFields
                  win={{ timeFrom: m.pickupFrom ?? '10:00', timeTo: m.pickupTo ?? '15:00' }}
                  onChange={(w) =>
                    patch((x) => {
                      x.pickupFrom = w.timeFrom;
                      x.pickupTo = w.timeTo;
                    })
                  }
                />
              )}
            </div>
          </>
        ) : (
          <>
            {mkey === 'ownSlots' && (
              <div className="sm:col-span-2">
                <InfoNote tone="green">
                  Личната доставка <b>не минава през Еконт</b>. Клиентът избира свободен час от твоите
                  часове, а ти доставяш сам.
                </InfoNote>

                <div className="mt-3 flex flex-col gap-3">
                  <div
                    className={cn(
                      'rounded-[10px] border px-3.5 py-3',
                      slotStatus.state === 'configuredWithFree'
                        ? 'border-ff-border bg-ff-surface-2'
                        : 'border-ff-amber-soft bg-ff-amber-softer',
                    )}
                  >
                    <div
                      className={cn(
                        'text-[14.5px] font-extrabold',
                        slotStatus.state === 'configuredWithFree' ? 'text-ff-ink' : 'text-ff-amber',
                      )}
                    >
                      {slotStatus.state === 'none' && 'Още нямаш зададени часове за доставка'}
                      {slotStatus.state === 'configuredNoneFree' &&
                        'Часовете ти са зададени, но тази седмица няма свободни'}
                      {slotStatus.state === 'configuredWithFree' && (
                        <>
                          <span className="ff-fig">{slotStatus.freeThisWeek}</span> свободни часа тази седмица
                        </>
                      )}
                    </div>
                    <div className="mt-px text-[12.5px] text-ff-muted">
                      {slotStatus.state === 'none' &&
                        'Отвори „Часове за доставка“ по-долу и задай повтарящите се дни — иначе клиентите не могат да изберат час за лична доставка.'}
                      {slotStatus.state === 'configuredNoneFree' &&
                        'Всички часове за тази седмица са заети или затворени. Клиентите ще виждат следващите свободни часове напред.'}
                      {slotStatus.state === 'configuredWithFree' && 'Клиентите избират от тези часове при поръчка.'}
                    </div>
                  </div>

                  <Link
                    href="/settings?config=slots"
                    className="flex items-center gap-3 rounded-[10px] border border-ff-border bg-ff-surface-2 px-3.5 py-3 text-[13px] leading-snug text-ff-ink-2 transition-colors hover:border-ff-green-100 hover:bg-ff-green-50"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-ff-green-100 text-ff-green-700">
                      <CalendarDays size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <b className="text-ff-ink">Отвори календара с часове</b> — задай повтарящите се дни,
                      добави единичен час или затвори отделен ден (напр. отпуск).
                    </span>
                    <span className="shrink-0 text-[13px] font-bold text-ff-green-700">→</span>
                  </Link>
                </div>
              </div>
            )}

            <DLabel label="Етикет за клиента" hint="Текстът, който клиентът вижда.">
              <input
                value={m.label}
                onChange={(e) => patch((x) => (x.label = e.target.value))}
                className={fieldCls}
              />
            </DLabel>
            {mkey !== 'ownSlots' && (
              <DLabel label="Срок">
                <input
                  value={m.etaText ?? ''}
                  placeholder="напр. 1–2 работни дни"
                  onChange={(e) => patch((x) => (x.etaText = e.target.value))}
                  className={fieldCls}
                />
              </DLabel>
            )}

            {hasPricing && (
              <div className="sm:col-span-2">
                <DLabel label="Цена">
                  <Segmented
                    value={m.pricing?.type ?? 'free'}
                    onChange={(v) =>
                      patch((x) => {
                        if (!x.pricing) x.pricing = { type: v };
                        x.pricing.type = v;
                        if (v === 'flat' && x.pricing.feeStotinki == null) x.pricing.feeStotinki = 499;
                      })
                    }
                    options={PRICE_OPTS}
                  />
                </DLabel>
                {m.pricing?.type === 'flat' && (
                  <div className="mt-2.5 max-w-[220px]">
                    <LvInput
                      label="Фиксирана такса"
                      value={m.pricing.feeStotinki ?? 0}
                      onChange={(v) => patch((x) => (x.pricing!.feeStotinki = v))}
                    />
                  </div>
                )}
              </div>
            )}

            <DLabel label="Кой плаща доставката">
              <Segmented
                value={m.payer ?? 'customer'}
                onChange={(v) => patch((x) => (x.payer = v))}
                options={[
                  { value: 'customer', label: 'Клиент' },
                  { value: 'farm', label: 'Ферма' },
                ]}
              />
            </DLabel>
            {mkey === 'econtOffice' && (
              <LvInput
                label="Минимална поръчка за този метод"
                value={m.minOrderStotinki ?? 0}
                onChange={(v) => patch((x) => (x.minOrderStotinki = v))}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The delivery value that applies across **all** methods at once — the global
 * free-over threshold. Kept in its own section so a farmer can't edit „one
 * method card" and silently change a rule that affects every method (the old
 * per-card inputs all wrote the same global value).
 */
export function GlobalRulesSection({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  return (
    <DSection
      title="Общи правила"
      helper="Важат за всички методи наведнъж."
      info={<>„Безплатно над сума“ важи за всички методи — задаваш го веднъж тук.</>}
    >
      <div className="grid grid-cols-1 gap-3.5">
        <div>
          <LvInput
            label="Безплатна доставка над сума"
            value={cfg.pricing.freeThresholdStotinki}
            onChange={(v) => mut((d) => (d.pricing.freeThresholdStotinki = v))}
          />
          <p className="mt-1.5 text-[12.5px] text-ff-muted">
            Поръчка над тази сума пътува безплатно с всеки метод. 0 = без безплатна доставка.
          </p>
        </div>
      </div>
    </DSection>
  );
}
