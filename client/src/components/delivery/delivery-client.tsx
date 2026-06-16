'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ApiError, saveDelivery } from '@/lib/api-client';
import { hydrateDelivery } from '@/lib/delivery-data';
import type { DeliveryConfig } from '@/lib/types';
import { MethodsSection } from './methods-section';
import { EcontConnectionSection } from './econt-section';
import { OfficePickerPreview } from './office-picker-preview';
import { ShipmentsTable } from './shipments-table';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const toastAdapter = { success: toast.success, info: toast.info, error: toast.error };

/**
 * Доставка — **configuration only**. The on/off switches (which methods + COD are
 * offered, whether the courier is on) live in „Методи и цени"
 * (`/setup`, под Настройки → Конфигурации); this page sets up the details of the methods that are switched on:
 * prices, the Econt connection/sender/package, the office map and shipments. The
 * tenant's `deliveryEnabled` flag is carried through unchanged on save.
 */
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

  // deliveryEnabled is owned by the panel — keep it as loaded and send it back
  // unchanged so a config save here never flips it.
  const [enabled] = React.useState(initialEnabled);
  const [savedCfg, setSavedCfg] = React.useState<DeliveryConfig>(() => structuredClone(base));
  const [cfg, setCfg] = React.useState<DeliveryConfig>(() => structuredClone(base));
  const [saving, setSaving] = React.useState(false);

  const mut = (fn: (d: DeliveryConfig) => void) =>
    setCfg((prev) => {
      const d = structuredClone(prev);
      fn(d);
      return d;
    });

  const dirty = JSON.stringify(cfg) !== JSON.stringify(savedCfg);

  const econtReady = cfg.econt.configured;
  const econtMode = cfg.econt.mode ?? (cfg.econt.configured ? 'auto' : 'off');

  const save = async () => {
    setSaving(true);
    try {
      await saveDelivery({ deliveryEnabled: enabled, delivery: cfg });
      setSavedCfg(structuredClone(cfg));
      router.refresh();
      toast.success('Настройките са запазени');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => setCfg(structuredClone(savedCfg));

  return (
    <div className={cn('animate-ff-fade-up flex flex-col gap-4', dirty && 'pb-20')}>
      <div className="mb-1">
        <h1 className="font-display text-[26px] font-extrabold tracking-[-0.02em] text-ff-ink">Доставка</h1>
        <p className="mt-0.5 text-[14px] text-ff-ink-2">
          Настрой детайлите на методите за доставка, които предлагаш.
        </p>
      </div>

      {/* The on/off lives in the panel — point there. */}
      <Link
        href="/setup"
        className="flex items-center gap-3 rounded-[14px] border border-ff-border bg-ff-surface-2 px-4 py-3 transition-colors hover:border-ff-green-100 hover:bg-ff-green-50"
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-ff-green-100 text-ff-green-700">
          <SlidersHorizontal size={18} />
        </span>
        <div className="min-w-0 flex-1 text-[13px] leading-snug text-ff-ink-2">
          Кои методи и плащания се предлагат се избира от <b className="text-ff-ink">„Методи и цени”</b> (Настройки → Конфигурации).
          Тук задаваш само настройките им.
        </div>
        <span className="shrink-0 text-[13px] font-bold text-ff-green-700">Към панела →</span>
      </Link>

      <div className="flex flex-col gap-4">
        <MethodsSection cfg={cfg} mut={mut} slotFreeCount={slotFreeCount} />
        {econtMode !== 'off' && <EcontConnectionSection cfg={cfg} mut={mut} toast={toastAdapter} />}
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
