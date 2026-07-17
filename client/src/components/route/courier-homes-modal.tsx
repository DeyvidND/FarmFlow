'use client';

import { useEffect, useState } from 'react';
import { X, Home as HomeIcon, Trash2, KeyRound, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { AddressAutocomplete } from './address-autocomplete';
import { getTenant, listRouteCouriers, updateTenant } from '@/lib/api-client';
import type { LegIndex, RouteCourier, RouteEndMode, RoutingConfig } from '@/lib/types';


interface CourierHomeRow {
  homeAddress: string;
  homePin: { lat: number; lng: number } | null;
  // preserved so saving doesn't wipe fields this modal doesn't edit
  name?: string | null;
  endMode?: RouteEndMode;
}

/** One entry of the server-stored `settings.routing.couriers[]` array. */
type StoredCourier = NonNullable<RoutingConfig['couriers']>[number];

/**
 * One edited row → its server payload shape (unresolved coords — the server
 * geocodes `homeAddress` when no pin was picked).
 *
 * PATCHES `original` rather than rebuilding it: this modal owns only the three
 * home* fields, and the server replaces the stored couriers array wholesale, so
 * anything not carried over here is DELETED. Listing the fields to preserve
 * instead goes stale the moment one is added elsewhere — which is exactly how
 * saving „Домове" came to wipe the per-courier start base (startAddress/Lat/Lng,
 * added later by CourierStartsModal). Spread first, own last: a field this modal
 * has never heard of survives by default.
 */
function rowToPayload(r: CourierHomeRow, original?: StoredCourier): StoredCourier {
  return {
    ...original,
    ...(r.name !== undefined ? { name: r.name } : {}),
    ...(r.endMode !== undefined ? { endMode: r.endMode } : {}),
    homeAddress: r.homeAddress || null,
    homeLat: r.homePin ? String(r.homePin.lat) : null,
    homeLng: r.homePin ? String(r.homePin.lng) : null,
  };
}

/**
 * Build the FULL `couriers` array to send on save. The server replaces the stored
 * array wholesale, so every index must be accounted for: any leg this modal did
 * not show is carried over UNCHANGED from `originalCouriers` (the full array as
 * loaded), or its saved home is deleted.
 *
 * `legs[pos]` is the REAL leg the row at `pos` edits. The rows are NOT a prefix
 * of couriers[]: on a gap day the board can assign legs [0, 2], so row 1 is
 * „Куриер 3" and belongs at couriers[2] — writing it to couriers[1] would edit a
 * leg nobody drives today AND leave leg 2's home unset, silently sending that
 * courier back to the farm.
 *
 * Exported (pure, no state) so it can be unit tested directly.
 */
export function mergeCourierRows(
  editedRows: CourierHomeRow[],
  originalCouriers: StoredCourier[],
  legs: LegIndex[],
): StoredCourier[] {
  const length = Math.max(originalCouriers.length, ...legs.map((l) => l + 1), 0);
  const out: StoredCourier[] = Array.from({ length }, (_, i) => originalCouriers[i]);
  legs.forEach((leg, pos) => {
    if (pos < editedRows.length) out[leg] = rowToPayload(editedRows[pos], originalCouriers[leg]);
  });
  return out;
}

/**
 * Sets each courier's home address „У дома" — where that courier's own leg
 * ends. The backend already ends a courier's route at their home once set
 * (falls back to the shared base otherwise).
 */
export function CourierHomesModal({
  legs,
  placesKey,
  onClose,
  onSaved,
}: {
  /** The REAL leg numbers on the board today, in display order — e.g. [0, 2] on a
   *  gap day. NOT a count: row `pos` edits `couriers[legs[pos]]`. */
  legs: LegIndex[];
  placesKey?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<CourierHomeRow[]>(
    legs.map(() => ({ homeAddress: '', homePin: null })),
  );
  // The FULL couriers array as originally loaded from the server — may be
  // longer than `rows` (today's visible/active courier count). Kept around
  // purely so save() can carry forward any higher-index courier's home
  // unchanged instead of the wholesale-replace wiping it (task fix).
  const [originalCouriers, setOriginalCouriers] = useState<StoredCourier[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Read-only tenant courier roster (drivers + own account) — Task C1.
  // Loaded once alongside the tenant fetch below, independent of
  // `rows`/`originalCouriers` (addresses); accounts are created/removed by
  // the platform operator in the super-admin console, not from here.
  const [couriers, setCouriers] = useState<RouteCourier[]>([]);
  const [rosterLoading, setRosterLoading] = useState(true);

  useEffect(() => {
    getTenant()
      .then((t) => {
        const stored = t.routing?.couriers ?? [];
        setOriginalCouriers(stored);
        setRows(
          // Read each row from its REAL leg, mirroring how the server resolves it
          // (couriersCfg[posToLeg[i]]) — stored[pos] would show leg 1's home under
          // „Куриер 3" on a gap day.
          legs.map((leg) => {
            const c = stored[leg];
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

    listRouteCouriers()
      .then(setCouriers)
      .catch(() => {})
      .finally(() => setRosterLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs.join(',')]);

  const setAddress = (i: number, v: string) =>
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, homeAddress: v, homePin: null } : r)));
  const setPin = (i: number, pin: { lat: number; lng: number } | null) =>
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, homePin: pin } : r)));
  const clearRow = (i: number) =>
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, homeAddress: '', homePin: null } : r)));

  async function save() {
    setSaving(true);
    try {
      const couriers = mergeCourierRows(rows, originalCouriers, legs);
      const updated = await updateTenant({ routing: { couriers } });
      // The server geocodes a typed homeAddress into homeLat/homeLng; on a
      // geocode miss it saves the address with NULL coords — the route then
      // silently keeps ending at the depot for that courier. Surface it
      // instead of a plain "Запазено" that hides the failure.
      const savedCouriers = updated.routing?.couriers ?? [];
      const failed = rows
        .map((r, i) => ({ r, leg: legs[i] }))
        .filter(({ r }) => r.homeAddress.trim().length > 0)
        // By REAL leg: savedCouriers[pos] would check a leg this row never wrote,
        // so a failed geocode on a gap day still toasted „Домовете са запазени".
        .filter(({ leg }) => savedCouriers[leg]?.homeLat == null || savedCouriers[leg]?.homeLng == null)
        .map(({ r, leg }) => r.name?.trim() || `Куриер ${leg + 1}`);
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
                    <span className="text-[13px] font-extrabold text-ff-ink">Куриер {legs[i] + 1}</span>
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

          {/* Read-only courier account roster (Task C1) — separate concern
              from the home addresses above; accounts are created/removed by
              the platform operator, not from this modal. */}
          <div className="mt-6 flex flex-col gap-2 rounded-lg border border-ff-border-2 bg-ff-surface-2 px-3 py-3">
            <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wide text-ff-muted">
              <KeyRound size={13} /> Куриери на фермата
            </div>
            {rosterLoading ? (
              <p className="text-[12.5px] text-ff-muted">Зареждане…</p>
            ) : couriers.length === 0 ? (
              <p className="text-[12.5px] text-ff-muted">Все още няма създадени акаунти за куриери.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {couriers.map((c) => (
                  <li key={c.accountId} className="flex items-center gap-1.5 text-[12.5px] font-bold text-ff-ink-2">
                    <UserRound size={13} className="text-ff-muted" />
                    {c.email}
                    {c.isSelf && <span className="font-normal text-ff-muted">(ти)</span>}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[12px] leading-relaxed text-ff-muted">
              Акаунтите за куриерите се създават от екипа на платформата — свържи се с нас, ако трябва
              нов достъп.
            </p>
          </div>
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
