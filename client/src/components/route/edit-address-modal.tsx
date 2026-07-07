'use client';

import { useState } from 'react';
import { X, MapPin } from 'lucide-react';
import { APIProvider, Map, AdvancedMarker } from '@vis.gl/react-google-maps';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { AddressAutocomplete } from './address-autocomplete';
import { setStopLocation } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { initialEditTab, addressPayload, type EditTab } from './edit-address';
import type { RouteStop, MultiRouteResult } from '@/lib/types';

// Reserved demo map id — renders AdvancedMarkers without cloud styling (same as route-map).
const MAP_ID = 'DEMO_MAP_ID';
const BG_CENTROID = { lat: 42.7339, lng: 25.4858 };
const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

type Origin = MultiRouteResult['origin'];
type LatLng = { lat: number; lng: number };

const TABS: { id: EditTab; label: string }[] = [
  { id: 'address', label: 'Адрес' },
  { id: 'map', label: 'Карта' },
];

/**
 * Change a route stop's delivery point two ways: type/search an address
 * (Places autocomplete) or click a point on a small embedded map. Both save via
 * the same `setStopLocation` endpoint. Opened from the stop's edit icon and from
 * the amber „не е на картата" chip.
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
  const [tab, setTab] = useState<EditTab>(() => initialEditTab(stop));

  // Адрес tab: the text + an optional exact pin from a picked suggestion.
  const [addr, setAddr] = useState(stop.address ?? '');
  const [addrPin, setAddrPin] = useState<LatLng | null>(null);

  // Карта tab: the pin being placed (seeded from the stop's current coords).
  const [mapPin, setMapPin] = useState<LatLng | null>(
    stop.lat != null && stop.lng != null ? { lat: stop.lat, lng: stop.lng } : null,
  );

  const [saving, setSaving] = useState(false);
  const key = mapsKey || MAPS_KEY;

  const mapCenter: LatLng =
    mapPin ??
    (origin.lat != null && origin.lng != null
      ? { lat: origin.lat, lng: origin.lng }
      : BG_CENTROID);

  async function saveAddress() {
    if (!addr.trim()) {
      toast.error('Въведи адрес');
      return;
    }
    setSaving(true);
    try {
      await setStopLocation(stop.id, addressPayload(addr, addrPin));
      toast.success('Адресът е обновен');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Адресът не е намерен — пробвай таб „Карта“');
    } finally {
      setSaving(false);
    }
  }

  async function saveMap() {
    if (!mapPin) {
      toast.error('Кликни на картата, за да поставиш пин');
      return;
    }
    setSaving(true);
    try {
      await setStopLocation(stop.id, { lat: mapPin.lat, lng: mapPin.lng });
      toast.success('Точката е записана');
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
        <div className="mb-2 flex items-start justify-between gap-3">
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

        {/* two ways to set the point */}
        <div className="mb-4 flex gap-1 rounded-xl border border-ff-border bg-ff-surface-2 p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'flex-1 rounded-lg px-3 py-2 text-[13.5px] font-bold transition',
                tab === t.id
                  ? 'bg-ff-surface text-ff-green-800 shadow-ff-sm'
                  : 'text-ff-ink-2 hover:text-ff-ink',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'address' ? (
          <div className="flex flex-col gap-4">
            <AddressAutocomplete
              label="Адрес за доставка"
              placeholder="напр. ул. Иван Вазов 12, Варна"
              value={addr}
              onChange={setAddr}
              onPick={setAddrPin}
              apiKey={placesKey}
            />
            <Button
              variant="primary"
              type="button"
              onClick={saveAddress}
              disabled={saving}
              className="w-full rounded-sm py-[13px] text-[15.5px]"
            >
              {saving ? 'Записване…' : 'Запази адреса'}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {key ? (
              <>
                <p className="text-[13px] leading-relaxed text-ff-muted">
                  Кликни на точното място на картата. ★ е базата ти.
                </p>
                <div className="h-[300px] overflow-hidden rounded-xl border border-ff-border">
                  <APIProvider apiKey={key} language="bg" region="BG">
                    <Map
                      mapId={MAP_ID}
                      defaultCenter={mapCenter}
                      defaultZoom={mapPin ? 15 : 12}
                      gestureHandling="greedy"
                      disableDefaultUI={false}
                      draggableCursor="crosshair"
                      onClick={(e) => {
                        const ll = e.detail.latLng;
                        if (ll) setMapPin({ lat: ll.lat, lng: ll.lng });
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
                      {mapPin && (
                        <AdvancedMarker
                          position={mapPin}
                          title={stop.customer ?? 'Клиент'}
                          draggable
                          onDragEnd={(e) => {
                            const ll = e.latLng;
                            if (ll) setMapPin({ lat: ll.lat(), lng: ll.lng() });
                          }}
                        >
                          <MapPin size={30} className="-translate-y-1 fill-ff-green-700 text-white" />
                        </AdvancedMarker>
                      )}
                    </Map>
                  </APIProvider>
                </div>
                <Button
                  variant="primary"
                  type="button"
                  onClick={saveMap}
                  disabled={saving || !mapPin}
                  className="w-full rounded-sm py-[13px] text-[15.5px]"
                >
                  {saving ? 'Записване…' : 'Запази точката'}
                </Button>
              </>
            ) : (
              <p className="rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-3 text-[13px] font-bold text-ff-amber-600">
                Картата не е налична тук. Ползвай таб „Адрес“.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
