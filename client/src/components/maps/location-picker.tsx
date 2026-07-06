'use client';

import { APIProvider, Map, AdvancedMarker, useMapsLibrary, useMap } from '@vis.gl/react-google-maps';
import { useEffect, useRef } from 'react';

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
const MAP_ID = 'DEMO_MAP_ID';
const BG_CENTROID = { lat: 42.7339, lng: 25.4858 };

interface LocationPickerProps {
  lat: number | null;
  lng: number | null;
  /** Called with the clicked coordinates. */
  onPick: (lat: number, lng: number) => void;
  /** Called with the reverse-geocoded address of a clicked point, if the
   *  Geocoding API resolves one — lets the caller fill an address field from
   *  a map click. Optional; the pin drops regardless. */
  onAddress?: (address: string) => void;
}

/**
 * Click-to-drop location picker. With a Maps key it renders a real Google map;
 * a click drops/moves the pin and reports lat/lng. With no key it renders a
 * short placeholder (instead of a blank section), since the map is optional.
 */
export function LocationPicker({ lat, lng, onPick, onAddress }: LocationPickerProps) {
  if (!MAPS_KEY) {
    return (
      <div className="grid h-[120px] w-full place-items-center rounded-2xl border border-dashed border-ff-border bg-ff-surface-2 px-4 text-center text-[12.5px] leading-snug text-ff-muted">
        Картата не е налична в момента. Локацията е по избор — магазинът работи и без нея.
      </div>
    );
  }

  return (
    <div className="h-[260px] w-full overflow-hidden rounded-2xl border border-ff-border">
      <APIProvider apiKey={MAPS_KEY} language="bg" region="BG">
        <PickerMap lat={lat} lng={lng} onPick={onPick} onAddress={onAddress} />
      </APIProvider>
    </div>
  );
}

/** The map itself — split out so it can use `useMapsLibrary` (which must run
 *  inside `APIProvider`) to reverse-geocode a clicked point. */
function PickerMap({ lat, lng, onPick, onAddress }: LocationPickerProps) {
  const has = lat != null && lng != null;
  const center = has ? { lat: lat as number, lng: lng as number } : BG_CENTROID;

  // Load the geocoding library lazily; a Geocoder needs the Geocoding API on the
  // key. If it never loads, clicks still drop the pin — address just isn't filled.
  const geocodingLib = useMapsLibrary('geocoding');
  // Infer the Geocoder type from the loaded library value so we don't depend on
  // the global `google` namespace being in scope.
  const geocoderRef = useRef<InstanceType<NonNullable<typeof geocodingLib>['Geocoder']> | null>(null);
  useEffect(() => {
    if (geocodingLib && !geocoderRef.current) geocoderRef.current = new geocodingLib.Geocoder();
  }, [geocodingLib]);

  // Recenter on the pin when it changes from outside (e.g. an address pick), so
  // the point is always in view. `defaultCenter` only applies on mount.
  const map = useMap();
  useEffect(() => {
    if (!map || !has) return;
    map.panTo({ lat: lat as number, lng: lng as number });
    if ((map.getZoom() ?? 0) < 13) map.setZoom(15);
  }, [map, has, lat, lng]);

  async function handleClick(laClicked: number, lnClicked: number) {
    onPick(laClicked, lnClicked);
    const geocoder = geocoderRef.current;
    if (!onAddress || !geocoder) return;
    try {
      const { results } = await geocoder.geocode({ location: { lat: laClicked, lng: lnClicked } });
      if (results[0]) {
        // Drop the trailing country so it reads like the typed addresses.
        const addr = results[0].formatted_address.replace(/,?\s*(България|Bulgaria)\s*$/i, '');
        onAddress(addr);
      }
    } catch {
      // No result / API error → keep the pin, leave the address as-is.
    }
  }

  return (
    <Map
      mapId={MAP_ID}
      defaultCenter={center}
      defaultZoom={has ? 14 : 7}
      gestureHandling="greedy"
      disableDefaultUI={false}
      style={{ width: '100%', height: '100%' }}
      onClick={(e) => {
        const ll = e.detail.latLng;
        if (ll) handleClick(ll.lat, ll.lng);
      }}
    >
      {has && (
        <AdvancedMarker position={{ lat: lat as number, lng: lng as number }}>
          {/* A childless AdvancedMarker can render nothing on a DEMO_MAP_ID
              map — give it an explicit pin so the dropped point is visible. */}
          <span className="block h-5 w-5 -translate-y-1/2 rounded-full border-[3px] border-white bg-ff-green-600 shadow-md" />
        </AdvancedMarker>
      )}
    </Map>
  );
}
