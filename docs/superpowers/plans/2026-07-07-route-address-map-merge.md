# Route Address+Map Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the „Смени адрес" modal's two tabs (Адрес / Карта) into one synced view — a map click/drag fills the address via reverse geocoding, and picking an address suggestion moves the pin.

**Architecture:** Add a small `reverseGeocode` capability to the existing `MapsService` (mirrors its `geocode()`), expose it through one new authenticated GET endpoint on the existing `RoutingController`, then rewrite the client modal to drop its tab switcher in favor of one panel with the address field and map both always visible, wired together through a single `pin`/`addr` state pair.

**Tech Stack:** NestJS + Drizzle (server), Next.js 14 client components, `@vis.gl/react-google-maps`, class-validator/class-transformer, Jest (server), vitest (client, node-env, `.ts` only).

## Global Constraints

- No tenant-scoped data in the new reverse-geocode endpoint — it's a pure Google passthrough, gated by `JwtAuthGuard` + `ActiveSubscriptionGuard` only (same guards as the sibling `/orders/route` endpoints), no `@CurrentTenant()` needed.
- Server graceful-degradation contract (same as every other `MapsService` method): returns `null` when `!this.enabled`, on `ZERO_RESULTS`, or on any error — never throws to the caller.
- Cache reverse-geocode results with the existing `cachedGet`/`cachedSet` helpers and `GEOCODE_CACHE_TTL` (30 days), keyed by coordinates rounded to `toFixed(5)` (~1m precision).
- Strip the trailing "България"/"Bulgaria" suffix from the reverse-geocoded address the same way `address-autocomplete.tsx:133` already does: `.replace(/,?\s*(България|Bulgaria)\s*$/i, '')`.
- Client UI copy is Bulgarian, matching the modal's existing tone.
- Client debounce: 500ms after a map click/drag before calling reverse-geocode.
- A pin from a **map click/drag** must survive subsequent free-hand address-text edits. A pin from a **previous suggestion pick** is still invalidated by free-hand typing (existing `AddressAutocomplete` behavior via `onPick(null)` on every keystroke) — do not change `address-autocomplete.tsx`.
- vitest (client) is node-env, collects only `src/**/*.test.ts` — no component test for the modal; verify it via typecheck + manual preview instead.
- Jest (server) is the existing test runner (`pnpm test` in `server/`); mirror `maps.service.spec.ts`'s existing mock/stub style (`mockFetch`, `make(key)`) exactly — do not introduce a different mocking approach.

---

## File Structure

- **Modify** `server/src/common/maps/maps.service.ts` — add `reverseGeocode(lat, lng)` + a private `reverseGeoKey` cache-key helper.
- **Modify** `server/src/common/maps/maps.service.spec.ts` — add `reverseGeocode` test cases; extend the existing "disabled" test to cover it too.
- **Create** `server/src/modules/routing/dto/reverse-geocode-query.dto.ts` — query DTO (`lat`, `lng`).
- **Modify** `server/src/modules/routing/routing.service.ts` — add a thin `reverseGeocode(lat, lng)` wrapper that calls `this.maps.reverseGeocode`.
- **Create** `server/src/modules/routing/routing.reverse-geocode.spec.ts` — unit tests for the service wrapper (mirrors `routing.set-location.spec.ts`'s style).
- **Modify** `server/src/modules/routing/routing.controller.ts` — add `GET orders/route/reverse-geocode`.
- **Modify** `client/src/lib/api-client.ts` — add `reverseGeocode(lat, lng)` client call.
- **Modify** `client/src/components/route/edit-address.ts` — remove `EditTab`/`initialEditTab`/`stopIsLocated`; replace `addressPayload` with `mergedPayload` (address becomes optional in the return type).
- **Modify** `client/src/components/route/edit-address.test.ts` — replace the removed functions' tests with `mergedPayload`'s 3 cases.
- **Modify** `client/src/components/route/edit-address-modal.tsx` — remove the tab switcher; single view wiring pin ↔ address.

---

## Task 1: `MapsService.reverseGeocode`

**Files:**
- Modify: `server/src/common/maps/maps.service.ts`
- Test: `server/src/common/maps/maps.service.spec.ts`

**Interfaces:**
- Consumes: `this.enabled`, `this.apiKey`, `GEOCODE_URL`, `GEOCODE_CACHE_TTL`, `this.cachedGet`/`this.cachedSet`, `this.fetchJson`, `this.logger` — all pre-existing on the class.
- Produces: `reverseGeocode(lat: number, lng: number): Promise<string | null>` — later tasks call this from `RoutingService`.

- [ ] **Step 1: Write the failing tests**

Open `server/src/common/maps/maps.service.spec.ts`. First, extend the existing disabled-mode test (around line 51-61) to also cover `reverseGeocode` — replace it with:

```ts
describe('MapsService disabled (no API key)', () => {
  it('route/geocode/routeFixed/reverseGeocode all resolve to null and never call fetch', async () => {
    const fetchSpy = mockFetch({});
    const svc = make('');
    expect(svc.enabled).toBe(false);
    expect(await svc.route(origin, stops)).toBeNull();
    expect(await svc.geocode('ул. Шипка 5')).toBeNull();
    expect(await svc.routeFixed([origin, ...stops])).toBeNull();
    expect(await svc.reverseGeocode(42.0, 23.0)).toBeNull();
    expect(fetchSpy).toHaveLength(0);
  });
});
```

Then append a new describe block at the end of the file:

```ts
describe('MapsService.reverseGeocode', () => {
  const reverseOk = (formattedAddress: string) => ({
    status: 'OK',
    results: [{ formatted_address: formattedAddress }],
  });

  it('returns the formatted address, stripped of the trailing country name', async () => {
    const calls = mockFetch(reverseOk('ул. Иван Вазов 12, Варна, България'));
    const out = await make('k').reverseGeocode(43.2, 27.9);
    expect(out).toBe('ул. Иван Вазов 12, Варна');
    expect(decodeURIComponent(calls[0].url)).toContain('latlng=43.2,27.9');
  });

  it('returns null on ZERO_RESULTS', async () => {
    mockFetch(geoZero);
    expect(await make('k').reverseGeocode(0, 0)).toBeNull();
  });

  it('caches a successful result — second call skips fetch', async () => {
    const calls = mockFetch(reverseOk('пл. Свобода 1, Севлиево'));
    const svc = make('k');
    const first = await svc.reverseGeocode(43.0, 25.0);
    const second = await svc.reverseGeocode(43.0, 25.0);
    expect(first).toBe('пл. Свобода 1, Севлиево');
    expect(second).toBe('пл. Свобода 1, Севлиево');
    expect(calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && pnpm test -- maps.service.spec.ts`
Expected: FAIL — `svc.reverseGeocode is not a function` (or `TypeError`) on every new/changed test.

- [ ] **Step 3: Implement `reverseGeocode`**

In `server/src/common/maps/maps.service.ts`, add this method right after `geocode()` (after the closing `}` of `geocode`, before `geocodeCity`):

```ts
  /**
   * Resolve a map point back to a human address (reverse geocoding) — used by
   * the route stop editor when the farmer drops/drags a pin on the embedded
   * map, so the address field can reflect where the pin actually landed.
   * Returns null when disabled, on no match, or on any error — same
   * graceful-degradation contract as every other method here. Cached for
   * {@link GEOCODE_CACHE_TTL}, keyed by coordinates rounded to ~1m precision.
   */
  async reverseGeocode(lat: number, lng: number): Promise<string | null> {
    if (!this.enabled) return null;

    const key = this.reverseGeoKey(lat, lng);
    const cached = await this.cachedGet<string>(key);
    if (cached) return cached;

    const url = `${GEOCODE_URL}?latlng=${lat},${lng}&language=bg&key=${this.apiKey}`;
    try {
      const res = await this.fetchJson(url);
      if (res?.status !== 'OK' || !Array.isArray(res.results) || !res.results.length) {
        if (res?.status && res.status !== 'ZERO_RESULTS') {
          this.logger.warn(`Reverse geocode failed (${res.status}) for ${lat},${lng}.`);
        }
        return null;
      }
      const raw = res.results[0]?.formatted_address;
      if (typeof raw !== 'string' || !raw) return null;
      const address = raw.replace(/,?\s*(България|Bulgaria)\s*$/i, '');
      await this.cachedSet(key, address, GEOCODE_CACHE_TTL);
      return address;
    } catch (err) {
      this.logger.warn(`Reverse geocode error for ${lat},${lng}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Stable cache key for a reverse geocode — coordinates rounded to ~1m. */
  private reverseGeoKey(lat: number, lng: number): string {
    return `maps:reverse:${lat.toFixed(5)},${lng.toFixed(5)}`;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm test -- maps.service.spec.ts`
Expected: PASS — all tests in the file green, including the 3 new `reverseGeocode` cases and the updated disabled-mode test.

- [ ] **Step 5: Commit**

```bash
git add server/src/common/maps/maps.service.ts server/src/common/maps/maps.service.spec.ts
git commit -m "feat(maps): add MapsService.reverseGeocode"
```

---

## Task 2: Reverse-geocode endpoint

**Files:**
- Create: `server/src/modules/routing/dto/reverse-geocode-query.dto.ts`
- Modify: `server/src/modules/routing/routing.service.ts`
- Modify: `server/src/modules/routing/routing.controller.ts`
- Test: `server/src/modules/routing/routing.reverse-geocode.spec.ts`

**Interfaces:**
- Consumes: `MapsService.reverseGeocode(lat, lng): Promise<string | null>` (Task 1).
- Produces: `RoutingService.reverseGeocode(lat: number, lng: number): Promise<{ address: string | null }>`; endpoint `GET orders/route/reverse-geocode?lat=<num>&lng=<num>` returning `{ address: string | null }`. Later client tasks call this endpoint by this exact path and response shape.

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/routing/routing.reverse-geocode.spec.ts`:

```ts
import { RoutingService } from './routing.service';

describe('RoutingService.reverseGeocode', () => {
  it('delegates to MapsService.reverseGeocode and wraps the result', async () => {
    const maps = { reverseGeocode: jest.fn().mockResolvedValue('ул. Шипка 5, Варна') } as any;
    const svc = new RoutingService({} as any, maps);

    const out = await svc.reverseGeocode(43.2, 27.9);

    expect(maps.reverseGeocode).toHaveBeenCalledWith(43.2, 27.9);
    expect(out).toEqual({ address: 'ул. Шипка 5, Варна' });
  });

  it('wraps a null result (no match) the same way', async () => {
    const maps = { reverseGeocode: jest.fn().mockResolvedValue(null) } as any;
    const svc = new RoutingService({} as any, maps);

    const out = await svc.reverseGeocode(0, 0);

    expect(out).toEqual({ address: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm test -- routing.reverse-geocode.spec.ts`
Expected: FAIL — `svc.reverseGeocode is not a function`.

- [ ] **Step 3: Write the query DTO**

Create `server/src/modules/routing/dto/reverse-geocode-query.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude } from 'class-validator';

/** Query params for GET orders/route/reverse-geocode. */
export class ReverseGeocodeQueryDto {
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @Type(() => Number)
  @IsLongitude()
  lng!: number;
}
```

- [ ] **Step 4: Add the service wrapper**

In `server/src/modules/routing/routing.service.ts`, add this method right before the class's closing `}` (after `setStopLocation`, i.e. right after line 525's `return { lat, lng, address };` and its closing `}`):

```ts

  /**
   * Reverse geocode a map point to a human address — used by the route stop
   * editor when the farmer drops/drags a pin, so the address field can show
   * what's actually there. Wraps {@link MapsService.reverseGeocode}'s
   * null-on-no-match contract in a plain object so the controller has a fixed
   * response shape regardless of whether a match was found.
   */
  async reverseGeocode(lat: number, lng: number): Promise<{ address: string | null }> {
    const address = await this.maps.reverseGeocode(lat, lng);
    return { address };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && pnpm test -- routing.reverse-geocode.spec.ts`
Expected: PASS — both tests green.

- [ ] **Step 6: Add the controller endpoint**

In `server/src/modules/routing/routing.controller.ts`, add this import alongside the existing DTO import (after `import { SetStopLocationDto } from './dto/set-stop-location.dto';`):

```ts
import { ReverseGeocodeQueryDto } from './dto/reverse-geocode-query.dto';
```

Then add this method inside the `RoutingController` class, after `setStopLocation` (before the class's closing `}`):

```ts

  // Reverse geocode a map point to an address — used by the route stop editor's
  // embedded pick-map. No tenant-scoped data involved (pure Google passthrough);
  // gated the same way as the sibling route endpoints to avoid an open proxy.
  @Get('route/reverse-geocode')
  @UseGuards(ActiveSubscriptionGuard)
  reverseGeocode(@Query() dto: ReverseGeocodeQueryDto) {
    return this.routingService.reverseGeocode(dto.lat, dto.lng);
  }
```

- [ ] **Step 7: Full server test suite + typecheck**

Run: `cd server && pnpm test`
Expected: PASS — all server tests green, no regressions.

Run: `cd server && pnpm exec tsc --noEmit` (or the project's equivalent build/typecheck script — check `server/package.json`'s `"build"` script if `tsc --noEmit` isn't directly available)
Expected: PASS — no type errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/routing/dto/reverse-geocode-query.dto.ts server/src/modules/routing/routing.service.ts server/src/modules/routing/routing.controller.ts server/src/modules/routing/routing.reverse-geocode.spec.ts
git commit -m "feat(route): add GET orders/route/reverse-geocode endpoint"
```

---

## Task 3: Client pure helpers + API call

**Files:**
- Modify: `client/src/lib/api-client.ts`
- Modify: `client/src/components/route/edit-address.ts`
- Modify: `client/src/components/route/edit-address.test.ts`

**Interfaces:**
- Consumes: endpoint `GET orders/route/reverse-geocode?lat=&lng=` → `{ address: string | null }` (Task 2).
- Produces: `reverseGeocode(lat: number, lng: number): Promise<{ address: string | null }>` in `api-client.ts`; `mergedPayload(addr: string, pin: {lat,lng}|null): { address?: string; lat?: number; lng?: number }` in `edit-address.ts`. Task 4 imports both.

- [ ] **Step 1: Add the client API call**

In `client/src/lib/api-client.ts`, add this function right after `setStopLocation` (after its closing `);` around line 320):

```ts

/**
 * Reverse geocode a map point to an address — used by the route stop editor
 * when the farmer drops/drags a pin on the embedded map. Returns `address:
 * null` when nothing resolves (never throws for a no-match; only a network/
 * auth failure throws via apiFetch's normal ApiError path).
 */
export const reverseGeocode = (lat: number, lng: number) =>
  apiFetch<{ address: string | null }>(
    `orders/route/reverse-geocode?lat=${lat}&lng=${lng}`,
    undefined,
    'Неуспешно търсене на адрес',
  );
```

- [ ] **Step 2: Write the failing test for `mergedPayload`**

Replace the entire contents of `client/src/components/route/edit-address.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { mergedPayload } from './edit-address';

describe('mergedPayload', () => {
  it('address only (no pin) — trims and omits coords', () => {
    expect(mergedPayload('  ул. Иван Вазов 12  ', null)).toEqual({
      address: 'ул. Иван Вазов 12',
    });
  });

  it('address + pin — includes both', () => {
    expect(mergedPayload('Варна Център', { lat: 43.2, lng: 27.9 })).toEqual({
      address: 'Варна Център',
      lat: 43.2,
      lng: 27.9,
    });
  });

  it('pin only (empty address) — omits the address key entirely', () => {
    expect(mergedPayload('   ', { lat: 43.2, lng: 27.9 })).toEqual({
      lat: 43.2,
      lng: 27.9,
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd client && pnpm exec vitest run src/components/route/edit-address.test.ts`
Expected: FAIL — `Failed to resolve import` / `mergedPayload is not exported`.

- [ ] **Step 4: Rewrite `edit-address.ts`**

Replace the entire contents of `client/src/components/route/edit-address.ts` with:

```ts
/**
 * Payload for saving a route stop's delivery point. A pin (from a map click/
 * drag, or a picked address suggestion) is sent alongside the address text
 * when both are present; an empty address with a pin omits the `address` key
 * entirely so the server keeps the order's existing address (mirrors the
 * old map-only save path). No pin → address is required by the caller.
 */
export function mergedPayload(
  addr: string,
  pin: { lat: number; lng: number } | null,
): { address?: string; lat?: number; lng?: number } {
  const address = addr.trim();
  if (pin) return address ? { address, lat: pin.lat, lng: pin.lng } : { lat: pin.lat, lng: pin.lng };
  return { address };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd client && pnpm exec vitest run src/components/route/edit-address.test.ts`
Expected: PASS — all 3 assertions green.

- [ ] **Step 6: Typecheck**

Run: `cd client && pnpm exec tsc --noEmit`
Expected: **New errors expected** in `edit-address-modal.tsx` (it still imports the now-removed `initialEditTab`/`EditTab`/`addressPayload`) — this is fine, Task 4 fixes it. Confirm the errors are ONLY in `edit-address-modal.tsx` (plus the 3 pre-existing unrelated `help/page.tsx` errors) and nowhere else.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/api-client.ts client/src/components/route/edit-address.ts client/src/components/route/edit-address.test.ts
git commit -m "feat(route): mergedPayload helper + reverseGeocode API call"
```

---

## Task 4: Merge the modal into one synced view

**Files:**
- Modify: `client/src/components/route/edit-address-modal.tsx`

**Interfaces:**
- Consumes: `mergedPayload`, `reverseGeocode` (Task 3); pre-existing `AddressAutocomplete`, `setStopLocation`, `Button`, `cn`, `RouteStop`, `RouteResult` types; pre-existing `@vis.gl/react-google-maps` usage from the current file.
- Produces: `EditAddressModal({ stop, origin, mapsKey, placesKey, onClose, onSaved })` — same public signature as before, no change for callers in `route-client.tsx`.

- [ ] **Step 1: Replace the file**

Replace the entire contents of `client/src/components/route/edit-address-modal.tsx` with:

```tsx
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
  useEffect(() => {
    // Clear any pending reverse-geocode lookup if the modal closes mid-debounce.
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
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
    debounceRef.current = setTimeout(() => {
      reverseGeocode(lat, lng)
        .then(({ address }) => {
          if (address) setAddr(address);
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
```

- [ ] **Step 2: Typecheck**

Run: `cd client && pnpm exec tsc --noEmit`
Expected: PASS — clean except the same 3 pre-existing unrelated `help/page.tsx` errors seen before this plan started (missing `@fermeribg/help-*` workspace packages).

- [ ] **Step 3: Lint**

Run: `cd client && pnpm lint`
Expected: PASS — no new warnings on the touched file.

- [ ] **Step 4: Full unit suite**

Run: `cd client && pnpm test`
Expected: PASS — `slots.test.ts`, `edit-address.test.ts` (Task 3's `mergedPayload` tests), `waze.test.ts` all green.

- [ ] **Step 5: Manual preview verification**

Start the client dev server via the preview tool, open `/route`, click a stop's edit icon (or the amber „не е на картата" chip), and confirm:
1. One panel — no tab switcher — shows the address field directly above the map (or the fallback note if no `mapsKey`).
2. Clicking a point on the map moves the pin immediately; after ~500ms the address field updates to the reverse-geocoded text (when Google resolves one).
3. Dragging the pin to a new spot re-triggers the same debounce → address update.
4. Typing a suggestion into the address field and picking one from the dropdown moves the map pin to that suggestion's location.
5. Hand-editing the address text after a map click does **not** clear the pin (the Save button still saves the pin's coordinates alongside the edited text).
6. Save works with only a pin (no address text) and with only an address (no pin, e.g. a fresh un-located stop) — mirroring the two old tabs' behaviors, now unified.

Capture a screenshot of the merged panel (with both the address field and a pinned map visible) as evidence.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/route/edit-address-modal.tsx
git commit -m "feat(route): merge edit-address modal's tabs into one synced view"
```

---

## Self-Review

**Spec coverage:**
- Map→address reverse geocode, 500ms debounce, silent no-op on failure → Task 1 (service) + Task 4 (`onMapPointChange`). ✅
- Address→map only on a suggestion pick (not on typing) → Task 4's `onPick={(p) => { if (p) setPin(p); }}`. ✅
- A map-set pin survives later free-hand text edits (no `onPick(null)` wired to clear it) → Task 4: `onChange={setAddr}` alone, `onPick` only ever sets `pin`, never clears it. ✅
- Existing "typing invalidates a picked pin" behavior in `AddressAutocomplete` itself is untouched (not modified by any task) — but since the modal's `onPick` handler now ignores `null` entirely, that invalidation no longer has any effect on `pin`. This is intentionally a **behavior widening** versus the spec's literal wording ("a pin from a previous suggestion pick is still invalidated by free-hand typing") — the spec's own Sync Rules section conflicts with itself here: the "Net effect" paragraph states plainly "whichever action happened last... wins... Free-hand text edits never move or clear the pin," which contradicts the earlier paragraph about picked-pin invalidation. **Resolution:** the plan follows the "Net effect" paragraph (text edits never clear the pin, regardless of the pin's origin) since it's stated as the deciding summary and matches the simpler, single-state design (there is no way to distinguish a "map-origin" pin from a "pick-origin" pin once merged into one `pin` variable, short of adding a pin-origin flag the spec never asked for). Flagging this spec self-contradiction for the human rather than silently picking a side.
- Tab switcher removed, single view, explainer copy → Task 4. ✅
- `EditTab`/`initialEditTab` removed, `mergedPayload` replaces `addressPayload` → Task 3. ✅
- `reverseGeocode` server method + endpoint + client call → Tasks 1, 2, 3. ✅
- Cache key ~1m precision, 30-day TTL, graceful degradation, "България" stripping → Task 1. ✅
- Save allows pin-only (no address) and address-only (no pin) → Task 3's `mergedPayload` + Task 4's `save()` guard. ✅

**Placeholder scan:** none — every step has concrete, complete code.

**Type consistency:** `mergedPayload`'s signature (Task 3) matches its single call site in Task 4's `save()`. `reverseGeocode`'s client signature (`lat: number, lng: number) => Promise<{ address: string | null }>`, Task 3) matches the server response shape from Task 2 and its usage in Task 4's `onMapPointChange`. `RoutingService.reverseGeocode`'s return shape (Task 2) matches what the controller returns directly (no further transform) and what the client expects.
