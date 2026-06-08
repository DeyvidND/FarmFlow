'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Truck, AlertTriangle, Check } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { Button } from '@/components/ui/button';
import { ApiError, saveDelivery } from '@/lib/api-client';
import { hydrateDelivery } from '@/lib/delivery-data';
import type { DeliveryConfig } from '@/lib/types';
import { MethodsSection } from './methods-section';
import { ScheduleSection } from './schedule-section';
import { PricingSection } from './pricing-section';
import { EcontConnectionSection } from './econt-section';
import { OfficePickerPreview } from './office-picker-preview';
import { ShipmentsTable } from './shipments-table';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const toastAdapter = { success: toast.success, info: toast.info, error: toast.error };

export function DeliveryClient({
  initialEnabled,
  initialDelivery,
  slotFreeCount,
}: {
  initialEnabled: boolean;
  initialDelivery: DeliveryConfig | null;
  slotFreeCount: number;
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

  const enabledMethods = cfg.methods.order.filter((k) => cfg.methods[k].enabled);
  const noMethods = enabled && enabledMethods.length === 0;
  const econtReady = cfg.econt.configured;
  // Mode 'off' hides the courier accounting (office preview + shipments table) so
  // a self-delivery farm never sees Econt waybills.
  const econtMode = cfg.econt.mode ?? (cfg.econt.configured ? 'auto' : 'off');
  const locked = !enabled;

  const save = async () => {
    if (noMethods) {
      toast.info('Активирай поне един метод на доставка');
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
        <h1 className="font-display text-[26px] font-extrabold tracking-[-0.02em] text-ff-ink">Доставка</h1>
        <p className="mt-0.5 text-[14px] text-ff-ink-2">Настрой как клиентите получават поръчките си.</p>
      </div>

      {/* master toggle banner */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-4 rounded-[14px] border p-5 shadow-ff-sm',
          enabled ? 'border-ff-green-100 bg-ff-green-50' : 'border-ff-border bg-ff-surface',
        )}
      >
        <span
          className={cn(
            'grid h-11 w-11 shrink-0 place-items-center rounded-xl',
            enabled ? 'bg-ff-green-100 text-ff-green-700' : 'bg-ff-surface-2 text-ff-muted',
          )}
        >
          <Truck size={23} />
        </span>
        <div className="min-w-[220px] flex-1">
          <div className="text-[15.5px] font-extrabold text-ff-ink">Доставка активна</div>
          <div className="mt-0.5 max-w-[560px] text-[13px] leading-snug text-ff-ink-2">
            Когато е изключена, клиентите не виждат опции за доставка в магазина.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span
            className={cn('text-[13px] font-bold', enabled ? 'text-ff-green-700' : 'text-ff-muted')}
          >
            {enabled ? 'Включено' : 'Изключено'}
          </span>
          <ToggleSwitch checked={enabled} onChange={setEnabled} />
        </div>
      </div>

      {locked && (
        <div className="flex items-center gap-2.5 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-4 py-3 text-[13.5px] font-bold text-ff-amber-600">
          <AlertTriangle size={18} /> Доставката е изключена — клиентите не виждат опции за доставка в
          магазина.
        </div>
      )}

      {!locked && (
        <div className="rounded-[14px] border border-ff-green-100 bg-ff-green-50 px-5 py-4">
          <div className="text-[12.5px] font-extrabold uppercase tracking-[0.03em] text-ff-green-800">
            Три прости стъпки
          </div>
          <ol className="mt-2 flex flex-col gap-1.5 text-[13.5px] text-ff-ink-2">
            <li>
              <b>1.</b> Избери как клиентите получават поръчките си — секция „Методи на доставка“.
            </li>
            <li>
              <b>2.</b> Задай цена на всеки избран начин (натисни върху метода).
            </li>
            <li>
              <b>3.</b> <span className="font-semibold text-ff-muted">По желание:</span> свържи Еконт,
              само ако искаш доставка с куриер.
            </li>
          </ol>
        </div>
      )}

      <div className={cn('flex flex-col gap-4', locked && 'pointer-events-none opacity-50')}>
        <MethodsSection
          cfg={cfg}
          mut={mut}
          econtReady={econtReady}
          noMethods={noMethods}
          slotFreeCount={slotFreeCount}
        />
        <ScheduleSection cfg={cfg} mut={mut} />
        <PricingSection cfg={cfg} mut={mut} />
        <EcontConnectionSection cfg={cfg} mut={mut} toast={toastAdapter} />
        {econtMode === 'auto' && <OfficePickerPreview configured={econtReady} />}
        {econtMode === 'auto' && <ShipmentsTable toast={toastAdapter} />}
      </div>

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
