'use client';

import { useEffect, useRef } from 'react';
import { APIProvider, useMapsLibrary } from '@vis.gl/react-google-maps';

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

// Matches the TextField input styling so the field looks identical to the rest of
// the form (TextField can't be reused directly — Autocomplete needs the raw input
// ref, which TextField doesn't forward).
const INPUT_CLS =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3.5 py-3 text-[15px] text-ff-ink outline-none transition-colors placeholder:text-ff-muted-2 focus:border-ff-green-500';

export interface PickedAddress {
  lat: number;
  lng: number;
}

interface Props {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  /** Precise coords on a Places pick, or null when the field is hand-edited after
   *  a pick (so the backend re-geocodes the final text instead of a stale pin). */
  onPick: (a: PickedAddress | null) => void;
}

/** Inner field — must sit inside an APIProvider so useMapsLibrary works. */
function Field({ label, placeholder, value, onChange, onPick }: Props) {
  const places = useMapsLibrary('places');
  const ref = useRef<HTMLInputElement>(null);
  // Keep the latest callbacks in refs so the Autocomplete is wired exactly once
  // (re-creating it on every render would leak listeners + stack dropdowns).
  const onChangeRef = useRef(onChange);
  const onPickRef = useRef(onPick);
  onChangeRef.current = onChange;
  onPickRef.current = onPick;

  useEffect(() => {
    if (!places || !ref.current) return;
    const ac = new (places as any).Autocomplete(ref.current, {
      componentRestrictions: { country: 'bg' },
      fields: ['geometry', 'formatted_address'],
      // 'geocode' = streets / neighbourhoods / settlements (not only exact house
      // numbers), so a partial query suggests sooner. Geographic only, no POIs.
      types: ['geocode'],
    });
    const listener = ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      const loc = place?.geometry?.location;
      // Clean the chosen address (drop the ", България" tail). Programmatic value
      // writes by Google don't fire 'input', so this won't clear the pin.
      const formatted = (place?.formatted_address || ref.current?.value || '').replace(
        /,?\s*(България|Bulgaria)\s*$/i,
        '',
      );
      if (formatted) onChangeRef.current(formatted);
      onPickRef.current(loc ? { lat: loc.lat(), lng: loc.lng() } : null);
    });
    return () => listener.remove();
  }, [places]);

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-bold text-ff-ink-2">{label}</span>
      <input
        ref={ref}
        className={INPUT_CLS}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          onPick(null); // hand-edit invalidates any previous pick
        }}
      />
    </label>
  );
}

/**
 * Address input with Google Places autocomplete (BG), mirroring the chaika
 * storefront checkout: pick → precise lat/lng so the backend skips its own
 * geocode. Without a Maps key it degrades to a plain text field (backend
 * geocodes the typed address) — no regression.
 */
export function AddressAutocomplete(props: Props) {
  if (!MAPS_KEY) {
    return (
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-ff-ink-2">{props.label}</span>
        <input
          className={INPUT_CLS}
          placeholder={props.placeholder}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
      </label>
    );
  }
  return (
    <APIProvider apiKey={MAPS_KEY} language="bg" region="BG">
      <Field {...props} />
    </APIProvider>
  );
}
