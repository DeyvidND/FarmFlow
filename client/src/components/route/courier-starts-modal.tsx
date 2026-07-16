'use client';

import { useEffect, useState } from 'react';
import { X, Play, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { AddressAutocomplete } from './address-autocomplete';
import { getTenant, updateTenant } from '@/lib/api-client';
import type { RoutingConfig } from '@/lib/types';

interface CourierStartRow {
  startAddress: string;
  startPin: { lat: number; lng: number } | null;
}

/** One entry of the server-stored `settings.routing.couriers[]` array. */
type StoredCourier = NonNullable<RoutingConfig['couriers']>[number];

/** One edited start row → the server payload (server geocodes a typed address
 *  when no pin was picked). */
function rowToStart(r: CourierStartRow): Pick<StoredCourier, 'startAddress' | 'startLat' | 'startLng'> {
  return {
    startAddress: r.startAddress || null,
    startLat: r.startPin ? String(r.startPin.lat) : null,
    startLng: r.startPin ? String(r.startPin.lng) : null,
  };
}

/**
 * Merge the edited START rows into the FULL couriers array, preserving every
 * OTHER field (name, endMode, home*) and any higher-index courier not visible
 * today — the server replaces the stored array wholesale, so a partial send
 * would wipe them. Only the three `start*` fields per visible row change.
 * Exported (pure) for unit testing, mirroring `mergeCourierRows`.
 */
export function mergeStartRows(
  editedRows: CourierStartRow[],
  originalCouriers: StoredCourier[],
): StoredCourier[] {
  const length = Math.max(editedRows.length, originalCouriers.length);
  return Array.from({ length }, (_, i) => {
    const base = originalCouriers[i] ?? {};
    return i < editedRows.length ? { ...base, ...rowToStart(editedRows[i]) } : base;
  });
}

/**
 * Sets each courier's START address — where that courier's leg BEGINS. The
 * backend routes each courier's leg from this point (falls back to the farm
 * base when empty), independently of where the leg ends („Домове").
 */
export function CourierStartsModal({
  courierCount,
  placesKey,
  onClose,
  onSaved,
}: {
  courierCount: number;
  placesKey?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<CourierStartRow[]>(
    Array.from({ length: courierCount }, () => ({ startAddress: '', startPin: null })),
  );
  const [originalCouriers, setOriginalCouriers] = useState<StoredCourier[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getTenant()
      .then((t) => {
        const stored = t.routing?.couriers ?? [];
        setOriginalCouriers(stored);
        setRows(
          Array.from({ length: courierCount }, (_, i) => {
            const c = stored[i];
            const lat = c?.startLat;
            const lng = c?.startLng;
            return {
              startAddress: c?.startAddress ?? '',
              startPin: lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null,
            };
          }),
        );
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [courierCount]);

  const setAddress = (i: number, v: string) =>
    setRows((cur) => cur.map((r, idx) => (idx === i ? { startAddress: v, startPin: null } : r)));
  const setPin = (i: number, pin: { lat: number; lng: number } | null) =>
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, startPin: pin } : r)));
  const clearRow = (i: number) =>
    setRows((cur) => cur.map((r, idx) => (idx === i ? { startAddress: '', startPin: null } : r)));

  async function save() {
    setSaving(true);
    try {
      const couriers = mergeStartRows(rows, originalCouriers);
      const updated = await updateTenant({ routing: { couriers } });
      const savedCouriers = updated.routing?.couriers ?? [];
      // Surface a geocode miss (typed address the server couldn't place) — the
      // leg then silently falls back to starting from the base.
      const failed = rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.startAddress.trim().length > 0)
        .filter(({ i }) => savedCouriers[i]?.startLat == null || savedCouriers[i]?.startLng == null)
        .map(({ i }) => `Куриер ${i + 1}`);
      if (failed.length) {
        toast.warning(
          `Адресът на ${failed.join(', ')} не е намерен на картата — този куриер ще тръгва от базата, докато не оправиш адреса.`,
        );
      } else {
        toast.success('Началата са запазени');
      }
      onSaved();
    } catch {
      toast.error('Неуспешно записване');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Начала на куриерите"
      >
        <div className="flex items-center justify-between border-b border-ff-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-[16px] font-extrabold text-ff-ink">
            <Play size={16} /> Начала на куриерите
          </h2>
          <button onClick={onClose} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <p className="border-b border-ff-border-2 bg-ff-surface-2 px-5 py-2.5 text-[12.5px] leading-relaxed text-ff-muted">
          Всеки куриер може да тръгва от различно място. Въведи адрес и маршрутът на този куриер ще
          започва оттам (иначе тръгва от базата на фермата).
        </p>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="py-6 text-center text-[13px] text-ff-muted">Зареждане…</p>
          ) : (
            <div className="flex flex-col gap-5">
              {rows.map((row, i) => (
                <div key={i} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-extrabold text-ff-ink">Куриер {i + 1}</span>
                    {(row.startAddress || row.startPin) && (
                      <button
                        type="button"
                        onClick={() => clearRow(i)}
                        title="Изчисти"
                        className="inline-flex items-center gap-1 text-[12px] font-bold text-ff-ink-2 hover:text-ff-ink"
                      >
                        <Trash2 size={13} /> Изчисти
                      </button>
                    )}
                  </div>
                  <AddressAutocomplete
                    label={`Начало на Куриер ${i + 1}`}
                    placeholder="Адрес, от който куриерът тръгва (празно = базата)"
                    value={row.startAddress}
                    onChange={(v) => setAddress(i, v)}
                    onPick={(pin) => setPin(i, pin)}
                    apiKey={placesKey}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ff-border px-5 py-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Отказ
          </Button>
          <Button variant="primary" size="sm" disabled={saving || loading} onClick={() => void save()}>
            {saving ? 'Записване…' : 'Запази'}
          </Button>
        </div>
      </div>
    </div>
  );
}
