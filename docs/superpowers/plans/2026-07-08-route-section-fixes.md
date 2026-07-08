# „Маршрути" section fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three operator-requested fixes to the admin „Маршрути" screen — flag stops on big boulevards for manual pin correction, make the courier count a single control, and let each courier independently choose return-home vs end-at-last-stop.

**Architecture:** Client = Next.js (admin panel), server = NestJS + Drizzle. The route screen fetches `GET /orders/route?date=&end=&couriers=` → `MultiRouteResult`. Fix 1 is client-only (a pure address heuristic + a badge). Fix 2 removes one persisted field + defaults the courier count to 1. Fix 3 threads a per-courier end-mode array from URL → controller → service → each courier's leg, and surfaces a per-courier toggle. The shipped sweep-split algorithm (`route-split.ts`) is untouched; the split still balances with a single default end.

**Tech Stack:** TypeScript. Server tests = jest (`cd server && pnpm test -- <file>`). Client tests = vitest (`cd client && pnpm exec vitest run <file>`).

## Global Constraints

- Deterministic throughout: no `Math.random`, no wall-clock reads. Ties/fallbacks resolve by index and by the default mode.
- Preserve public route-fetch back-compat: `?end=` (single) and `?couriers=` keep working exactly as before. The new `?ends=` (csv) is additive.
- Do NOT modify `server/src/modules/routing/route-split.ts` (the sweep-split algorithm) or any consolidation/econt-app files.
- Bulgarian for all user-facing copy; match the existing strings' tone.
- The split still balances with ONE default end (uniform assumption); per-courier ends only change each group's optimize target, measured totals, `endMode`, and display.
- Courier count clamps to `[1,10]`; end mode is one of `'home' | 'last' | 'custom'` (`'custom'` is legacy — no per-courier UI).

---

## File Structure

**Create:**
- `client/src/components/route/major-road.ts` — pure `isMajorRoadAddress`.
- `client/src/components/route/major-road.spec.ts` — vitest unit tests.

**Modify:**
- `server/src/modules/routing/routing.service.ts` — `effectiveCourierCount` + `resolveCourierModes` pure helpers; per-courier ends in `getRoute`/`optimizeGroup`; `CourierRoute.endMode`.
- `server/src/modules/routing/routing.helpers.spec.ts` — tests for the two new pure helpers.
- `server/src/modules/routing/routing.controller.ts` — parse `?ends=`.
- `client/src/lib/types.ts` — `CourierRoute.endMode`.
- `client/src/lib/api-client.ts` — `getRoute` accepts `ends?: string[]`.
- `client/src/app/(admin)/route/page.tsx` — parse `searchParams.ends`, forward `&ends=`.
- `client/src/components/route/route-client.tsx` — per-courier end toggle (acts on active courier), tab end icons, major-road header count, Waze per-active-courier end; drop `ends` on date/courier change.
- `client/src/components/route/route-map.tsx` — `RouteLine` uses each route's `endMode`.
- `client/src/components/route/stop-list.tsx` — major-road badge on located stops.
- `client/src/components/route/location-route-card.tsx` — remove the „Куриери по подразбиране" field.

---

## Task 1: Single courier control (Fix 2)

**Files:**
- Modify: `server/src/modules/routing/routing.service.ts` (add `effectiveCourierCount`; use it in `getRoute` at lines ~264-267)
- Modify: `server/src/modules/routing/routing.helpers.spec.ts`
- Modify: `client/src/components/route/location-route-card.tsx`

**Interfaces:**
- Produces: `effectiveCourierCount(couriers: number | undefined): number` — clamps to `[1,10]`, **defaults to 1** when `couriers` is undefined/non-finite. No more `settings.routing.courierCount` fallback.

- [ ] **Step 1: Write the failing test**

Append to `server/src/modules/routing/routing.helpers.spec.ts`:

```ts
import { effectiveCourierCount } from './routing.service';

describe('effectiveCourierCount', () => {
  it('defaults to 1 when omitted', () => {
    expect(effectiveCourierCount(undefined)).toBe(1);
  });
  it('passes through a valid count', () => {
    expect(effectiveCourierCount(3)).toBe(3);
  });
  it('clamps to [1,10] and floors', () => {
    expect(effectiveCourierCount(0)).toBe(1);
    expect(effectiveCourierCount(99)).toBe(10);
    expect(effectiveCourierCount(2.9)).toBe(2);
  });
  it('falls back to 1 for NaN', () => {
    expect(effectiveCourierCount(Number.NaN)).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && pnpm test -- routing.helpers.spec.ts`
Expected: FAIL — `effectiveCourierCount is not a function`.

- [ ] **Step 3: Add the helper and use it**

In `server/src/modules/routing/routing.service.ts`, add near the other pure helpers (after `greedyByDistance`, before `@Injectable()`):

```ts
/**
 * Effective courier count for a route request. The route-page „Куриери" dropdown
 * (?couriers=) is the ONLY control now — there is no saved default. Absent /
 * non-finite → 1; always clamped to [1,10] and floored.
 */
export function effectiveCourierCount(couriers: number | undefined): number {
  const n = Math.floor(couriers ?? 1);
  return Math.min(10, Math.max(1, Number.isFinite(n) ? n : 1));
}
```

Then in `getRoute`, replace the `cfgCount`/`n` block (currently around lines 264-267):

```ts
    // Effective courier count: explicit ?couriers= wins, else the tenant's
    // saved default (settings.routing.courierCount), else 1. Clamped to [1,10].
    const cfgCount = Number((routingCfg.courierCount as number | string | undefined) ?? 1);
    const n = Math.min(10, Math.max(1, Math.floor(couriers ?? (Number.isFinite(cfgCount) ? cfgCount : 1))));
```

with:

```ts
    // Effective courier count: the route-page dropdown (?couriers=) is the only
    // control; default 1 when omitted (no saved courier default any more).
    const n = effectiveCourierCount(couriers);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && pnpm test -- routing.helpers.spec.ts`
Expected: PASS.

- [ ] **Step 5: Remove the modal field**

In `client/src/components/route/location-route-card.tsx`:

- Delete the `courierCount` state line:
  ```ts
  // Default courier count for the /route page when ?couriers= is omitted.
  const [courierCount, setCourierCount] = useState(1);
  ```
- In the `getTenant().then(...)` effect, delete the two lines that read/clamp `r.courierCount`:
  ```ts
  const n = Number(r.courierCount ?? 1);
  setCourierCount(Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 1);
  ```
- In `save`, drop `courierCount` from the payload so it becomes:
  ```ts
      await updateTenant({
        farmAddress: home.trim(),
        ...(homePin ? { farmLat: homePin.lat, farmLng: homePin.lng } : {}),
        routing: { endMode, endAddress: '' },
      });
  ```
- Delete the entire „Куриери по подразбиране" `<label>…</label>` block (the number input and its helper `<span>` — the whole label element between the `AddressAutocomplete` and the submit `<Button>`).

- [ ] **Step 6: Typecheck the client**

Run: `cd client && pnpm exec tsc --noEmit`
Expected: PASS — no unused `courierCount`, no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/routing/routing.service.ts server/src/modules/routing/routing.helpers.spec.ts client/src/components/route/location-route-card.tsx
git commit -m "feat(route): single courier control — drop the saved courier default"
```

---

## Task 2: Major-road stop flag (Fix 1)

**Files:**
- Create: `client/src/components/route/major-road.ts`
- Create: `client/src/components/route/major-road.spec.ts`
- Modify: `client/src/components/route/stop-list.tsx`
- Modify: `client/src/components/route/route-client.tsx`

**Interfaces:**
- Produces: `isMajorRoadAddress(address: string | null): boolean`.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/route/major-road.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isMajorRoadAddress } from './major-road';

describe('isMajorRoadAddress', () => {
  it('flags a boulevard', () => {
    expect(isMajorRoadAddress('бул. Христо Ботев 104, Варна')).toBe(true);
    expect(isMajorRoadAddress('булевард Сливница 12')).toBe(true);
  });
  it('flags шосе / магистрала', () => {
    expect(isMajorRoadAddress('Аспарухово шосе 5')).toBe(true);
    expect(isMajorRoadAddress('Магистрала Тракия, изход 3')).toBe(true);
  });
  it('flags a European route token', () => {
    expect(isMajorRoadAddress('E87, до бензиностанцията')).toBe(true);
    expect(isMajorRoadAddress('Е-85 km 12')).toBe(true);
  });
  it('does not flag a normal street', () => {
    expect(isMajorRoadAddress('ул. Иван Вазов 12, Варна')).toBe(false);
    expect(isMajorRoadAddress('с. Звездица, общ. Варна')).toBe(false);
  });
  it('handles null / empty', () => {
    expect(isMajorRoadAddress(null)).toBe(false);
    expect(isMajorRoadAddress('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && pnpm exec vitest run src/components/route/major-road.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `client/src/components/route/major-road.ts`:

```ts
/**
 * Heuristic: does this delivery address sit on a MAJOR road (boulevard / trunk /
 * European route) where a courier can't reasonably stop? There is no Google API
 * for "road size", so we read the Bulgarian address string: `бул.`/`булевард`,
 * `шосе`, `магистрала`, or a European-route token (`E87`, `Е-85` — Latin or
 * Cyrillic „Е"). Flagged stops get a gentle „move the pin to a side street"
 * nudge; the operator confirms. Pure, deterministic, case-insensitive.
 */
export function isMajorRoadAddress(address: string | null): boolean {
  if (!address) return false;
  const s = address.toLowerCase();
  if (/\bбул\.?\b|булевард|шосе|магистрала/.test(s)) return true;
  // European route: E or Cyrillic Е, optional dash/space, 2-3 digits (E87, Е-85).
  if (/(^|[^a-zа-я0-9])[eе][-\s]?\d{2,3}\b/i.test(address)) return true;
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && pnpm exec vitest run src/components/route/major-road.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the badge in the stop list**

In `client/src/components/route/stop-list.tsx`:

- Add the import near the top:
  ```ts
  import { isMajorRoadAddress } from './major-road';
  ```
- In the address row (the `<div>` that holds the „не е на картата" button — around line 172-193), add a sibling badge shown for **located** stops on a major road. Immediately after the `{!located && (…)}` block, insert:
  ```tsx
                {located && isMajorRoadAddress(s.address) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditAddress(s);
                    }}
                    title="Голям път — премести пина на близка уличка за удобно спиране"
                    className="inline-flex items-center gap-1 rounded-md border border-ff-amber-soft bg-ff-amber-softer px-1.5 py-0.5 text-[11px] font-bold text-ff-amber-600 transition hover:brightness-95"
                  >
                    <AlertTriangle size={11} /> голям път — спри на близка уличка
                  </button>
                )}
  ```
  (`located` and `AlertTriangle` are already in scope in this file — `located` gates the existing badge and `AlertTriangle` is already imported.)

- [ ] **Step 6: Add the header count in route-client**

In `client/src/components/route/route-client.tsx`:

- Add the import:
  ```ts
  import { isMajorRoadAddress } from './major-road';
  ```
- After the `unlocated` computation (around line 296), add:
  ```ts
  // Located stops sitting on a major road (boulevard/trunk) — the farmer likely
  // wants to nudge the pin to a side street. Informational, across all couriers.
  const onMajorRoad = allStops.filter(
    (s) => s.lat != null && s.lng != null && isMajorRoadAddress(s.address),
  );
  ```
- Directly after the existing `{unlocated.length > 0 && (…)}` amber warning block (ends around line 341), add a sibling warning:
  ```tsx
      {onMajorRoad.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-2.5">
          <AlertTriangle size={16} className="shrink-0 text-ff-amber-600" />
          <span className="text-[12.5px] font-bold text-ff-amber-600">
            {onMajorRoad.length === 1
              ? '1 спирка е на голям път'
              : `${onMajorRoad.length} спирки са на голям път`}{' '}
            — при нужда премести пина на близка уличка (иконата за адрес при спирката).
          </span>
        </div>
      )}
  ```

- [ ] **Step 7: Typecheck + run the client test**

Run: `cd client && pnpm exec tsc --noEmit && pnpm exec vitest run src/components/route/major-road.spec.ts`
Expected: PASS both.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/route/major-road.ts client/src/components/route/major-road.spec.ts client/src/components/route/stop-list.tsx client/src/components/route/route-client.tsx
git commit -m "feat(route): flag stops on major roads with a nudge to move the pin"
```

---

## Task 3: Per-courier return-home — backend (Fix 3, server)

**Files:**
- Modify: `server/src/modules/routing/routing.service.ts` (type `CourierRoute.endMode`; `resolveCourierModes`; per-courier ends in `getRoute` + `optimizeGroup`)
- Modify: `server/src/modules/routing/routing.helpers.spec.ts` (test `resolveCourierModes`)
- Modify: `server/src/modules/routing/routing.controller.ts` (parse `?ends=`)

**Interfaces:**
- Produces:
  - `CourierRoute.endMode: RouteEndMode` — each leg's own end mode.
  - `resolveCourierModes(defaultMode: RouteEndMode, endModes: readonly (RouteEndMode | undefined)[] | undefined, n: number): RouteEndMode[]` — length `n`, `endModes[i] ?? defaultMode`.
  - `getRoute(tenantId, date?, endMode?, couriers?, endModes?)` — new optional 5th arg `endModes?: (RouteEndMode | undefined)[]`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/modules/routing/routing.helpers.spec.ts`:

```ts
import { resolveCourierModes } from './routing.service';

describe('resolveCourierModes', () => {
  it('fills all couriers with the default when no per-courier array', () => {
    expect(resolveCourierModes('home', undefined, 3)).toEqual(['home', 'home', 'home']);
  });
  it('applies per-courier overrides by index', () => {
    expect(resolveCourierModes('home', ['last', undefined, 'home'], 3)).toEqual(['last', 'home', 'home']);
  });
  it('falls back to the default for missing / undefined slots and truncates extras', () => {
    expect(resolveCourierModes('last', ['home'], 3)).toEqual(['home', 'last', 'last']);
    expect(resolveCourierModes('home', ['last', 'last', 'last', 'last'], 2)).toEqual(['last', 'last']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && pnpm test -- routing.helpers.spec.ts`
Expected: FAIL — `resolveCourierModes is not a function`.

- [ ] **Step 3: Add `endMode` to the type + the helper**

In `server/src/modules/routing/routing.service.ts`:

- Add `endMode` to the `CourierRoute` interface (after `polyline`):
  ```ts
  export interface CourierRoute {
    stops: RouteStop[];
    totalDistanceM: number | null;
    totalDurationS: number | null;
    optimized: boolean;
    polyline: string[] | null;
    /** This courier's own end mode: home = loop back to the depot, last =
     *  end at the last stop. Set per leg from the per-courier ends. */
    endMode: RouteEndMode;
  }
  ```
- Add the pure helper near `effectiveCourierCount`:
  ```ts
  /**
   * Per-courier end modes, length `n`. `endModes[i]` (from the ?ends= csv) wins;
   * a missing/undefined/invalid slot falls back to the single default mode.
   */
  export function resolveCourierModes(
    defaultMode: RouteEndMode,
    endModes: readonly (RouteEndMode | undefined)[] | undefined,
    n: number,
  ): RouteEndMode[] {
    return Array.from({ length: n }, (_, i) => endModes?.[i] ?? defaultMode);
  }
  ```

- [ ] **Step 4: Thread per-courier ends through `getRoute`**

In `getRoute`, change the signature to add the 5th param:

```ts
  async getRoute(
    tenantId: string,
    date?: string,
    endMode?: RouteEndMode,
    couriers?: number,
    endModes?: (RouteEndMode | undefined)[],
  ): Promise<MultiRouteResult> {
```

The existing code computes `mode` (the single default) and builds the shared `end`. Keep both. Keep the split call exactly as-is (it uses the default `mode`'s `splitEnd`). After `groups` is finalized (`if (!groups.length) groups = [[]];`), replace the `routes` computation:

```ts
    // Groups are independent (pure inputs, key-isolated MapsService cache writes),
    // so optimize them concurrently — each courier's Google Routes call(s) no longer
    // wait on the previous courier's. Serial cost was ~2 round-trips × courier count.
    const routes: CourierRoute[] = await Promise.all(
      groups.map((group) => this.optimizeGroup(originPt, group, mode, end)),
    );
```

with:

```ts
    // Per-courier end modes, indexed by resulting group. The split above balanced
    // with the single default `mode`; here each leg is optimized + measured with
    // ITS own end (home = return to base, last = end at last stop).
    const modes = resolveCourierModes(mode, endModes, groups.length);
    const routes: CourierRoute[] = await Promise.all(
      groups.map((group, i) =>
        this.optimizeGroup(originPt, group, modes[i], this.endForMode(modes[i], origin, end)),
      ),
    );
```

Add a small private helper on the service (place it right above `optimizeGroup`):

```ts
  /** The RouteEnd a single courier leg targets, from its own mode. `home` loops
   *  to the depot; `last` is one-way (null coords); `custom` reuses the shared
   *  saved end (legacy — no per-courier custom UI). */
  private endForMode(mode: RouteEndMode, origin: RouteOrigin, shared: RouteEnd): RouteEnd {
    if (mode === 'home') {
      return { mode: 'home', address: origin.address, lat: origin.lat, lng: origin.lng };
    }
    if (mode === 'last') {
      return { mode: 'last', address: null, lat: null, lng: null };
    }
    return shared; // custom
  }
```

- [ ] **Step 5: Set `endMode` on each leg in `optimizeGroup`**

`optimizeGroup(originPt, group, mode, end)` already receives `mode`. Add `endMode: mode` to **both** returned objects:

- The empty-group early return:
  ```ts
      return { stops: [], totalDistanceM: null, totalDurationS: null, optimized: false, polyline: null, endMode: mode };
  ```
- The final return:
  ```ts
      return {
        stops: orderedGroup,
        totalDistanceM,
        totalDurationS,
        optimized: orderedGroup.length > 0,
        polyline: routePolyline,
        endMode: mode,
      };
  ```

- [ ] **Step 6: Parse `?ends=` in the controller**

In `server/src/modules/routing/routing.controller.ts`, add the query and forward it:

```ts
  @Get('route')
  @UseGuards(ActiveSubscriptionGuard)
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'end', required: false, enum: ['home', 'last', 'custom'] })
  @ApiQuery({ name: 'ends', required: false, description: 'Per-courier end modes, csv e.g. home,last' })
  @ApiQuery({ name: 'couriers', required: false, description: '1–10; default 1' })
  getRoute(
    @CurrentTenant() tenantId: string,
    @Query('date') date?: string,
    @Query('end') end?: string,
    @Query('couriers') couriers?: string,
    @Query('ends') ends?: string,
  ) {
    const endMode: RouteEndMode | undefined =
      end === 'home' || end === 'last' || end === 'custom' ? end : undefined;
    const parsed = couriers ? parseInt(couriers, 10) : undefined;
    const endModes: (RouteEndMode | undefined)[] | undefined = ends
      ? ends
          .split(',')
          .map((e) => (e === 'home' || e === 'last' || e === 'custom' ? (e as RouteEndMode) : undefined))
      : undefined;
    return this.routingService.getRoute(
      tenantId,
      date,
      endMode,
      Number.isFinite(parsed) ? parsed : undefined,
      endModes,
    );
  }
```

- [ ] **Step 7: Run the helper tests + build the server**

Run: `cd server && pnpm test -- routing.helpers.spec.ts && pnpm run build`
Expected: PASS — helper tests green; server compiles (all `CourierRoute` constructions now include `endMode`).

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/routing/routing.service.ts server/src/modules/routing/routing.helpers.spec.ts server/src/modules/routing/routing.controller.ts
git commit -m "feat(route): per-courier end mode threaded through getRoute"
```

---

## Task 4: Per-courier return-home — frontend (Fix 3, client)

**Files:**
- Modify: `client/src/lib/types.ts` (`CourierRoute.endMode`)
- Modify: `client/src/lib/api-client.ts` (`getRoute` accepts `ends`)
- Modify: `client/src/app/(admin)/route/page.tsx` (parse + forward `ends`)
- Modify: `client/src/components/route/route-client.tsx` (per-courier toggle, tab end icons, Waze end, drop `ends` on date/courier change)
- Modify: `client/src/components/route/route-map.tsx` (`RouteLine` uses each route's `endMode`)

**Interfaces:**
- Consumes: `CourierRoute.endMode` from the server (Task 3); `resolveCourierModes` behavior (server pads/truncates, so the client may send a short/long csv safely).

- [ ] **Step 1: Add `endMode` to the client type**

In `client/src/lib/types.ts`, add to `CourierRoute` (after `polyline`):

```ts
export interface CourierRoute {
  stops: RouteStop[];
  totalDistanceM: number | null;
  totalDurationS: number | null;
  optimized: boolean;
  polyline: string[] | null;
  /** This courier's own end mode (home = back to base, last = end at last stop). */
  endMode: RouteEndMode;
}
```

- [ ] **Step 2: `getRoute` client accepts `ends`**

In `client/src/lib/api-client.ts`, extend `getRoute`:

```ts
export const getRoute = (opts?: { date?: string; end?: string; couriers?: number; ends?: string[] }) => {
  const p = new URLSearchParams();
  if (opts?.date) p.set('date', opts.date);
  if (opts?.end) p.set('end', opts.end);
  if (opts?.couriers) p.set('couriers', String(opts.couriers));
  if (opts?.ends && opts.ends.length) p.set('ends', opts.ends.join(','));
  const q = p.toString();
  return apiFetch<MultiRouteResult>(`orders/route${q ? `?${q}` : ''}`);
};
```

(Adapt to the exact existing body — the only additions are the `ends` param and its `p.set`. Keep the current construction style.)

- [ ] **Step 3: Forward `ends` from the route page**

In `client/src/app/(admin)/route/page.tsx`:

- Extend the local `getRoute` fetch to take + serialize `ends`:
  ```ts
  async function getRoute(
    date: string,
    end?: EndMode,
    couriers?: number,
    ends?: string,
  ): Promise<{ route: MultiRouteResult; failed: boolean }> {
    // …empty/token unchanged…
    const qs =
      `date=${date}` +
      (end ? `&end=${end}` : '') +
      (couriers ? `&couriers=${couriers}` : '') +
      (ends ? `&ends=${encodeURIComponent(ends)}` : '');
    // …fetch unchanged…
  }
  ```
- Add `ends` to `searchParams` and pass it through:
  ```ts
  export default async function RoutePage({
    searchParams,
  }: {
    searchParams: { date?: string; end?: string; couriers?: string; ends?: string };
  }) {
    const date = searchParams.date ?? bgToday();
    const end = /* unchanged */;
    const couriers = /* unchanged */;
    const ends =
      typeof searchParams.ends === 'string' && searchParams.ends.trim() ? searchParams.ends : undefined;
    const { route, failed } = await getRoute(date, end, couriers, ends);
    // …unchanged…
  }
  ```

- [ ] **Step 4: Per-courier toggle in route-client**

In `client/src/components/route/route-client.tsx`:

- Derive the active courier's mode and replace the global end navigation. The end toggle acts on the **active** courier tab. Replace the `go`/`setEnd`/`setCouriers`/`setDate` helpers block:

```ts
  // Per-courier end modes, in courier (tab) order.
  const modes = routes.map((r) => r.endMode);
  const activeEndMode: RouteEndMode = modes[activeCourierIdx] ?? end.mode;

  // Toggling an end applies to the ACTIVE courier only; the ends csv carries all.
  const setCourierEnd = (mode: RouteEndMode) => {
    const next = routes.map((r, i) => (i === activeCourierIdx ? mode : r.endMode));
    router.push(`/route?date=${route.date}&couriers=${route.couriers}&ends=${next.join(',')}`);
  };
  // Changing courier count or date re-splits everyone, so prior per-leg ends no
  // longer map to the same legs — drop ends and let all fall back to the default.
  const setCouriers = (n: number) => router.push(`/route?date=${route.date}&couriers=${n}`);
  const setDate = (date: string) => router.push(`/route?date=${date}&couriers=${route.couriers}`);
```

  (Remove the old `go`, `setEnd`, `setCouriers`, `setDate` definitions; the couriers dropdown `onChange` still calls `setCouriers`, the date input still calls `setDate`.)

- The end-mode toggle buttons (the `END_OPTIONS.map(...)` block) now drive `setCourierEnd` and reflect `activeEndMode`:
  ```tsx
            {END_OPTIONS.map(({ mode, label, Icon }) => (
              <button
                key={mode}
                onClick={() => setCourierEnd(mode)}
                title={label}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12.5px] font-bold transition',
                  activeEndMode === mode
                    ? 'bg-ff-green-100 text-ff-green-800'
                    : 'text-ff-ink-2 hover:bg-ff-surface-2',
                )}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
  ```

- When there are multiple couriers, label the toggle group with which courier it targets. Immediately before the end-toggle `<div>` add:
  ```tsx
          {multi && (
            <span className="text-[12px] font-bold text-ff-muted">
              Край за Маршрут {activeCourierIdx + 1}:
            </span>
          )}
  ```

- Update `endHint` to use the active courier's mode:
  ```ts
  const endHint = END_OPTIONS.find((o) => o.mode === activeEndMode)?.hint ?? '';
  ```

- Show each courier's end mode on its tab. In the `multi && (…)` courier-tabs block, append an icon after the distance/duration text inside each tab button:
  ```tsx
                {r.endMode === 'home' ? <Home size={12} /> : <Flag size={12} />}
  ```
  (`Home` and `Flag` are already imported at the top of the file.)

- Update the Waze targets to use the active courier's end. Replace the `wazeTargets` memo's `end` argument with a RouteEnd built from `activeEndMode`:
  ```ts
  const wazeTargets = useMemo(
    () =>
      buildWazeTargets(
        stops,
        activeEndMode === 'home'
          ? { mode: 'home', address: origin.address, lat: origin.lat, lng: origin.lng }
          : { mode: 'last', address: null, lat: null, lng: null },
        origin,
      ),
    [stops, origin, activeEndMode],
  );
  ```

- The `endPoint` const used by the Google-Maps deep link (`dirUrls`) should also follow the active courier. Replace:
  ```ts
  const endPoint: Point | null =
    end.mode !== 'last' && (end.lat != null || end.address)
      ? { address: end.address, lat: end.lat, lng: end.lng }
      : null;
  ```
  with:
  ```ts
  // Deep-link end for the ACTIVE courier: home → back to base, last → open route.
  const endPoint: Point | null =
    activeEndMode === 'home' && (origin.lat != null || origin.address)
      ? { address: origin.address, lat: origin.lat, lng: origin.lng }
      : null;
  ```

- [ ] **Step 5: Per-courier line in the map**

In `client/src/components/route/route-map.tsx`:

- Change each `RouteLine` to receive the route's own end mode instead of the shared `end`:
  ```tsx
        {routes.map((r, ri) => (
          <RouteLine
            key={ri}
            origin={origin}
            stops={r.stops.filter(isLocated)}
            endMode={r.endMode}
            polyline={r.polyline}
            color={routeColor(ri)}
            opacity={ri === activeRoute ? 0.9 : 0.45}
          />
        ))}
  ```
- Update `RouteLine`'s props + fallback branch:
  ```tsx
  function RouteLine({
    origin,
    stops,
    endMode,
    polyline,
    color,
    opacity,
  }: {
    origin: Origin;
    stops: RouteStop[];
    endMode: RouteEndMode;
    polyline?: string[] | null;
    color: string;
    opacity: number;
  }) {
  ```
  In the straight-segment fallback, replace the `end.mode` branch:
  ```tsx
      if (endMode === 'home' && start) {
        path.push(start);
      }
  ```
  (Drop the `custom` branch — per-courier is home/last; the real path for any mode already comes from the decoded `polyline` when present.)
  Update the effect dependency array: replace `end` with `endMode`.
- Add `RouteEndMode` to the type import from `@/lib/types` if not already imported (the file already imports `RouteEnd`; add `RouteEndMode`). The top-level `customEnd`/`EndPin`/`FitBounds` keep using the shared `end` prop unchanged.

- [ ] **Step 6: Typecheck the client + run the client route tests**

Run: `cd client && pnpm exec tsc --noEmit && pnpm exec vitest run src/components/route`
Expected: PASS — no type errors; `major-road.spec.ts` still green.

- [ ] **Step 7: Build the client (route page + components compile)**

Run: `cd client && pnpm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts "client/src/app/(admin)/route/page.tsx" client/src/components/route/route-client.tsx client/src/components/route/route-map.tsx
git commit -m "feat(route): per-courier return-home toggle in the route UI"
```

---

## Self-review notes

- **Spec coverage:** Fix 1 → Task 2; Fix 2 → Task 1; Fix 3 → Task 3 (backend) + Task 4 (frontend).
- **Back-compat:** `?end=` and `?couriers=` still parsed; `?ends=` is additive; `resolveCourierModes` tolerates short/long/invalid csv.
- **Determinism:** helpers are pure; fallbacks by index + default mode.
- **Types:** `CourierRoute.endMode` added on both server (Task 3) and client (Task 4); `endForMode`/`resolveCourierModes`/`effectiveCourierCount` names are used consistently across tasks.
- **Untouched:** `route-split.ts`, consolidation/econt-app, storefronts.
