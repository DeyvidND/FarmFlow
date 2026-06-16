'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Building2,
  Home,
  CalendarDays,
  MapPin,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { METHOD_META } from '@/lib/delivery-data';
import type { DeliveryConfig, DeliveryMethod, DeliveryMethodKey, PricingType } from '@/lib/types';
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
  slotFreeCount,
}: {
  cfg: DeliveryConfig;
  mut: Mut;
  slotFreeCount: number;
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
          <Link href="/setup" className="text-[13px] font-bold text-ff-green-700 hover:underline">
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
              slotFreeCount={slotFreeCount}
              freeThreshold={cfg.pricing.freeThresholdStotinki}
              onFreeThresholdChange={(v) => mut((d) => (d.pricing.freeThresholdStotinki = v))}
            />
          ))}
        </div>
      )}
    </DSection>
  );
}

function MethodCard({
  mkey,
  m,
  mut,
  slotFreeCount,
  freeThreshold,
  onFreeThresholdChange,
}: {
  mkey: DeliveryMethodKey;
  m: DeliveryMethod;
  mut: Mut;
  slotFreeCount: number;
  freeThreshold: number;
  onFreeThresholdChange: (v: number) => void;
}) {
  const router = useRouter();
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
            <DLabel label="Работно време">
              <input
                value={m.hours ?? ''}
                onChange={(e) => patch((x) => (x.hours = e.target.value))}
                className={fieldCls}
              />
            </DLabel>
          </>
        ) : (
          <>
            {mkey === 'ownSlots' && (
              <div className="sm:col-span-2">
                <InfoNote tone="green">
                  Личната доставка <b>не минава през Еконт</b>. Клиентът избира свободен час от твоите
                  слотове, а ти доставяш сам. Часовете се задават в страница „Слотове“.
                </InfoNote>
                <div className="flex items-center gap-3 rounded-[10px] border border-ff-border bg-ff-surface-2 px-3.5 py-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-ff-green-100 text-ff-green-700">
                    <CalendarDays size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={`text-[14.5px] font-extrabold ${slotFreeCount === 0 ? 'text-ff-amber' : 'text-ff-ink'}`}>
                      {slotFreeCount === 0 ? (
                        'Още нямаш свободни часове тази седмица'
                      ) : (
                        <><span className="ff-fig">{slotFreeCount}</span> свободни часа тази седмица</>
                      )}
                    </div>
                    <div className="mt-px text-[12.5px] text-ff-muted">
                      {slotFreeCount === 0
                        ? 'Клиентите не могат да изберат час — задай часове, иначе личната доставка не работи.'
                        : 'Клиентите избират от тези часове при поръчка.'}
                    </div>
                  </div>
                  <Button variant="soft" size="sm" onClick={() => router.push('/slots')}>
                    <ExternalLink size={15} /> Управлявай слотовете
                  </Button>
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
                  <div className="mt-2.5 grid grid-cols-2 gap-3 max-w-[460px]">
                    <LvInput
                      label="Фиксирана такса"
                      value={m.pricing.feeStotinki ?? 0}
                      onChange={(v) => patch((x) => (x.pricing!.feeStotinki = v))}
                    />
                    <LvInput
                      label="Безплатно над сума"
                      value={freeThreshold}
                      onChange={onFreeThresholdChange}
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
