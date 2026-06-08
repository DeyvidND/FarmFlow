'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { getTenant, updateTenant } from '@/lib/api-client';
import type { RouteEndMode, RoutingConfig } from '@/lib/types';

const END_LABELS: { mode: RouteEndMode; label: string; hint: string }[] = [
  { mode: 'home', label: 'Към дома', hint: 'обратно до базата' },
  { mode: 'last', label: 'Едностранно', hint: 'край при последната доставка' },
  { mode: 'custom', label: 'По избор', hint: 'друг адрес' },
];

/**
 * The base-address + route-end defaults, edited straight from the route screen.
 * `onSaved` lets the route page re-fetch so a changed base address moves the
 * map's start point right away.
 */
export function LocationRouteCard({ onSaved }: { onSaved?: () => void }) {
  const [home, setHome] = useState('');
  const [endMode, setEndMode] = useState<RouteEndMode>('home');
  const [endAddr, setEndAddr] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getTenant()
      .then((t) => {
        setHome(t.farmAddress ?? '');
        const r = (t.routing ?? {}) as RoutingConfig;
        setEndMode(r.endMode ?? 'home');
        setEndAddr(r.endAddress ?? '');
      })
      .catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateTenant({
        farmAddress: home.trim(),
        routing: { endMode, endAddress: endMode === 'custom' ? endAddr.trim() : '' },
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
    <div className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
      <h2 className="mb-1 text-[16px] font-extrabold">Локация и маршрут</h2>
      <p className="mb-4 text-[13px] text-ff-muted">
        Адресът на базата е началото на маршрута за доставка. Запазва се като точка на картата.
      </p>
      <form onSubmit={save} className="flex flex-col gap-4">
        <TextField
          label="Адрес на базата (дом)"
          placeholder="напр. с. Звездица, общ. Варна"
          value={home}
          onChange={(e) => setHome(e.target.value)}
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

        {endMode === 'custom' && (
          <TextField
            label="Краен адрес"
            placeholder="напр. бул. Сливница 33, Варна"
            value={endAddr}
            onChange={(e) => setEndAddr(e.target.value)}
          />
        )}

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
  );
}
