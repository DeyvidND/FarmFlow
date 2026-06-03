'use client';

/**
 * Delivery-address field with Google Places autocomplete + a draggable map pin.
 *
 * Customer types → picks a suggestion → a pin drops and we capture precise
 * lat/lng (they can drag the pin to fine-tune). The resolved coordinates ride
 * along with the order so the farm's route map shows a real point.
 *
 * Graceful fallback: with no NEXT_PUBLIC_GOOGLE_MAPS_API_KEY the component is a
 * plain text input (current behaviour) — the server still geocodes the typed
 * address on intake.
 */
import { useEffect, useRef, useState } from 'react';
import {
  APIProvider,
  Map,
  AdvancedMarker,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
// Reserved demo map id — renders AdvancedMarkers without cloud map styling.
const MAP_ID = 'DEMO_MAP_ID';
const DEFAULT_CENTER = { lat: 42.7339, lng: 25.4858 }; // Bulgaria centroid

export interface AddressValue {
  address: string;
  lat: number | null;
  lng: number | null;
}

interface Props {
  value: string;
  onChange: (v: AddressValue) => void;
  placeholder?: string;
}

export function AddressAutocomplete({ value, onChange, placeholder }: Props) {
  if (!MAPS_KEY) {
    return (
      <input
        className="input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange({ address: e.target.value, lat: null, lng: null })}
      />
    );
  }
  return (
    <APIProvider apiKey={MAPS_KEY} language="bg" region="BG">
      <AutocompleteInner value={value} onChange={onChange} placeholder={placeholder} />
    </APIProvider>
  );
}

function AutocompleteInner({ value, onChange, placeholder }: Props) {
  const places = useMapsLibrary('places');
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);

  // Bind the classic Places Autocomplete widget to the input once the library loads.
  useEffect(() => {
    if (!places || !inputRef.current) return;
    const ac = new places.Autocomplete(inputRef.current, {
      fields: ['formatted_address', 'geometry'],
      componentRestrictions: { country: 'bg' },
    });
    const listener = ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      const loc = place.geometry?.location;
      const address = place.formatted_address ?? inputRef.current?.value ?? '';
      if (loc) {
        const p = { lat: loc.lat(), lng: loc.lng() };
        setPos(p);
        onChange({ address, lat: p.lat, lng: p.lng });
      } else {
        onChange({ address, lat: null, lng: null });
      }
    });
    return () => listener.remove();
    // onChange is stable enough for this binding; rebinding on it would drop the widget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places]);

  return (
    <>
      <input
        ref={inputRef}
        className="input"
        placeholder={placeholder}
        defaultValue={value}
        onChange={(e) =>
          onChange({ address: e.target.value, lat: pos?.lat ?? null, lng: pos?.lng ?? null })
        }
      />
      <div
        style={{
          height: 220,
          marginTop: 12,
          borderRadius: 12,
          overflow: 'hidden',
          border: '1px solid var(--line)',
        }}
      >
        <Map
          mapId={MAP_ID}
          defaultCenter={DEFAULT_CENTER}
          defaultZoom={7}
          gestureHandling="greedy"
          disableDefaultUI={false}
          style={{ width: '100%', height: '100%' }}
        >
          <PanTo pos={pos} />
          {pos && (
            <AdvancedMarker
              position={pos}
              draggable
              onDragEnd={(e) => {
                const lat = e.latLng?.lat();
                const lng = e.latLng?.lng();
                if (lat != null && lng != null) {
                  setPos({ lat, lng });
                  onChange({ address: inputRef.current?.value ?? value, lat, lng });
                }
              }}
            />
          )}
        </Map>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        {pos
          ? 'Премести точката, ако адресът не е точен.'
          : 'Започни да пишеш адреса и избери от списъка, за да поставим точка на картата.'}
      </p>
    </>
  );
}

/** Pans/zooms the map to a position when it changes (keeps the map uncontrolled). */
function PanTo({ pos }: { pos: { lat: number; lng: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (map && pos) {
      map.panTo(pos);
      map.setZoom(15);
    }
  }, [map, pos]);
  return null;
}
