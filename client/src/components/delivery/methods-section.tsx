'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2,
  Home,
  CalendarDays,
  MapPin,
  GripVertical,
  ExternalLink,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { Button } from '@/components/ui/button';
import { METHOD_META } from '@/lib/delivery-data';
import type { DeliveryConfig, DeliveryMethod, DeliveryMethodKey, PricingType } from '@/lib/types';
import { DSection, DLabel, Segmented, LvInput, InfoNote, DBadge, fieldCls } from './ui';

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
  { value: 'byWeight', label: 'Според теглото' },
  { value: 'freeOver', label: 'Безплатна над сума' },
];

export function MethodsSection({
  cfg,
  mut,
  econtReady,
  noMethods,
  slotFreeCount,
}: {
  cfg: DeliveryConfig;
  mut: Mut;
  econtReady: boolean;
  noMethods: boolean;
  slotFreeCount: number;
}) {
  const [dragKey, setDragKey] = React.useState<DeliveryMethodKey | null>(null);
  const order = cfg.methods.order;

  const onDrop = (target: DeliveryMethodKey) => {
    if (!dragKey || dragKey === target) return;
    mut((d) => {
      const arr = d.methods.order;
      const from = arr.indexOf(dragKey);
      const to = arr.indexOf(target);
      arr.splice(to, 0, arr.splice(from, 1)[0]);
    });
    setDragKey(null);
  };

  return (
    <DSection
      title="Методи на доставка"
      helper="Подреди с влачене. Всеки активен метод се показва на клиента при поръчка."
      info={
        <>
          Тук избираш <b>по какви начини</b> клиентът може да получи поръчката си. Включи тези, които
          предлагаш, и натисни върху всеки, за да му зададеш цена и срок. Влачи с лявата дръжка, за да
          подредиш кой да е най-отгоре.
        </>
      }
    >
      {noMethods && (
        <div className="mb-3 flex items-center gap-2.5 rounded-[9px] bg-[#f7e0dc] px-3.5 py-2.5 text-[13px] font-bold text-ff-red">
          <AlertTriangle size={16} /> Активирай поне един метод, докато доставката е включена.
        </div>
      )}
      <div className="flex flex-col gap-2.5">
        {order.map((key) => (
          <MethodCard
            key={key}
            mkey={key}
            m={cfg.methods[key]}
            mut={mut}
            econtReady={econtReady}
            slotFreeCount={slotFreeCount}
            dragging={dragKey === key}
            onDragStart={() => setDragKey(key)}
            onDragEnd={() => setDragKey(null)}
            onDropHere={() => onDrop(key)}
          />
        ))}
      </div>
    </DSection>
  );
}

function MethodCard({
  mkey,
  m,
  mut,
  econtReady,
  slotFreeCount,
  dragging,
  onDragStart,
  onDragEnd,
  onDropHere,
}: {
  mkey: DeliveryMethodKey;
  m: DeliveryMethod;
  mut: Mut;
  econtReady: boolean;
  slotFreeCount: number;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropHere: () => void;
}) {
  const router = useRouter();
  const meta = METHOD_META[mkey];
  const Icon = METHOD_ICON[mkey];
  const needsEcont = meta.econt && !econtReady;
  const patch = (fn: (x: DeliveryMethod) => void) => mut((d) => fn(d.methods[mkey]));
  const hasPricing = mkey !== 'pickup';

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDropHere}
      className={cn(
        'overflow-hidden rounded-xl border transition-opacity',
        m.enabled ? 'border-ff-green-100 bg-ff-green-50' : 'border-ff-border bg-ff-surface-2',
        dragging && 'opacity-45',
      )}
    >
      <div className="flex items-center gap-3 px-[15px] py-3.5">
        <span className="grid cursor-grab place-items-center text-ff-muted-2" title="Влачи за подреждане">
          <GripVertical size={18} />
        </span>
        <span
          className={cn(
            'grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border border-ff-border-2',
            m.enabled ? 'bg-ff-green-100 text-ff-green-700' : 'bg-ff-surface text-ff-muted',
          )}
        >
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[14.5px] font-extrabold text-ff-ink">
            {m.label || meta.name}
            {needsEcont && (
              <DBadge tone="gray" dot={false}>
                изисква Еконт
              </DBadge>
            )}
          </div>
          <div className="mt-px text-[12.5px] text-ff-muted">{meta.desc}</div>
        </div>
        <div
          title={needsEcont ? 'Първо свържи Еконт акаунт' : undefined}
          className={needsEcont ? 'pointer-events-none opacity-50' : undefined}
        >
          <ToggleSwitch checked={m.enabled} onChange={(v) => patch((x) => (x.enabled = v))} />
        </div>
      </div>

      {m.enabled && (
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
                      <div className="text-[14.5px] font-extrabold text-ff-ink">
                        <span className="ff-fig">{slotFreeCount}</span> свободни часа тази седмица
                      </div>
                      <div className="mt-px text-[12.5px] text-ff-muted">
                        Клиентите избират от тези часове при поръчка.
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
                          if (v === 'freeOver' && x.pricing.freeOverStotinki == null)
                            x.pricing.freeOverStotinki = 6000;
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
                  {m.pricing?.type === 'freeOver' && (
                    <div className="mt-2.5 grid max-w-[460px] grid-cols-2 gap-3">
                      <LvInput
                        label="Праг за безплатна"
                        value={m.pricing.freeOverStotinki ?? 0}
                        onChange={(v) => patch((x) => (x.pricing!.freeOverStotinki = v))}
                      />
                      <LvInput
                        label="Такса под прага"
                        value={m.pricing.feeStotinki ?? 0}
                        onChange={(v) => patch((x) => (x.pricing!.feeStotinki = v))}
                      />
                    </div>
                  )}
                  {m.pricing?.type === 'byWeight' && (
                    <p className="mt-2 text-[12.5px] text-ff-muted">
                      Използва таблицата по тегло от секция „Ценообразуване“.
                    </p>
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
                  label="Минимална поръчка (0 = без)"
                  value={m.minOrderStotinki ?? 0}
                  onChange={(v) => patch((x) => (x.minOrderStotinki = v))}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
