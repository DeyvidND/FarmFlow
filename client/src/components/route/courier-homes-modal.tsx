'use client';

import { useEffect, useState } from 'react';
import { X, Home as HomeIcon, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { AddressAutocomplete } from './address-autocomplete';
import { getTenant, updateTenant } from '@/lib/api-client';
import type { RouteEndMode, RoutingConfig } from '@/lib/types';

interface CourierHomeRow {
  homeAddress: string;
  homePin: { lat: number; lng: number } | null;
  // preserved so saving doesn't wipe fields this modal doesn't edit
  name?: string | null;
  endMode?: RouteEndMode;
}

/** One entry of the server-stored `settings.routing.couriers[]` array. */
type StoredCourier = NonNullable<RoutingConfig['couriers']>[number];

/** One edited row → its server payload shape (unresolved coords — the server
 *  geocodes `homeAddress` when no pin was picked). */
function rowToPayload(r: CourierHomeRow): StoredCourier {
  return {
    ...(r.name !== undefined ? { name: r.name } : {}),
    ...(r.endMode !== undefined ? { endMode: r.endMode } : {}),
    homeAddress: r.homeAddress || null,
    homeLat: r.homePin ? String(r.homePin.lat) : null,
    homeLng: r.homePin ? String(r.homePin.lng) : null,
  };
}

/**
 * Build the FULL `couriers` array to send on save. The server replaces the
 * stored array wholesale, index-aligned — so sending only today's visible
 * rows (which can be FEWER than the tenant's configured total on a lighter
 * day) would silently delete the saved home of any higher-index courier not
 * active today. Edited rows (index < editedRows.length) win; any index beyond
 * that is carried over UNCHANGED from `originalCouriers` (the full array as
 * originally loaded, before this modal trimmed it down to today's rows).
 * Exported (pure, no state) so it can be unit tested directly.
 */
export function mergeCourierRows(
  editedRows: CourierHomeRow[],
  originalCouriers: StoredCourier[],
): StoredCourier[] {
  const edited = editedRows.map(rowToPayload);
  const length = Math.max(edited.length, originalCouriers.length);
  return Array.from({ length }, (_, i) => (i < edited.length ? edited[i] : originalCouriers[i]));
}

/**
 * Sets each courier's home address „У дома" — where that courier's own leg
 * ends. The backend already ends a courier's route at their home once set
 * (falls back to the shared base otherwise).
 */
export function CourierHomesModal({
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
  const [rows, setRows] = useState<CourierHomeRow[]>(
    Array.from({ length: courierCount }, () => ({ homeAddress: '', homePin: null })),
  );
  // The FULL couriers array as originally loaded from the server — may be
  // longer than `rows` (today's visible/active courier count). Kept around
  // purely so save() can carry forward any higher-index courier's home
  // unchanged instead of the wholesale-replace wiping it (task fix).
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
            const lat = c?.homeLat;
            const lng = c?.homeLng;
            return {
              homeAddress: c?.homeAddress ?? '',
              homePin: lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null,
              name: c?.name ?? null,
              endMode: c?.endMode,
            };
          }),
        );
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courierCount]);

  const setAddress = (i: number, v: string) =>
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, homeAddress: v, homePin: null } : r)));
  const setPin = (i: number, pin: { lat: number; lng: number } | null) =>
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, homePin: pin } : r)));
  const clearRow = (i: number) =>
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, homeAddress: '', homePin: null } : r)));

  async function save() {
    setSaving(true);
    try {
      const couriers = mergeCourierRows(rows, originalCouriers);
      const updated = await updateTenant({ routing: { couriers } });
      // The server geocodes a typed homeAddress into homeLat/homeLng; on a
      // geocode miss it saves the address with NULL coords — the route then
      // silently keeps ending at the depot for that courier. Surface it
      // instead of a plain "Запазено" that hides the failure.
      const savedCouriers = updated.routing?.couriers ?? [];
      const failed = rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.homeAddress.trim().length > 0)
        .filter(({ i }) => savedCouriers[i]?.homeLat == null || savedCouriers[i]?.homeLng == null)
        .map(({ r, i }) => r.name?.trim() || `Куриер ${i + 1}`);
      if (failed.length) {
        toast.warning(
          `Адресът на ${failed.join(', ')} не е намерен на картата — маршрутът му ще завършва в базата, докато не оправиш адреса.`,
        );
      } else {
        toast.success('Домовете са запазени');
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
        aria-label="Домове на куриерите"
      >
        <div className="flex items-center justify-between border-b border-ff-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-[16px] font-extrabold text-ff-ink">
            <HomeIcon size={17} /> Домове на куриерите
          </h2>
          <button onClick={onClose} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <p className="border-b border-ff-border-2 bg-ff-surface-2 px-5 py-2.5 text-[12.5px] leading-relaxed text-ff-muted">
          Всеки куриер може да завършва маршрута си близо до своя дом. Въведи адрес и маршрутът на
          този куриер ще приключва там (иначе се връща до базата).
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
                    {(row.homeAddress || row.homePin) && (
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
                    label={`Дом на Куриер ${i + 1}`}
                    placeholder="Адрес, на който куриерът приключва"
                    value={row.homeAddress}
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
