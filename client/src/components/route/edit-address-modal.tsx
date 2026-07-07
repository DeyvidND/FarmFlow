'use client';

import { useEffect, useRef, useState } from 'react';
import { X, MapPin } from 'lucide-react';
import { APIProvider, Map, AdvancedMarker } from '@vis.gl/react-google-maps';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { AddressAutocomplete } from './address-autocomplete';
import { setStopLocation, reverseGeocode } from '@/lib/api-client';
import { mergedPayload } from './edit-address';
import type { RouteStop, RouteResult } from '@/lib/types';

// Reserved demo map id — renders AdvancedMarkers without cloud styling (same as route-map).
const MAP_ID = 'DEMO_MAP_ID';
const BG_CENTROID = { lat: 42.7339, lng: 25.4858 };
const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
// Wait this long after a map click/drag settles before reverse-geocoding it —
// avoids firing a lookup for every intermediate point while the farmer is
// still nudging the pin toward the right spot.
const REVERSE_GEOCODE_DEBOUNCE_MS = 500;

type Origin = RouteResult['origin'];
type LatLng = { lat: number; lng: number };

/**
 * Change a route stop's delivery point: type/search an address (Places
 * autocomplete) or click/drag a point on a small embedded map — both stay in
 * sync in one view. Picking a suggestion moves the pin; a map click/drag
 * fills the address (reverse geocoded, best-effort). Saves via
 * `setStopLocation`. Opened from the stop's edit icon and from the amber
 * „не е на картата" chip.
 */
export function EditAddressModal({
  stop,
  origin,
  mapsKey,
  placesKey,
  onClose,
  onSaved,
}: {
  stop: RouteStop;
  origin: Origin;
  mapsKey?: string;
  placesKey?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [addr, setAddr] = useState(stop.address ?? '');
  const [pin, setPin] = useState<LatLng | null>(
    stop.lat != null && stop.lng != null ? { lat: stop.lat, lng: stop.lng } : null,
  );
  const [saving, setSaving] = useState(false);
  const key = mapsKey || MAPS_KEY;

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const geocodeGenRef = useRef(0);
  useEffect(() => {
    // Clear any pending reverse-geocode lookup if the modal closes mid-debounce,
    // and bump the generation so an in-flight fetch's result is dropped too.
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      geocodeGenRef.current += 1;
    };
  }, []);

  const mapCenter: LatLng =
    pin ??
    (origin.lat != null && origin.lng != null
      ? { lat: origin.lat, lng: origin.lng }
      : BG_CENTROID);

  /** Map click/drag: move the pin now, reverse-geocode it after it settles. */
  function onMapPointChange(lat: number, lng: number) {
    setPin({ lat, lng });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const gen = ++geocodeGenRef.current;
    debounceRef.current = setTimeout(() => {
      reverseGeocode(lat, lng)
        .then(({ address }) => {
          if (address && geocodeGenRef.current === gen) setAddr(address);
        })
        .catch(() => {
          // Best-effort convenience only — the pin already reflects the
          // click regardless of whether the address lookup succeeds.
        });
    }, REVERSE_GEOCODE_DEBOUNCE_MS);
  }

  async function save() {
    if (!pin && !addr.trim()) {
      toast.error('Въведи адрес или кликни на картата');
      return;
    }
    setSaving(true);
    try {
      await setStopLocation(stop.id, mergedPayload(addr, pin));
      toast.success(pin ? 'Точката е записана' : 'Адресът е обновен');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Неуспешно записване');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="animate-ff-fade fixed inset-0 z-[95] grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="animate-ff-pop w-[460px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Смени адрес"
      >
        <div className="mb-1 flex items-start justify-between gap-3">
          <h2 className="text-[17px] font-extrabold">
            Смени адрес{stop.customer ? ` — ${stop.customer}` : ''}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Затвори"
            className="-mr-1.5 -mt-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2 hover:text-ff-ink"
          >
            <X size={18} />
          </button>
        </div>

        <p className="mb-4 text-[13px] leading-relaxed text-ff-muted">
          Избери от подсказките или кликни/провлачи пина на картата — адресът и
          точката се обновяват заедно.
        </p>

        <div className="flex flex-col gap-4">
          <AddressAutocomplete
            label="Адрес за доставка"
            placeholder="напр. ул. Иван Вазов 12, Варна"
            value={addr}
            onChange={setAddr}
            onPick={(p) => {
              if (p) setPin(p);
            }}
            apiKey={placesKey}
          />

          {key ? (
            <div className="h-[300px] overflow-hidden rounded-xl border border-ff-border">
              <APIProvider apiKey={key} language="bg" region="BG">
                <Map
                  mapId={MAP_ID}
                  defaultCenter={mapCenter}
                  defaultZoom={pin ? 15 : 12}
                  gestureHandling="greedy"
                  disableDefaultUI={false}
                  draggableCursor="crosshair"
                  onClick={(e) => {
                    const ll = e.detail.latLng;
                    if (ll) onMapPointChange(ll.lat, ll.lng);
                  }}
                  style={{ width: '100%', height: '100%' }}
                >
                  {origin.lat != null && origin.lng != null && (
                    <AdvancedMarker
                      position={{ lat: origin.lat, lng: origin.lng }}
                      title={origin.address ?? 'База'}
                    >
                      <span className="grid h-[26px] w-[26px] place-items-center rounded-full bg-white text-[14px] font-bold text-ff-green-800 shadow-ff-md ring-2 ring-ff-green-700">
                        ★
                      </span>
                    </AdvancedMarker>
                  )}
                  {pin && (
                    <AdvancedMarker
                      position={pin}
                      title={stop.customer ?? 'Клиент'}
                      draggable
                      onDragEnd={(e) => {
                        const ll = e.latLng;
                        if (ll) onMapPointChange(ll.lat(), ll.lng());
                      }}
                    >
                      <MapPin size={30} className="-translate-y-1 fill-ff-green-700 text-white" />
                    </AdvancedMarker>
                  )}
                </Map>
              </APIProvider>
            </div>
          ) : (
            <p className="rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-3 text-[13px] font-bold text-ff-amber-600">
              Картата не е налична тук. Въведи адреса в полето по-горе.
            </p>
          )}

          <Button
            variant="primary"
            type="button"
            onClick={save}
            disabled={saving}
            className="w-full rounded-sm py-[13px] text-[15.5px]"
          >
            {saving ? 'Записване…' : 'Запази'}
          </Button>
        </div>
      </div>
    </div>
  );
}
