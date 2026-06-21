'use client';

import { useEffect, useRef, useState } from 'react';

// Matches the TextField input styling.
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
  /** Precise coords on a pick, or null when the field is typed by hand (so the
   *  backend re-geocodes the final text instead of a stale pin). */
  onPick: (a: PickedAddress | null) => void;
  /** Places API (New) browser key — DELIBERATELY separate from the map's JS key,
   *  so the two can't leak each other. Used only for REST calls here (no Maps JS
   *  API load), which is what lets the two keys coexist on one page. */
  apiKey?: string;
}

interface Suggestion {
  placeId: string;
  text: string;
}

/** A short opaque session token groups the keystroke autocomplete calls + the
 *  final details call into ONE billable session (Google's recommendation). */
function newToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

/**
 * Address field with Google Places autocomplete via the **Places API (New) REST**
 * endpoint (places.googleapis.com), NOT the Maps JS SDK — so it runs on its own
 * key, fully isolated from the map's key. On pick it fetches the place's lat/lng
 * so the backend skips geocoding. Without a key it's a plain text field (backend
 * geocodes the typed address) — no regression.
 */
export function AddressAutocomplete({ label, placeholder, value, onChange, onPick, apiKey }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const tokenRef = useRef<string>('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close the dropdown on an outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  async function fetchSuggestions(input: string) {
    if (!apiKey || input.trim().length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    if (!tokenRef.current) tokenRef.current = newToken();
    try {
      const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
        body: JSON.stringify({
          input,
          includedRegionCodes: ['bg'],
          languageCode: 'bg',
          sessionToken: tokenRef.current,
        }),
      });
      if (!res.ok) {
        setSuggestions([]);
        setOpen(false);
        return;
      }
      const data = await res.json();
      const list: Suggestion[] = (data.suggestions ?? [])
        .map((s: any) => s.placePrediction)
        .filter(Boolean)
        .map((p: any) => ({ placeId: p.placeId as string, text: (p.text?.text as string) ?? '' }))
        .filter((s: Suggestion) => s.placeId && s.text);
      setSuggestions(list);
      setOpen(list.length > 0);
    } catch {
      // network / CORS / bad key → keep plain field, backend geocodes.
      setSuggestions([]);
      setOpen(false);
    }
  }

  function handleInput(v: string) {
    onChange(v);
    onPick(null); // typing invalidates any previous pin
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(v), 250);
  }

  async function choose(s: Suggestion) {
    onChange(s.text);
    setOpen(false);
    setSuggestions([]);
    if (!apiKey) {
      onPick(null);
      return;
    }
    try {
      const res = await fetch(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(s.placeId)}` +
          `?sessionToken=${encodeURIComponent(tokenRef.current)}`,
        { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'location,formattedAddress' } },
      );
      tokenRef.current = ''; // details call ends the billable session
      if (!res.ok) {
        onPick(null);
        return;
      }
      const data = await res.json();
      const loc = data.location;
      if (data.formattedAddress) {
        onChange(String(data.formattedAddress).replace(/,?\s*(България|Bulgaria)\s*$/i, ''));
      }
      onPick(loc ? { lat: loc.latitude, lng: loc.longitude } : null);
    } catch {
      onPick(null);
    }
  }

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-bold text-ff-ink-2">{label}</span>
      <div ref={wrapRef} className="relative">
        <input
          className={INPUT_CLS}
          placeholder={placeholder}
          value={value}
          autoComplete="off"
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
        />
        {open && suggestions.length > 0 && (
          <ul className="absolute z-[100] mt-1 max-h-64 w-full overflow-auto rounded-lg border border-ff-border bg-ff-surface py-1 shadow-ff-lg">
            {suggestions.map((s) => (
              <li key={s.placeId}>
                <button
                  type="button"
                  onClick={() => choose(s)}
                  className="block w-full px-3.5 py-2 text-left text-[14px] text-ff-ink hover:bg-ff-green-50"
                >
                  {s.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </label>
  );
}
