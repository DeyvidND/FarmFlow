'use client';

import { APIProvider, Map, AdvancedMarker } from '@vis.gl/react-google-maps';

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
const MAP_ID = 'DEMO_MAP_ID';
const BG_CENTROID = { lat: 42.7339, lng: 25.4858 };

interface LocationPickerProps {
  lat: number | null;
  lng: number | null;
  /** Called with the clicked coordinates. */
  onPick: (lat: number, lng: number) => void;
}

/**
 * Click-to-drop location picker. With a Maps key it renders a real Google map;
 * a click drops/moves the pin and reports lat/lng. With no key it renders
 * nothing (the numeric inputs in the parent card remain the manual fallback),
 * matching the project's stub-when-empty maps convention.
 */
export function LocationPicker({ lat, lng, onPick }: LocationPickerProps) {
  if (!MAPS_KEY) return null;
  const has = lat != null && lng != null;
  const center = has ? { lat: lat as number, lng: lng as number } : BG_CENTROID;

  return (
    <div className="h-[260px] w-full overflow-hidden rounded-2xl border border-ff-border">
      <APIProvider apiKey={MAPS_KEY} language="bg" region="BG">
        <Map
          mapId={MAP_ID}
          defaultCenter={center}
          defaultZoom={has ? 14 : 7}
          gestureHandling="greedy"
          disableDefaultUI={false}
          style={{ width: '100%', height: '100%' }}
          onClick={(e) => {
            const ll = e.detail.latLng;
            if (ll) onPick(ll.lat, ll.lng);
          }}
        >
          {has && <AdvancedMarker position={{ lat: lat as number, lng: lng as number }} />}
        </Map>
      </APIProvider>
    </div>
  );
}
