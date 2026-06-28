'use client';

import type { DeliveryConfig } from '@/lib/types';
import { DSection, Segmented } from './ui';

type Mut = (fn: (d: DeliveryConfig) => void) => void;

/**
 * Carrier policy — only meaningful when the farm runs BOTH carriers live (Econt
 * auto + Speedy configured). Picks who wins a до-адрес order: the customer, the
 * cheaper quote, or a forced carrier. Hidden otherwise so it's never a dead control.
 * (Carrier connection + monitoring itself lives in the standalone delivery app.)
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
