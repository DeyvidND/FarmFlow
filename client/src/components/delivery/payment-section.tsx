'use client';

import { Wallet } from 'lucide-react';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import type { DeliveryConfig } from '@/lib/types';
import { DSection, InfoNote } from './ui';

type Mut = (fn: (d: DeliveryConfig) => void) => void;

/**
 * Плащане — customer payment options. Right now this is the наложен платеж (COD)
 * switch: when on, customers can choose to pay at delivery (e.g. cash at the
 * Econt office) instead of online by card. Card payment is governed by the farm's
 * Stripe connection on the Payments page, not here.
 */
export function PaymentSection({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  const enabled = cfg.cod?.enabled ?? true;
  return (
    <DSection
      title="Плащане"
      helper="Как клиентите плащат поръчките си."
      info={
        <>
          <b>Наложен платеж</b> значи, че клиентът плаща при получаване — например в
          брой на гишето на Еконт, когато си вземе поръчката. Не изисква Еконт акаунт
          или API: ти просто пускаш пратката с „наложен платеж“, а Еконт събира сумата.
        </>
      }
    >
      <div className="flex items-center gap-3 rounded-xl border border-ff-border bg-ff-surface-2 px-[15px] py-3.5">
        <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border border-ff-border-2 bg-ff-surface text-ff-green-700">
          <Wallet size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-extrabold text-ff-ink">Наложен платеж</div>
          <div className="mt-px text-[12.5px] text-ff-muted">
            Клиентът плаща при доставка вместо онлайн с карта.
          </div>
        </div>
        <ToggleSwitch
          checked={enabled}
          onChange={(v) => mut((d) => (d.cod = { enabled: v }))}
        />
      </div>
      {!enabled && (
        <div className="mt-2.5">
          <InfoNote tone="green">
            Изключено — клиентите трябва да платят онлайн с карта (изисква свързан Stripe).
          </InfoNote>
        </div>
      )}
    </DSection>
  );
}
