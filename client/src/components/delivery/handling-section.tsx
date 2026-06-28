'use client';

import * as React from 'react';
import type { DeliveryConfig, InspectBeforePay } from '@/lib/types';
import { DSection, DLabel, Segmented } from './ui';

/**
 * Carrier-agnostic handling policy. Set once here; auto-applied to every COD/courier
 * shipment (storefront auto-orders included). Inspect-before-pay only affects наложен
 * платеж — it is ignored on a prepaid order.
 */
export function HandlingSection({
  cfg,
  mut,
}: {
  cfg: DeliveryConfig;
  mut: (fn: (d: DeliveryConfig) => void) => void;
}) {
  const h = cfg.handling ?? { inspectBeforePay: 'off' as InspectBeforePay, refrigerated: false };

  const setInspect = (v: InspectBeforePay) =>
    mut((d) => {
      d.handling = { ...(d.handling ?? { inspectBeforePay: 'off', refrigerated: false }), inspectBeforePay: v };
    });
  const setRefrigerated = (v: string) =>
    mut((d) => {
      d.handling = {
        ...(d.handling ?? { inspectBeforePay: 'off', refrigerated: false }),
        refrigerated: v === 'yes',
      };
    });

  return (
    <DSection
      title="Обработка на пратката"
      helper="Прилага се автоматично към всяка поръчка с Еконт. Прегледът/тестът важи само при наложен платеж. (Speedy — скоро.)"
    >
      <div className="flex flex-col gap-5">
        <DLabel
          label="Преглед преди плащане (наложен платеж)"
          hint="Клиентът може да отвори (или тества) пратката, преди да плати. Намалява отказите при храна. Само за Еконт."
        >
          <Segmented<InspectBeforePay>
            value={h.inspectBeforePay}
            onChange={setInspect}
            options={[
              { value: 'off', label: 'Изключено' },
              { value: 'open', label: 'Преглед (отвори)' },
              { value: 'test', label: 'Тест' },
            ]}
          />
        </DLabel>

        <DLabel label="Хладилна доставка" hint="Маркира пратките като хладилни/нетрайни (Еконт).">
          <Segmented<string>
            value={h.refrigerated ? 'yes' : 'no'}
            onChange={setRefrigerated}
            options={[
              { value: 'no', label: 'Не' },
              { value: 'yes', label: 'Да' },
            ]}
          />
        </DLabel>
      </div>
    </DSection>
  );
}
