'use client';

import type { DeliveryConfig } from '@/lib/types';
import { DSection, LvInput } from './ui';

type Mut = (fn: (d: DeliveryConfig) => void) => void;

export function PricingSection({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  const p = cfg.pricing;
  return (
    <DSection
      title="Правила за цена (по желание)"
      helper="Цени в € (EUR), без ДДС. Задай праг за безплатна доставка — при поръчка над тази стойност доставката е безплатна."
      info={
        <>
          Цената на всеки начин на доставка се задава горе, в „Методи на доставка&quot;. Тук се задава
          само <b>прагът за безплатна доставка</b> — ако поръчката надхвърли тази сума,
          доставката е безплатна независимо от метода.
        </>
      }
    >
      <LvInput
        label="Праг за безплатна доставка"
        value={p.freeThresholdStotinki}
        onChange={(v) => mut((d) => (d.pricing.freeThresholdStotinki = v))}
      />
    </DSection>
  );
}
