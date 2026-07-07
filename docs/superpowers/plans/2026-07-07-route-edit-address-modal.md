# Route stop „Смени адрес" modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One edit icon on every route stop opens a single modal that changes the delivery point two ways — type/search an address, or click a point on a small embedded map.

**Architecture:** New `EditAddressModal` (two tabs: Адрес via `AddressAutocomplete`, Карта via an embedded `@vis.gl/react-google-maps` map). Both tabs call the existing `setStopLocation` endpoint (no server change). Every stop row gets a `MapPinned` icon and the amber „не е на картата" chip becomes a button — both open the modal. The old inline `FixLocation` panel and the big-map placing flow are retired.

**Tech Stack:** Next 14 (App Router, client components), TypeScript, `@vis.gl/react-google-maps`, `lucide-react`, `sonner`, Tailwind (`ff-*` design tokens), pnpm workspace, vitest (node env).

## Global Constraints

- UI copy is **Bulgarian**. Match existing tone (short, plain, farmer-friendly).
- Use existing `ff-*` Tailwind tokens and the `Button` component; mirror `LocationRouteCard`'s modal chrome.
- **No server / DB / API change.** Reuse `setStopLocation(orderId, { address?, lat?, lng? })` from `@/lib/api-client`.
- vitest here is **node env, pure logic only**, and only collects `src/**/*.test.ts` (NOT `.tsx`). Component/JSX is verified by typecheck + preview, never a unit test.
- Package manager is **pnpm**. Client package name: `@fermeribg/web`. Run client commands from `client/`.
- All route stops are `deliveryType === 'address'`, so the server's non-address guard never fires from this UI.

---

## File Structure

- **Create** `client/src/components/route/edit-address.ts` — pure helpers (tab default + payload builder). Testable in node vitest.
- **Create** `client/src/components/route/edit-address.test.ts` — unit tests for the helpers.
- **Create** `client/src/components/route/edit-address-modal.tsx` — the modal (two tabs + embedded pick-map).
- **Modify** `client/src/components/route/stop-list.tsx` — add edit icon, make the amber chip a button, remove `FixLocation` + placing props.
- **Modify** `client/src/components/route/route-client.tsx` — `editStop` state, render modal, remove big-map placing plumbing, update help/guard copy.
- **Modify** `client/src/components/route/route-map.tsx` — drop `placing` / `onMapClick`.

---

## Task 1: Pure helpers + tests

**Files:**
- Create: `client/src/components/route/edit-address.ts`
- Test: `client/src/components/route/edit-address.test.ts`

**Interfaces:**
- Consumes: `RouteStop` from `@/lib/types`.
- Produces:
  - `type EditTab = 'address' | 'map'`
  - `stopIsLocated(s: Pick<RouteStop,'lat'|'lng'>): boolean`
  - `initialEditTab(s: Pick<RouteStop,'lat'|'lng'>): EditTab`
  - `addressPayload(addr: string, pin: {lat:number;lng:number} | null): { address: string; lat?: number; lng?: number }`

- [ ] **Step 1: Write the failing test**

Create `client/src/components/route/edit-address.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stopIsLocated, initialEditTab, addressPayload } from './edit-address';

describe('stopIsLocated', () => {
  it('true only when both coords present', () => {
    expect(stopIsLocated({ lat: 43.2, lng: 27.9 })).toBe(true);
    expect(stopIsLocated({ lat: 43.2, lng: null })).toBe(false);
    expect(stopIsLocated({ lat: null, lng: 27.9 })).toBe(false);
    expect(stopIsLocated({ lat: null, lng: null })).toBe(false);
  });
});

describe('initialEditTab', () => {
  it('map when the stop already has a pin', () => {
    expect(initialEditTab({ lat: 43.2, lng: 27.9 })).toBe('map');
  });
  it('address when the stop has no pin', () => {
    expect(initialEditTab({ lat: null, lng: null })).toBe('address');
  });
});

describe('addressPayload', () => {
  it('trims the address and omits coords when no pin', () => {
    expect(addressPayload('  ул. Иван Вазов 12  ', null)).toEqual({
      address: 'ул. Иван Вазов 12',
    });
  });
  it('includes exact coords when a suggestion was picked', () => {
    expect(addressPayload('Варна Център', { lat: 43.2, lng: 27.9 })).toEqual({
      address: 'Варна Център',
      lat: 43.2,
      lng: 27.9,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && pnpm exec vitest run src/components/route/edit-address.test.ts`
Expected: FAIL — `Failed to resolve import "./edit-address"` / functions not defined.

- [ ] **Step 3: Write the helpers**

Create `client/src/components/route/edit-address.ts`:

```ts
import type { RouteStop } from '@/lib/types';

/** Which method the modal opens on. */
export type EditTab = 'address' | 'map';

/** A stop is "on the map" only when it has BOTH coordinates. */
export const stopIsLocated = (s: Pick<RouteStop, 'lat' | 'lng'>): boolean =>
  s.lat != null && s.lng != null;

/**
 * Default tab: if the stop already has a pin you're nudging an existing point
 * (open the map); otherwise you first need to find the address (open Адрес).
 */
export const initialEditTab = (s: Pick<RouteStop, 'lat' | 'lng'>): EditTab =>
  stopIsLocated(s) ? 'map' : 'address';

/**
 * Payload for the address tab. Send the trimmed address; when a Places
 * suggestion was picked, include its exact coords so the backend skips
 * geocoding (mirrors LocationRouteCard's homePin behaviour).
 */
export function addressPayload(
  addr: string,
  pin: { lat: number; lng: number } | null,
): { address: string; lat?: number; lng?: number } {
  const address = addr.trim();
  return pin ? { address, lat: pin.lat, lng: pin.lng } : { address };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && pnpm exec vitest run src/components/route/edit-address.test.ts`
Expected: PASS — 3 files, all assertions green.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/route/edit-address.ts client/src/components/route/edit-address.test.ts
git commit -m "feat(route): pure helpers for the edit-address modal"
```

---

## Task 2: `EditAddressModal` component

**Files:**
- Create: `client/src/components/route/edit-address-modal.tsx`

**Interfaces:**
- Consumes: `initialEditTab`, `addressPayload`, `EditTab` (Task 1); `AddressAutocomplete` from `./address-autocomplete`; `setStopLocation` from `@/lib/api-client`; `Button` from `@/components/ui/button`; `RouteStop`, `RouteResult` from `@/lib/types`.
- Produces:
  - `EditAddressModal({ stop, origin, mapsKey, placesKey, onClose, onSaved })` where
    `stop: RouteStop`, `origin: RouteResult['origin']`, `mapsKey?: string`,
    `placesKey?: string`, `onClose: () => void`, `onSaved: () => void`.

- [ ] **Step 1: Write the component**

Create `client/src/components/route/edit-address-modal.tsx`:

```tsx
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
import type { RouteStop, RouteResult } from '@/lib/types';

// Reserved demo map id — renders AdvancedMarkers without cloud styling (same as route-map).
const MAP_ID = 'DEMO_MAP_ID';
const BG_CENTROID = { lat: 42.7339, lng: 25.4858 };

type Origin = RouteResult['origin'];
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
  const key = mapsKey ?? '';

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
      toast.error(e instanceof Error ? e.message : 'Адресът не е намерен');
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
                        <AdvancedMarker position={mapPin} title={stop.customer ?? 'Клиент'}>
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
```

- [ ] **Step 2: Typecheck the new component**

Run: `cd client && pnpm exec tsc --noEmit`
Expected: PASS — no errors. (The component is not imported anywhere yet; an exported-but-unused component is fine.)

- [ ] **Step 3: Commit**

```bash
git add client/src/components/route/edit-address-modal.tsx
git commit -m "feat(route): EditAddressModal — address + map-pick tabs"
```

---

## Task 3: Wire the modal in, retire the old flow

Interdependent edits (props flow across three files); do them together so the build stays green, verify by typecheck + build + preview, then commit once.

**Files:**
- Modify: `client/src/components/route/stop-list.tsx`
- Modify: `client/src/components/route/route-client.tsx`
- Modify: `client/src/components/route/route-map.tsx`

**Interfaces:**
- Consumes: `EditAddressModal` (Task 2).
- Produces: `StopList` gains `onEditAddress: (stop: RouteStop) => void`; loses `onFixed`, `placingId`, `onStartPlace`, `onCancelPlace`. `RouteMap` loses `placing`, `onMapClick`.

### 3a — `stop-list.tsx`

- [ ] **Step 1: Replace imports**

Replace the top import block (lines 1–19) with:

```tsx
'use client';

import { useState } from 'react';
import { AlertTriangle, Check, Copy, Mail, MapPin, MapPinned, Navigation, Phone } from 'lucide-react';
import { toast } from 'sonner';
import { cn, hhmm } from '@/lib/utils';
import type { RouteStop } from '@/lib/types';
```

- [ ] **Step 2: Replace the props interface**

Replace `interface StopListProps { … }` (lines 21–36) with:

```tsx
interface StopListProps {
  stops: RouteStop[];
  activeId: string | null;
  onPick: (id: string) => void;
  onOpenMaps: (stop: RouteStop) => void;
  onCall: (stop: RouteStop) => void;
  onEmail: (stop: RouteStop) => void;
  /** Open the „Смени адрес" modal for this stop. */
  onEditAddress: (stop: RouteStop) => void;
}
```

- [ ] **Step 3: Delete the `FixLocation` component**

Delete the entire `FixLocation` function (the block from its JSDoc `/**` above `function FixLocation({` through its closing `}` — lines 88–211). Keep `CopyLine` and `isLocated`.

- [ ] **Step 4: Update the `StopList` signature + body**

Replace the destructured params (lines 213–224) with:

```tsx
export function StopList({
  stops,
  activeId,
  onPick,
  onOpenMaps,
  onCall,
  onEmail,
  onEditAddress,
}: StopListProps) {
```

- [ ] **Step 5: Add the edit icon to the cluster**

In the icon cluster `<div className="flex shrink-0 gap-[7px]">`, add this button as the **first** child (immediately before the „Отвори в Google Maps" button):

```tsx
<button
  onClick={(e) => {
    e.stopPropagation();
    onEditAddress(s);
  }}
  title="Смени адрес"
  className="grid h-8 w-8 place-items-center rounded-[9px] bg-ff-green-100 text-ff-green-700 transition hover:brightness-95"
>
  <MapPinned size={16} />
</button>
```

- [ ] **Step 6: Make the amber chip a button**

Replace the `{!located && ( <span … не е на картата </span> )}` block (lines 318–325) with:

```tsx
{!located && (
  <button
    onClick={(e) => {
      e.stopPropagation();
      onEditAddress(s);
    }}
    title="Адресът не е намерен — натисни, за да поправиш"
    className="inline-flex items-center gap-1 rounded-md border border-ff-amber-soft bg-ff-amber-softer px-1.5 py-0.5 text-[11px] font-bold text-ff-amber-600 transition hover:brightness-95"
  >
    <AlertTriangle size={11} /> не е на картата — поправи
  </button>
)}
```

- [ ] **Step 7: Delete the inline fixer usage**

Delete the `{!located && ( <FixLocation … /> )}` block (lines 356–365).

### 3b — `route-map.tsx`

- [ ] **Step 8: Drop the placing props from the interface**

In `RouteMapProps` remove the `placing?` and `onMapClick?` members (lines 30–34, the two JSDoc'd props). Leave `apiKey?`.

- [ ] **Step 9: Drop them from the signature + defaults**

In the `RouteMap({ … })` destructure remove `placing = false,` and `onMapClick,` (lines 52–53).

- [ ] **Step 10: Remove the placing behaviour on `<Map>`**

Delete these two lines from the `<Map>` props (lines 88 + 89–93):

```tsx
draggableCursor={placing ? 'crosshair' : undefined}
onClick={(e) => {
  if (!placing || !onMapClick) return;
  const ll = e.detail.latLng;
  if (ll) onMapClick(ll.lat, ll.lng);
}}
```

### 3c — `route-client.tsx`

- [ ] **Step 11: Fix imports**

- Add `EditAddressModal`: after the `import { StopList } from './stop-list';` line add
  `import { EditAddressModal } from './edit-address-modal';`
- Change the api-client import (line 20) from
  `import { setStopLocation, updateOrderStatus } from '@/lib/api-client';` to
  `import { updateOrderStatus } from '@/lib/api-client';`

- [ ] **Step 12: Swap the placing state for editStop**

Replace the placing-state line (line 139) —
`const [placingId, setPlacingId] = useState<string | null>(null);` — with:

```tsx
// The stop whose address is being edited (drives the „Смени адрес" modal).
const [editStop, setEditStop] = useState<RouteStop | null>(null);
```

- [ ] **Step 13: Remove the placing handlers**

Delete the placing block (lines 266–278):

```tsx
// Manual-pin flow: the stop being placed + the map-click handler that saves it.
const placingStop = placingId ? (stops.find((s) => s.id === placingId) ?? null) : null;
const onPlaceOnMap = async (lat: number, lng: number) => {
  if (!placingId) return;
  try {
    await setStopLocation(placingId, { lat, lng });
    toast.success('Пинът е поставен на картата');
    setPlacingId(null);
    router.refresh();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Неуспешно записване');
  }
};
```

- [ ] **Step 14: Update the top guard-banner copy**

In the `unlocated.length > 0` banner, replace the sentence tail
`— показани са в списъка (с ⚠), но без пин. Провери адреса или се обади на клиента.`
with:
`— показани са в списъка, но без пин. Натисни иконата за адрес при спирката, за да ги поправиш.`

- [ ] **Step 15: Update the StopList usage**

Replace the `<StopList … />` element (lines 587–601) with:

```tsx
<StopList
  stops={stops}
  activeId={activeId}
  onPick={setActiveId}
  onOpenMaps={onOpenMaps}
  onCall={onCall}
  onEmail={onEmail}
  onEditAddress={setEditStop}
/>
```

- [ ] **Step 16: Remove the map placing banner + props**

Delete the `{placingStop && ( … )}` banner block (lines 606–616). Then in the `<RouteMap … />` element remove the two props `placing={placingId != null}` and `onMapClick={onPlaceOnMap}` (lines 624–625). The map keeps `stops`, `origin`, `end`, `polyline`, `activeId`, `onPick`, `apiKey`.

- [ ] **Step 17: Render the modal**

Immediately before the closing `</div>` that ends the component (right after the `{confirmFinish && ( … )}` block, before the final `);`), add:

```tsx
{editStop && (
  <EditAddressModal
    stop={editStop}
    origin={origin}
    mapsKey={mapsKey}
    placesKey={placesKey}
    onClose={() => setEditStop(null)}
    onSaved={() => {
      setEditStop(null);
      router.refresh();
    }}
  />
)}
```

- [ ] **Step 18: Update the help-modal bullet**

In the help modal, replace the `<b>⚠ не е на картата</b>` list item (lines 531–536) with:

```tsx
<li>
  <b>Смени адрес</b> (иконата с карфицата при всяка спирка, или жълтият етикет
  „не е на картата") — отваря прозорец с два начина да оправиш точката: въведи/потърси
  адрес, или цъкни точното място на малка карта. Запазва се и спирката влиза в маршрута.
</li>
```

- [ ] **Step 19: Typecheck**

Run: `cd client && pnpm exec tsc --noEmit`
Expected: PASS — no errors, no unused-symbol complaints (`setStopLocation`, `Crosshair`, `Search`, `FixLocation`, `placingId` all gone).

- [ ] **Step 20: Lint**

Run: `cd client && pnpm lint`
Expected: PASS (no new warnings for the touched files).

- [ ] **Step 21: Full unit suite**

Run: `cd client && pnpm test`
Expected: PASS — existing `waze`/`slots` tests + the new `edit-address` tests, all green.

- [ ] **Step 22: Preview drive (manual verification)**

Start the client via the preview tool (`next dev`, port 3000), open `/route`, and confirm:
  1. Every stop shows the carfitza (`MapPinned`) icon; clicking it opens the modal.
  2. A **located** stop opens on the **Карта** tab; an **un-located** stop opens on **Адрес**.
  3. Адрес tab: change the text / pick a suggestion → „Запази адреса" → toast, modal closes, the stop's pin moves and the list refreshes.
  4. Карта tab: click a point → the green pin moves there → „Запази точката" → toast, pin persists after refresh.
  5. The amber „не е на картата — поправи" chip opens the same modal.
  6. The old big-map „Кликни на картата…" banner no longer appears.

Capture a screenshot of the open modal (both tabs) as proof.

- [ ] **Step 23: Commit**

```bash
git add client/src/components/route/stop-list.tsx client/src/components/route/route-client.tsx client/src/components/route/route-map.tsx
git commit -m "feat(route): open Смени адрес modal from every stop; retire inline fixer"
```

---

## Self-Review

**Spec coverage:**
- Modal, two tabs (Адрес autocomplete + embedded pick-map) → Task 2. ✅
- Edit icon on every stop → Task 3 Step 5. ✅
- „не е на картата" chip opens the same modal → Task 3 Step 6. ✅
- „промени адреса" works through the modal (any stop, valid or not) → Task 3 Steps 5–6. ✅
- Retire inline flat-address `FixLocation` + big-map placing → Task 3 Steps 3, 7, 8–10, 12–13, 16. ✅
- No server change; reuse `setStopLocation` → Task 2 saves. ✅
- Help copy update → Task 3 Step 18; guard-banner copy → Step 14. ✅
- mapsKey-absent fallback on Карта tab → Task 2 (`key ? … : fallback note`). ✅
- Default tab = map when located else address → Task 1 `initialEditTab` + Task 2. ✅

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `EditTab`, `stopIsLocated`, `initialEditTab`, `addressPayload` (Task 1) are used verbatim in Task 2. `onEditAddress: (stop: RouteStop) => void` (Task 3 stop-list) matches `setEditStop` whose state is `RouteStop | null` (Task 3 route-client). `EditAddressModal` prop names match Task 2's signature. `setStopLocation` payloads (`{address, lat?, lng?}` and `{lat, lng}`) match `@/lib/api-client`.
```
