'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ApiError, saveDelivery } from '@/lib/api-client';
import { hydrateDelivery } from '@/lib/delivery-data';
import type { DeliveryConfig } from '@/lib/types';
import { DeliveryPanel, type StripeStatus } from './delivery-panel';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const toastAdapter = { success: toast.success, info: toast.info, error: toast.error };

export function DeliveryClient({
  initialEnabled,
  initialDelivery,
  slotFreeCount,
  stripe,
}: {
  initialEnabled: boolean;
  initialDelivery: DeliveryConfig | null;
  slotFreeCount: number;
  stripe: StripeStatus;
}) {
  const router = useRouter();
  const base = React.useMemo(() => hydrateDelivery(initialDelivery), [initialDelivery]);

  // `enabled` is the tenant's `deliveryEnabled` flag — now owned by the
  // self-delivery card (storefront gates personal delivery on it).
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

  // At least one way to receive an order must be on (pickup / self-delivery /
  // courier). Payment choice is independent.
  const econtOn = (cfg.econt.mode ?? (cfg.econt.configured ? 'auto' : 'off')) !== 'off';
  const noWayToOrder =
    !cfg.methods.pickup.enabled && !(enabled && cfg.methods.ownSlots.enabled) && !econtOn;

  const save = async () => {
    if (noWayToOrder) {
      toast.info('Активирай поне един начин на доставка (вземане, лична доставка или куриер)');
      return;
    }
    setSaving(true);
    try {
      await saveDelivery({ deliveryEnabled: enabled, delivery: cfg });
      setSavedEnabled(enabled);
      setSavedCfg(structuredClone(cfg));
      // Invalidate the Next Router Cache so the gated screens (Слотове / Производство
      // / Маршрут) reflect the new deliveryEnabled on next navigation — without a
      // manual browser refresh.
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

  return (
    <div className={cn('animate-ff-fade-up flex flex-col gap-4', dirty && 'pb-20')}>
      <div className="mb-1">
        <h1 className="font-display text-[26px] font-extrabold tracking-[-0.02em] text-ff-ink">
          Доставка и плащане
        </h1>
        <p className="mt-0.5 text-[14px] text-ff-ink-2">
          Включи начините, по които клиентите плащат и получават поръчките си.
        </p>
      </div>

      <DeliveryPanel
        cfg={cfg}
        mut={mut}
        deliveryEnabled={enabled}
        setDeliveryEnabled={setEnabled}
        slotFreeCount={slotFreeCount}
        stripe={stripe}
        toast={toastAdapter}
      />

      {/* sticky save bar */}
      {dirty && (
        <div className="animate-ff-fade-up fixed inset-x-0 bottom-0 z-30 flex items-center justify-center gap-3.5 bg-ff-green-950 px-5 py-3 text-white shadow-[0_-8px_30px_rgba(0,0,0,0.18)]">
          <span className="inline-flex items-center gap-2 text-[14px] font-bold">
            <span className="animate-ff-pulse h-2 w-2 rounded-full bg-ff-amber" />
            Имаш незапазени промени
          </span>
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={discard}
              disabled={saving}
              className="rounded-sm border border-white/20 bg-white/10 px-4 py-2 text-[14px] font-bold text-white transition-colors hover:bg-white/20 disabled:opacity-50"
            >
              Отмени
            </button>
            <Button variant="amber" size="sm" onClick={save} disabled={saving}>
              <Check size={16} /> {saving ? 'Записване…' : 'Запази промените'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
