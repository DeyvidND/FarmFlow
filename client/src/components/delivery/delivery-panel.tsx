'use client';

/**
 * «Доставка и плащане» panel — one card per option, grouped into ПЛАЩАНЕ and
 * ДОСТАВКА. Each card is icon + title + a plain-Bulgarian explanation + an on/off
 * toggle; flipping it on reveals that option's inline config. Multi-select: a farm
 * turns on every way it actually offers. Replaces the old scattered sections
 * (methods / pricing / payment / econt) without changing the saved config shape.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Wallet,
  CreditCard,
  MapPin,
  CalendarDays,
  Truck,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { Button } from '@/components/ui/button';
import type { DeliveryConfig, DeliveryMethod, EcontConfig, PricingType } from '@/lib/types';
import { DLabel, Segmented, LvInput, InfoNote, DBadge, fieldCls } from './ui';
import { EcontAutoConfig } from './econt-config';
import { OfficePickerPreview } from './office-picker-preview';
import { ShipmentsTable } from './shipments-table';

type Mut = (fn: (d: DeliveryConfig) => void) => void;
type Toast = { success: (m: string) => void; info?: (m: string) => void; error: (m: string) => void };

/** Minimal Stripe state the card needs — derived server-side, null when the call failed. */
export type StripeStatus = { enabled: boolean; connected: boolean; chargesEnabled: boolean } | null;

const ICON_BOX = 'grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border';

// ---- generic card ---------------------------------------------------------

function PanelCard({
  icon: Icon,
  title,
  desc,
  on,
  onToggle,
  toggleDisabled,
  toggleHint,
  badge,
  headerAction,
  note,
  children,
}: {
  icon: LucideIcon;
  title: string;
  desc: React.ReactNode;
  on: boolean;
  onToggle?: (v: boolean) => void;
  toggleDisabled?: boolean;
  toggleHint?: string;
  badge?: React.ReactNode;
  headerAction?: React.ReactNode;
  note?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border transition-colors',
        on ? 'border-ff-green-100 bg-ff-green-50' : 'border-ff-border bg-ff-surface-2',
      )}
    >
      <div className="flex items-center gap-3 px-[15px] py-3.5">
        <span
          className={cn(
            ICON_BOX,
            'border-ff-border-2',
            on ? 'bg-ff-green-100 text-ff-green-700' : 'bg-ff-surface text-ff-muted',
          )}
        >
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[14.5px] font-extrabold text-ff-ink">
            {title}
            {badge}
          </div>
          <div className="mt-0.5 max-w-[560px] text-[12.5px] leading-snug text-ff-muted">{desc}</div>
        </div>
        {headerAction}
        {onToggle && (
          <div title={toggleDisabled ? toggleHint : undefined}>
            <ToggleSwitch checked={on} onChange={onToggle} disabled={toggleDisabled} />
          </div>
        )}
      </div>
      {note}
      {on && children && (
        <div className="border-t border-ff-green-100 bg-ff-surface px-[15px] py-4">{children}</div>
      )}
    </div>
  );
}

/** Section wrapper grouping a set of cards under a heading. */
function CardGroup({
  icon: Icon,
  title,
  desc,
  children,
}: {
  icon: LucideIcon;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[14px] border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ff-green-100 text-ff-green-700">
          <Icon size={22} />
        </span>
        <div>
          <h2 className="font-display text-[16px] font-extrabold tracking-[-0.01em] text-ff-ink">
            {title}
          </h2>
          <p className="mt-0.5 max-w-[560px] text-[13px] leading-snug text-ff-ink-2">{desc}</p>
        </div>
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

// ---- shared price fields (self-delivery + manual courier) -----------------

const PRICE_OPTS: { value: PricingType; label: string }[] = [
  { value: 'free', label: 'Безплатна' },
  { value: 'flat', label: 'Фиксирана' },
  { value: 'freeOver', label: 'Безплатна над сума' },
];

function PriceFields({ m, patch }: { m: DeliveryMethod; patch: (fn: (x: DeliveryMethod) => void) => void }) {
  const type = m.pricing?.type ?? 'free';
  return (
    <div className="sm:col-span-2">
      <DLabel label="Цена за клиента">
        <Segmented
          value={type === 'byWeight' ? 'flat' : type}
          onChange={(v) =>
            patch((x) => {
              if (!x.pricing) x.pricing = { type: v };
              x.pricing.type = v;
              if (v === 'flat' && x.pricing.feeStotinki == null) x.pricing.feeStotinki = 499;
              if (v === 'freeOver') {
                if (x.pricing.freeOverStotinki == null) x.pricing.freeOverStotinki = 4000;
                if (x.pricing.feeStotinki == null) x.pricing.feeStotinki = 499;
              }
            })
          }
          options={PRICE_OPTS}
        />
      </DLabel>
      {type === 'flat' && (
        <div className="mt-2.5 max-w-[220px]">
          <LvInput
            label="Фиксирана такса"
            value={m.pricing?.feeStotinki ?? 0}
            onChange={(v) => patch((x) => (x.pricing!.feeStotinki = v))}
          />
        </div>
      )}
      {type === 'freeOver' && (
        <div className="mt-2.5 grid max-w-[460px] grid-cols-2 gap-3">
          <LvInput
            label="Праг за безплатна"
            value={m.pricing?.freeOverStotinki ?? 0}
            onChange={(v) => patch((x) => (x.pricing!.freeOverStotinki = v))}
          />
          <LvInput
            label="Такса под прага"
            value={m.pricing?.feeStotinki ?? 0}
            onChange={(v) => patch((x) => (x.pricing!.feeStotinki = v))}
          />
        </div>
      )}
    </div>
  );
}

function PayerField({ m, patch }: { m: DeliveryMethod; patch: (fn: (x: DeliveryMethod) => void) => void }) {
  return (
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
  );
}

// ---- ПЛАЩАНЕ --------------------------------------------------------------

const COD_COPY =
  'Клиентът плаща при получаване, в брой — на гишето на Еконт или на куриера. Не взимаш парите предварително. Не иска нищо — работи веднага.';
const CARD_COPY =
  'Клиентът плаща с карта веднага, през защитена страница; парите влизат в твоята Stripe сметка. Иска свързан Stripe акаунт.';

function CodCard({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  const on = cfg.cod?.enabled ?? true;
  return (
    <PanelCard
      icon={Wallet}
      title="Наложен платеж"
      desc={COD_COPY}
      on={on}
      onToggle={(v) => mut((d) => (d.cod = { enabled: v }))}
      note={
        !on ? (
          <div className="px-[15px] pb-3.5">
            <InfoNote tone="green">
              Изключено — клиентите трябва да платят онлайн с карта (изисква свързан Stripe).
            </InfoNote>
          </div>
        ) : undefined
      }
    />
  );
}

function CardPaymentCard({ stripe }: { stripe: StripeStatus }) {
  const router = useRouter();
  // Card payments aren't a config toggle — they're available exactly when the
  // farm's Stripe account can take charges. So this card only shows status and a
  // button to the Payments page where the connection is managed.
  const available = !!stripe?.enabled;
  const ready = available && !!stripe?.chargesEnabled;

  const badge = !available ? (
    <DBadge tone="gray" dot={false}>
      не е налично
    </DBadge>
  ) : ready ? (
    <DBadge tone="green">Активно</DBadge>
  ) : (
    <DBadge tone="amber">Не е свързано</DBadge>
  );

  const headerAction = available ? (
    <Button variant={ready ? 'soft' : 'primary'} size="sm" onClick={() => router.push('/payments')}>
      <ExternalLink size={15} /> {ready ? 'Управлявай' : 'Свържи'}
    </Button>
  ) : undefined;

  const desc = available
    ? ready
      ? 'Приемаш плащания с карта. Управлението на Stripe е в страница „Плащания“.'
      : 'Свържи Stripe акаунт в „Плащания“, за да приемаш плащания с карта.'
    : 'Картовите плащания не са активни за тази платформа — клиентите плащат с наложен платеж.';

  return (
    <PanelCard icon={CreditCard} title="Карта (онлайн)" desc={CARD_COPY} on={ready} badge={badge} headerAction={headerAction}>
      <p className="text-[13px] leading-relaxed text-ff-ink-2">{desc}</p>
    </PanelCard>
  );
}

// ---- ДОСТАВКА -------------------------------------------------------------

function PickupCard({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  const m = cfg.methods.pickup;
  const patch = (fn: (x: DeliveryMethod) => void) => mut((d) => fn(d.methods.pickup));
  return (
    <PanelCard
      icon={MapPin}
      title="Вземане от място"
      desc="Клиентът идва и си взема поръчката лично (ферма/пазар/гише). Без доставка, без такса."
      on={m.enabled}
      onToggle={(v) => patch((x) => (x.enabled = v))}
    >
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
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
            placeholder="напр. Пн–Сб, 09:00–18:00"
            onChange={(e) => patch((x) => (x.hours = e.target.value))}
            className={fieldCls}
          />
        </DLabel>
      </div>
    </PanelCard>
  );
}

function SelfDeliveryCard({
  cfg,
  mut,
  active,
  setActive,
  slotFreeCount,
}: {
  cfg: DeliveryConfig;
  mut: Mut;
  active: boolean; // deliveryEnabled (the master self-delivery flag)
  setActive: (v: boolean) => void;
  slotFreeCount: number;
}) {
  const router = useRouter();
  const m = cfg.methods.ownSlots;
  const patch = (fn: (x: DeliveryMethod) => void) => mut((d) => fn(d.methods.ownSlots));
  // Self-delivery is "on" only when both the method and the master delivery flag
  // are on — that's exactly what the storefront checks (deliveryEnabled && ownSlots).
  const on = active && m.enabled;
  const toggle = (v: boolean) => {
    setActive(v);
    patch((x) => (x.enabled = v));
  };
  return (
    <PanelCard
      icon={CalendarDays}
      title="Лична доставка + слотове"
      desc="Ти разнасяш сам, по график. Клиентът избира свободен час (слот); ти обикаляш по маршрут. Не минава през куриер."
      on={on}
      onToggle={toggle}
    >
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <InfoNote tone="green">
            Личната доставка <b>не минава през Еконт</b>. Клиентът избира свободен час от твоите слотове,
            а ти доставяш сам. Часовете се задават в страница „Слотове“.
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

        <DLabel label="Етикет за клиента" hint="Текстът, който клиентът вижда.">
          <input
            value={m.label}
            onChange={(e) => patch((x) => (x.label = e.target.value))}
            className={fieldCls}
          />
        </DLabel>

        <PriceFields m={m} patch={patch} />
        <PayerField m={m} patch={patch} />
      </div>
    </PanelCard>
  );
}

const COURIER_COPY =
  'Поръчката стига с Еконт; клиентът дава адрес. Избираш как изпращаш: ръчно (без Еконт акаунт) или с Еконт онлайн (товарителници + проследяване).';

type EcontMode = NonNullable<EcontConfig['mode']>;

function CourierCard({ cfg, mut, toast }: { cfg: DeliveryConfig; mut: Mut; toast: Toast }) {
  const e = cfg.econt;
  const mode: EcontMode = e.mode ?? (e.configured ? 'auto' : 'off');
  const on = mode !== 'off';
  // Remember the last real sub-mode so toggling the card off→on restores it.
  const [lastSub, setLastSub] = React.useState<'manual' | 'auto'>(mode === 'auto' ? 'auto' : 'manual');

  const setMode = (next: EcontMode) =>
    mut((d) => {
      d.econt.mode = next;
      // Keep the two Econt methods' enabled flags in lockstep with the card: on
      // when the courier is offered, off otherwise. The storefront then shows the
      // address variant in manual and the office variant in auto.
      const offered = next !== 'off';
      d.methods.econtAddress.enabled = offered;
      d.methods.econtOffice.enabled = offered;
    });

  const toggle = (v: boolean) => {
    if (v) setMode(lastSub);
    else setMode('off');
  };

  const addr = cfg.methods.econtAddress;
  const patchAddr = (fn: (x: DeliveryMethod) => void) => mut((d) => fn(d.methods.econtAddress));

  return (
    <PanelCard
      icon={Truck}
      title="Доставка до адрес с куриер"
      desc={COURIER_COPY}
      on={on}
      onToggle={toggle}
    >
      <div className="flex flex-col gap-4">
        {/* sub-mode: how the farm ships */}
        <div>
          <DLabel label="Как изпращаш">
            <Segmented
              value={mode === 'off' ? lastSub : mode}
              onChange={(v) => {
                setLastSub(v);
                setMode(v);
              }}
              options={[
                { value: 'manual', label: 'Ръчно' },
                { value: 'auto', label: 'Еконт онлайн' },
              ]}
            />
          </DLabel>
        </div>

        {mode === 'manual' && (
          <>
            <InfoNote tone="green">
              <b>Ръчно.</b> Всяка сутрин получаваш списък по имейл и сам занасяш пратката в офис на Еконт
              (без Еконт акаунт). Клиентът въвежда адреса си при поръчка.
            </InfoNote>
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <DLabel label="Етикет за клиента" hint="Текстът, който клиентът вижда.">
                <input
                  value={addr.label}
                  onChange={(ev) => patchAddr((x) => (x.label = ev.target.value))}
                  className={fieldCls}
                />
              </DLabel>
              <DLabel label="Срок">
                <input
                  value={addr.etaText ?? ''}
                  placeholder="напр. 1–2 работни дни"
                  onChange={(ev) => patchAddr((x) => (x.etaText = ev.target.value))}
                  className={fieldCls}
                />
              </DLabel>
              <PriceFields m={addr} patch={patchAddr} />
              <PayerField m={addr} patch={patchAddr} />
            </div>
          </>
        )}

        {mode === 'auto' && (
          <>
            <EcontAutoConfig cfg={cfg} mut={mut} toast={toast} />
            <OfficePickerPreview configured={e.configured} />
            <ShipmentsTable toast={toast} />
          </>
        )}
      </div>
    </PanelCard>
  );
}

function FreeThresholdRow({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  return (
    <div className="rounded-xl border border-ff-border bg-ff-surface-2 px-[15px] py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-extrabold text-ff-ink">Безплатна доставка над сума</div>
          <div className="mt-px text-[12.5px] text-ff-muted">
            Поръчки над тази сума са с безплатна доставка (важи за всеки платен метод). 0 = без праг.
          </div>
        </div>
        <div className="w-[160px]">
          <LvInput
            label=""
            value={cfg.pricing.freeThresholdStotinki}
            onChange={(v) => mut((d) => (d.pricing.freeThresholdStotinki = v))}
          />
        </div>
      </div>
    </div>
  );
}

// ---- panel ----------------------------------------------------------------

export function DeliveryPanel({
  cfg,
  mut,
  deliveryEnabled,
  setDeliveryEnabled,
  slotFreeCount,
  stripe,
  toast,
}: {
  cfg: DeliveryConfig;
  mut: Mut;
  deliveryEnabled: boolean;
  setDeliveryEnabled: (v: boolean) => void;
  slotFreeCount: number;
  stripe: StripeStatus;
  toast: Toast;
}) {
  return (
    <div className="flex flex-col gap-4">
      <CardGroup
        icon={Wallet}
        title="Плащане"
        desc="Как клиентите плащат поръчките си. Може и двете заедно — клиентът избира при поръчка."
      >
        <CodCard cfg={cfg} mut={mut} />
        <CardPaymentCard stripe={stripe} />
      </CardGroup>

      <CardGroup
        icon={Truck}
        title="Доставка"
        desc="Как клиентите получават поръчките си. Включи всеки начин, който предлагаш — клиентът избира при поръчка."
      >
        <PickupCard cfg={cfg} mut={mut} />
        <SelfDeliveryCard
          cfg={cfg}
          mut={mut}
          active={deliveryEnabled}
          setActive={setDeliveryEnabled}
          slotFreeCount={slotFreeCount}
        />
        <CourierCard cfg={cfg} mut={mut} toast={toast} />
        <FreeThresholdRow cfg={cfg} mut={mut} />
      </CardGroup>
    </div>
  );
}
