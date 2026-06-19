'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Wallet, CreditCard, MapPin, CalendarDays, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ApiError, saveDelivery } from '@/lib/api-client';
import { hydrateDelivery } from '@/lib/delivery-data';
import type { DeliveryConfig, EcontConfig } from '@/lib/types';
import { DBadge } from '@/components/delivery/ui';
import { Button } from '@/components/ui/button';
import { ExternalLink } from 'lucide-react';
import { CardGroup, ToggleCard, SaveBar } from './panel-ui';

/** Minimal Stripe state the card needs — derived server-side, null when the call failed. */
export type StripeStatus = { enabled: boolean; connected: boolean; chargesEnabled: boolean } | null;

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
type EcontMode = NonNullable<EcontConfig['mode']>;

const COD_COPY =
  'Клиентът плаща при получаване, в брой — на гишето на Еконт или на куриера. Не взимаш парите предварително. Работи веднага.';
const CARD_COPY =
  'Клиентът плаща веднага с карта, през защитена страница — като ПОС терминал, но онлайн. За да го предлагаш, си правиш сметка (акаунт) в Stripe — сигурна услуга за картови плащания, от която парите идват по твоята банкова сметка. Свързва се еднократно от „Плащания“.';
const PICKUP_COPY = 'Клиентът идва и си взема поръчката лично (ферма/пазар/гише). Без доставка, без такса.';
const SELF_COPY =
  'Ти разнасяш сам, по график. Клиентът избира свободен час (слот); ти обикаляш по маршрут. Не минава през куриер.';
const COURIER_COPY =
  'Поръчката стига с Еконт; клиентът дава адрес. Как изпращаш (ръчно или Еконт онлайн) се избира в „Доставка“.';

export function SetupPanel({
  initialEnabled,
  initialDelivery,
  stripe,
  slotFreeCount,
}: {
  initialEnabled: boolean;
  initialDelivery: DeliveryConfig | null;
  stripe: StripeStatus;
  /** Free delivery-slot count this week. `undefined` = unknown (don't warn). */
  slotFreeCount?: number;
}) {
  const router = useRouter();
  const base = React.useMemo(() => hydrateDelivery(initialDelivery), [initialDelivery]);

  const [savedEnabled, setSavedEnabled] = React.useState(initialEnabled);
  const [enabled, setEnabled] = React.useState(initialEnabled);
  const [savedCfg, setSavedCfg] = React.useState<DeliveryConfig>(() => structuredClone(base));
  const [cfg, setCfg] = React.useState<DeliveryConfig>(() => structuredClone(base));
  const [saving, setSaving] = React.useState(false);

  const mut = (fn: (d: DeliveryConfig) => void) =>
    setCfg((prev) => {
      const d = structuredClone(prev);
      fn(d);
      return d;
    });

  const dirty = enabled !== savedEnabled || JSON.stringify(cfg) !== JSON.stringify(savedCfg);

  // --- payment ---
  const codOn = cfg.cod?.enabled ?? true;
  const cardOn = cfg.card?.enabled ?? true;

  // --- delivery ---
  const pickupOn = cfg.methods.pickup.enabled;
  const selfOn = enabled && cfg.methods.ownSlots.enabled;
  const econtMode: EcontMode = cfg.econt.mode ?? (cfg.econt.configured ? 'auto' : 'off');
  const courierOn = econtMode !== 'off';
  // Remember the sub-mode so toggling the courier off→on restores manual/auto.
  const [lastSub, setLastSub] = React.useState<'manual' | 'auto'>(
    econtMode === 'auto' ? 'auto' : 'manual',
  );

  const toggleCourier = (v: boolean) =>
    mut((d) => {
      const next: EcontMode = v ? lastSub : 'off';
      d.econt.mode = next;
      d.methods.econtAddress.enabled = v;
      d.methods.econtOffice.enabled = v;
    });
  React.useEffect(() => {
    if (econtMode !== 'off') setLastSub(econtMode);
  }, [econtMode]);

  const save = async () => {
    setSaving(true);
    try {
      await saveDelivery({ deliveryEnabled: enabled, delivery: cfg });
      setSavedEnabled(enabled);
      setSavedCfg(structuredClone(cfg));
      router.refresh();
      toast.success('Настройките са запазени');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setEnabled(savedEnabled);
    setCfg(structuredClone(savedCfg));
  };

  // Stripe card: status + a link to the Payments page (not a flip-here toggle).
  const stripeAvailable = !!stripe?.enabled;
  const stripeReady = stripeAvailable && !!stripe?.chargesEnabled;
  const stripeBadge = !stripeAvailable ? (
    <DBadge tone="gray" dot={false}>
      не е налично
    </DBadge>
  ) : stripeReady ? (
    <DBadge tone="green">Активно</DBadge>
  ) : (
    <DBadge tone="amber">Не е свързано</DBadge>
  );
  const cardDesc = stripeAvailable
    ? stripeReady
      ? cardOn
        ? 'Приемаш плащания с карта. Настройките на картовите плащания (Stripe) са в „Плащания“.'
        : 'Изключено — клиентите не виждат плащане с карта. Връзката за картови плащания остава.'
      : 'За плащане с карта си направи сметка в Stripe — от „Плащания“. Отнема няколко минути.'
    : CARD_COPY;

  return (
    <div className={cn('animate-ff-fade-up flex flex-col gap-4', dirty && 'pb-20')}>
      <div className="mb-1">
        <h1 className="font-display text-[26px] font-extrabold tracking-[-0.02em] text-ff-ink">
          Методи и цени
        </h1>
        <p className="mt-0.5 text-[14px] text-ff-ink-2">
          Избери как клиентите плащат и получават поръчките си. Подробните настройки са в страница „Доставка“.
        </p>
      </div>

      <CardGroup
        icon={Wallet}
        title="Плащане"
        desc="Може и двете заедно — клиентът избира при поръчка."
      >
        <ToggleCard
          icon={Wallet}
          title="Наложен платеж"
          desc={COD_COPY}
          on={codOn}
          onToggle={(v) => mut((d) => (d.cod = { enabled: v }))}
        />
        <ToggleCard
          icon={CreditCard}
          title="Карта (онлайн)"
          desc={cardDesc}
          on={stripeReady && cardOn}
          onToggle={stripeReady ? (v) => mut((d) => (d.card = { enabled: v })) : undefined}
          badge={stripeBadge}
          headerAction={
            stripeAvailable ? (
              <Button
                variant={stripeReady ? 'soft' : 'primary'}
                size="sm"
                onClick={() => router.push('/payments')}
              >
                <ExternalLink size={15} /> {stripeReady ? 'Управлявай' : 'Свържи'}
              </Button>
            ) : undefined
          }
        />
      </CardGroup>

      <CardGroup
        icon={Truck}
        title="Доставка"
        desc="Включи всеки начин, който предлагаш — клиентът избира при поръчка."
      >
        <ToggleCard
          icon={MapPin}
          title="Вземане от място"
          desc={PICKUP_COPY}
          on={pickupOn}
          onToggle={(v) => mut((d) => (d.methods.pickup.enabled = v))}
          configLink={{ href: '/settings?config=delivery', label: 'Настрой адрес и работно време' }}
        />
        <ToggleCard
          icon={CalendarDays}
          title="Лична доставка + слотове"
          desc={SELF_COPY}
          on={selfOn}
          onToggle={(v) => {
            setEnabled(v);
            mut((d) => (d.methods.ownSlots.enabled = v));
          }}
          badge={
            selfOn && slotFreeCount === 0 ? (
              <DBadge tone="amber">Няма часове</DBadge>
            ) : undefined
          }
          configLink={{ href: '/settings?config=slots', label: 'Управлявай слотовете' }}
        />
        <ToggleCard
          icon={Truck}
          title="Доставка до адрес с куриер"
          desc={COURIER_COPY}
          on={courierOn}
          onToggle={toggleCourier}
          configLink={{ href: '/settings?config=delivery', label: 'Настрой Еконт (ръчно / онлайн)' }}
        />
      </CardGroup>

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={discard} />}
    </div>
  );
}
