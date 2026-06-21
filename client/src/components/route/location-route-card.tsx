'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { AddressAutocomplete } from './address-autocomplete';
import { getTenant, updateTenant } from '@/lib/api-client';
import type { RouteEndMode, RoutingConfig } from '@/lib/types';

// Only the two ends that need NO extra address. „По избор" (custom end address)
// is intentionally left out to keep the first-run setup simple.
const END_LABELS: { mode: RouteEndMode; label: string; hint: string }[] = [
  { mode: 'home', label: 'Към дома', hint: 'обратно до базата' },
  { mode: 'last', label: 'Край при клиента', hint: 'край при последната доставка' },
];

/**
 * Base-address setup, shown as a modal. The base address is the route's start
 * point. `forced` = the route can't be used yet (no address) → no close button,
 * the farmer must set it. `onClose` makes it dismissable; `onSaved` lets the route
 * page re-fetch so a changed base address moves the map's start point right away.
 */
export function LocationRouteCard({
  onSaved,
  onClose,
  forced = false,
}: {
  onSaved?: () => void;
  onClose?: () => void;
  forced?: boolean;
}) {
  const [home, setHome] = useState('');
  // Precise coords from a Places pick — when set, sent as farmLat/farmLng so the
  // backend skips geocoding and the route starts from the exact spot. null = the
  // address was typed/edited by hand → backend geocodes it.
  const [homePin, setHomePin] = useState<{ lat: number; lng: number } | null>(null);
  const [endMode, setEndMode] = useState<RouteEndMode>('home');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getTenant()
      .then((t) => {
        setHome(t.farmAddress ?? '');
        const r = (t.routing ?? {}) as RoutingConfig;
        // Fall back to 'home' for legacy 'custom' (no longer offered).
        setEndMode(r.endMode === 'last' ? 'last' : 'home');
      })
      .catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!home.trim()) {
      toast.error('Въведи адрес на базата');
      return;
    }
    setSaving(true);
    try {
      await updateTenant({
        farmAddress: home.trim(),
        ...(homePin ? { farmLat: homePin.lat, farmLng: homePin.lng } : {}),
        routing: { endMode, endAddress: '' },
      });
      toast.success('Локацията е запазена');
      onSaved?.();
    } catch {
      toast.error('Неуспешно записване');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="animate-ff-fade fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4"
      onClick={forced ? undefined : onClose}
    >
      <div
        className="animate-ff-pop w-[460px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Адрес на базата"
      >
        <div className="mb-1 flex items-start justify-between gap-3">
          <h2 className="text-[17px] font-extrabold">Адрес на базата</h2>
          {!forced && onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Затвори"
              className="-mr-1.5 -mt-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2 hover:text-ff-ink"
            >
              <X size={18} />
            </button>
          )}
        </div>
        <p className="mb-4 text-[13px] leading-relaxed text-ff-muted">
          Маршрутът за доставка тръгва от този адрес. Започни да пишеш и избери от
          подсказките за точна точка на картата.
        </p>

        <form onSubmit={save} className="flex flex-col gap-4">
          <AddressAutocomplete
            label="Адрес на базата (дом)"
            placeholder="напр. с. Звездица, общ. Варна"
            value={home}
            onChange={setHome}
            onPick={setHomePin}
          />

          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold text-ff-ink-2">Край на маршрута</span>
            <div className="flex flex-wrap gap-2">
              {END_LABELS.map(({ mode, label, hint }) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setEndMode(mode)}
                  className={`flex-1 rounded-sm border px-3 py-2.5 text-left transition ${
                    endMode === mode
                      ? 'border-ff-green-500 bg-ff-green-100'
                      : 'border-ff-border bg-ff-surface-2 hover:border-ff-green-500'
                  }`}
                >
                  <span className="block text-[14px] font-bold text-ff-ink">{label}</span>
                  <span className="block text-[12px] text-ff-muted">{hint}</span>
                </button>
              ))}
            </div>
          </div>

          <Button
            variant="primary"
            type="submit"
            disabled={saving}
            className="mt-0.5 w-full rounded-sm py-[13px] text-[15.5px]"
          >
            {saving ? 'Записване…' : 'Запази локацията'}
          </Button>
        </form>
      </div>
    </div>
  );
}
