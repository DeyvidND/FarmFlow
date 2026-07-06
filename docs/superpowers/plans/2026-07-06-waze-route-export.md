# Waze Route Export (Маршрути) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Waze step-by-step navigator to the Маршрути screen that walks the farmer through the day's ordered delivery stops one at a time, auto-advancing the default target after each export.

**Architecture:** Client-only. A pure helper (`waze.ts`) builds single-destination Waze deep links and the ordered target list from the existing `RouteResult`. A presentational panel (`waze-stepper.tsx`) shows the current target with navigate + prev/next controls. `route-client.tsx` owns the pointer state, persists it to `localStorage` per date, and toggles the panel from a new „Waze" button. No backend, no DB migration.

**Tech Stack:** Next.js 14 (App Router) client component, React 18, TypeScript, Tailwind (project `ff-*` tokens), lucide-react icons, sonner toasts, vitest (new, for the pure helper).

## Global Constraints

- **Client-only.** No backend, no DB migration, no new env vars. Copied verbatim from spec.
- **Waze URL form:** coords → `https://www.waze.com/ul?ll=<lat>%2C<lng>&navigate=yes`; address-only fallback → `https://www.waze.com/ul?q=<encoded>&navigate=yes`; neither → no link. Waze takes ONE destination and always starts from current GPS — no origin/waypoint params.
- **Open links** with `window.open(url, '_blank', 'noopener')` (matches existing Google Maps export). Exactly one URL per click — no popup-blocking / multi-leg handling.
- **Copy in Bulgarian**, matching the existing route-client tone.
- **localStorage key:** `ff:waze:<date>` (date = `route.date`, `YYYY-MM-DD`).
- **Follow existing patterns** in `client/src/components/route/*`: `ff-*` Tailwind tokens, lucide icons, `const cn = (...c) => c.filter(Boolean).join(' ')`.
- Package manager is **pnpm** (workspace). Client package name: `@fermeribg/web`.

## File Structure

- **Create** `client/src/components/route/waze.ts` — pure: `wazeUrl(point)` + `buildWazeTargets(stops, end, origin)` + `WazePoint`/`WazeTarget` types.
- **Create** `client/src/components/route/waze.test.ts` — vitest unit tests for the above.
- **Create** `client/src/components/route/waze-stepper.tsx` — presentational panel (props only, no data fetching).
- **Create** `client/vitest.config.ts` — minimal vitest config (node env, `@` alias).
- **Modify** `client/package.json` — add `vitest` devDep + `"test"` script.
- **Modify** `client/src/components/route/route-client.tsx` — Waze button, `showWaze`/`wazeIdx` state, localStorage sync, handlers, `<WazeStepper/>` render, Помощ bullet.

---

## Task 1: Pure Waze helper (`waze.ts`) + vitest

**Files:**
- Create: `client/vitest.config.ts`
- Create: `client/src/components/route/waze.ts`
- Test: `client/src/components/route/waze.test.ts`
- Modify: `client/package.json` (add devDep + script)

**Interfaces:**
- Consumes: `RouteStop`, `RouteEnd` from `client/src/lib/types.ts` (type-only import).
  - `RouteStop = { id: string; customer: string | null; phone; email; address: string | null; note; lat: number | null; lng: number | null; summary; slotFrom: string | null; slotTo: string | null }`
  - `RouteEnd = { mode: 'home' | 'last' | 'custom'; address: string | null; lat: number | null; lng: number | null }`
- Produces:
  - `interface WazePoint { lat: number | null; lng: number | null; address: string | null }`
  - `interface WazeTarget { key: string; label: string; customer: string | null; address: string | null; lat: number | null; lng: number | null; slotFrom: string | null; slotTo: string | null }`
  - `function wazeUrl(p: WazePoint): string | null`
  - `function buildWazeTargets(stops: RouteStop[], end: RouteEnd, origin: WazePoint): WazeTarget[]`

- [ ] **Step 1: Add vitest dev dependency**

Run (from the client package):
```bash
cd client && pnpm add -D vitest@^2
```
Expected: `vitest` appears under `devDependencies` in `client/package.json`.

- [ ] **Step 2: Add the test script**

In `client/package.json`, add to `"scripts"` (after `"e2e"`):
```json
    "e2e": "playwright test",
    "test": "vitest run"
```

- [ ] **Step 3: Create the vitest config**

Create `client/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Pure logic only — node env, no jsdom. `@` alias mirrors tsconfig so any
// runtime import of `@/...` resolves (type-only imports are erased by esbuild).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
```

- [ ] **Step 4: Write the failing tests**

Create `client/src/components/route/waze.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { wazeUrl, buildWazeTargets } from './waze';
import type { RouteStop, RouteEnd } from '@/lib/types';

const stop = (over: Partial<RouteStop>): RouteStop => ({
  id: 'x', customer: null, phone: null, email: null, address: null,
  note: null, lat: null, lng: null, summary: '', slotFrom: null, slotTo: null,
  ...over,
});

describe('wazeUrl', () => {
  it('uses ll for coords with the comma encoded', () => {
    expect(wazeUrl({ lat: 43.2, lng: 27.9, address: 'ignored' })).toBe(
      'https://www.waze.com/ul?ll=43.2%2C27.9&navigate=yes',
    );
  });
  it('falls back to q for address only', () => {
    expect(wazeUrl({ lat: null, lng: null, address: 'с. Звездица' })).toBe(
      `https://www.waze.com/ul?q=${encodeURIComponent('с. Звездица')}&navigate=yes`,
    );
  });
  it('returns null when there is neither coords nor a real address', () => {
    expect(wazeUrl({ lat: null, lng: null, address: '  ' })).toBeNull();
  });
});

describe('buildWazeTargets', () => {
  const origin = { lat: 43.0, lng: 27.0, address: 'база' };
  const end = (over: Partial<RouteEnd>): RouteEnd =>
    ({ mode: 'home', address: null, lat: null, lng: null, ...over });

  it('orders the stops and labels them „Спирка N"', () => {
    const t = buildWazeTargets(
      [stop({ id: 'a', lat: 1, lng: 1 }), stop({ id: 'b', lat: 2, lng: 2 })],
      end({ mode: 'last' }),
      origin,
    );
    expect(t.map((x) => x.key)).toEqual(['a', 'b']);
    expect(t[0].label).toBe('Спирка 1');
    expect(t[1].label).toBe('Спирка 2');
  });

  it('appends a base target when returning home, using origin for an empty end', () => {
    const t = buildWazeTargets([stop({ id: 'a', lat: 1, lng: 1 })], end({ mode: 'home', address: '' }), origin);
    const last = t[t.length - 1];
    expect(last.key).toBe('base');
    expect(last.lat).toBe(43.0);
    expect(last.label).toBe('Обратно към базата');
  });

  it('uses an explicit end point when the end has its own coords', () => {
    const t = buildWazeTargets(
      [stop({ id: 'a', lat: 1, lng: 1 })],
      end({ mode: 'custom', lat: 42.5, lng: 25.5, address: 'друг адрес' }),
      origin,
    );
    expect(t[t.length - 1].key).toBe('base');
    expect(t[t.length - 1].lat).toBe(42.5);
  });

  it('omits the base target when end.mode is "last"', () => {
    const t = buildWazeTargets([stop({ id: 'a', lat: 1, lng: 1 })], end({ mode: 'last' }), origin);
    expect(t.some((x) => x.key === 'base')).toBe(false);
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run:
```bash
cd client && pnpm test
```
Expected: FAIL — `wazeUrl`/`buildWazeTargets` are not exported (module `./waze` not found).

- [ ] **Step 6: Implement `waze.ts`**

Create `client/src/components/route/waze.ts`:
```ts
import type { RouteStop, RouteEnd } from '@/lib/types';

/** A place Waze can navigate to. Coordinates preferred; address is the fallback. */
export interface WazePoint {
  lat: number | null;
  lng: number | null;
  address: string | null;
}

/** One ordered destination in the Waze step-by-step navigator. */
export interface WazeTarget {
  /** Stable id — the stop id, or 'base' for the return-to-farm leg. */
  key: string;
  /** Human label: „Спирка 1" … or „Обратно към базата". */
  label: string;
  customer: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  slotFrom: string | null;
  slotTo: string | null;
}

/**
 * Waze universal deep link for a SINGLE destination. Opens the Waze app on
 * mobile (if installed), else Waze web. Waze always starts from the phone's
 * current GPS — there is no origin/waypoint parameter. Returns null when the
 * point has neither coordinates nor a usable address.
 */
export function wazeUrl(p: WazePoint): string | null {
  if (p.lat != null && p.lng != null) {
    const ll = encodeURIComponent(`${p.lat},${p.lng}`);
    return `https://www.waze.com/ul?ll=${ll}&navigate=yes`;
  }
  const q = p.address?.trim();
  if (q) return `https://www.waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
  return null;
}

/**
 * Ordered Waze targets for the day: every delivery stop in visit order, plus a
 * final „обратно към базата" leg when the route returns home (end.mode !==
 * 'last') and a base location is resolvable. For end.mode 'home' the saved end
 * address is empty, so the farm `origin` is used; an explicit end (e.g.
 * 'custom') is used as-is.
 */
export function buildWazeTargets(
  stops: RouteStop[],
  end: RouteEnd,
  origin: WazePoint,
): WazeTarget[] {
  const targets: WazeTarget[] = stops.map((s, i) => ({
    key: s.id,
    label: `Спирка ${i + 1}`,
    customer: s.customer,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    slotFrom: s.slotFrom,
    slotTo: s.slotTo,
  }));

  if (end.mode !== 'last') {
    const endResolvable = end.lat != null || !!end.address?.trim();
    const base: WazePoint = endResolvable
      ? { lat: end.lat, lng: end.lng, address: end.address }
      : origin;
    if (wazeUrl(base)) {
      targets.push({
        key: 'base',
        label: 'Обратно към базата',
        customer: null,
        address: base.address,
        lat: base.lat,
        lng: base.lng,
        slotFrom: null,
        slotTo: null,
      });
    }
  }

  return targets;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run:
```bash
cd client && pnpm test
```
Expected: PASS — all cases in both `describe` blocks green.

- [ ] **Step 8: Commit**

```bash
git add client/package.json client/pnpm-lock.yaml client/vitest.config.ts client/src/components/route/waze.ts client/src/components/route/waze.test.ts
git commit -m "feat(route): pure Waze deep-link + target builder with unit tests"
```
Note: `pnpm-lock.yaml` may live at the repo root — add whichever lockfile changed.

---

## Task 2: Waze stepper panel (`waze-stepper.tsx`)

**Files:**
- Create: `client/src/components/route/waze-stepper.tsx`

**Interfaces:**
- Consumes: `wazeUrl`, `WazeTarget` from `./waze` (Task 1).
- Produces: `WazeStepper` component with props
  `{ targets: WazeTarget[]; idx: number; onNavigate: (i: number) => void; onPrev: () => void; onNext: () => void; onReset: () => void; onClose: () => void }`.
  `idx` ranges `0..targets.length`; `idx >= targets.length` is the "all done" state.

- [ ] **Step 1: Implement the panel**

Create `client/src/components/route/waze-stepper.tsx`:
```tsx
'use client';

import {
  Navigation,
  X,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Clock,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react';
import { wazeUrl, type WazeTarget } from './waze';

const fmtSlot = (from: string | null, to: string | null) =>
  from && to ? `${from}–${to}` : (from ?? to ?? null);

export function WazeStepper({
  targets,
  idx,
  onNavigate,
  onPrev,
  onNext,
  onReset,
  onClose,
}: {
  targets: WazeTarget[];
  /** Current target index; `targets.length` = all stops done. */
  idx: number;
  onNavigate: (i: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const total = targets.length;
  const done = idx >= total;
  const cur = done ? null : targets[idx];
  const url = cur ? wazeUrl(cur) : null;
  const slot = cur ? fmtSlot(cur.slotFrom, cur.slotTo) : null;

  return (
    <div className="mb-3 rounded-xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-[14px] font-extrabold text-ff-ink">
          <Navigation size={16} className="text-ff-green-800" /> Навигация с Waze
        </h3>
        <button
          onClick={onClose}
          aria-label="Затвори"
          className="grid h-7 w-7 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2 hover:text-ff-ink"
        >
          <X size={16} />
        </button>
      </div>

      {done ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[13px] font-bold text-ff-green-800">Всички спирки минати ✓</p>
          <button
            onClick={onReset}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[13px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2"
          >
            <RotateCcw size={14} /> Започни отначало
          </button>
        </div>
      ) : (
        <>
          <p className="mb-1 text-[12.5px] font-bold text-ff-muted">
            {cur!.label} · {idx + 1} от {total}
          </p>
          <p className="text-[15px] font-extrabold text-ff-ink">{cur!.customer ?? 'Клиент'}</p>
          {cur!.address && (
            <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ff-ink-2">
              <MapPin size={13} className="shrink-0 text-ff-muted" /> {cur!.address}
            </p>
          )}
          {slot && (
            <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ff-ink-2">
              <Clock size={13} className="shrink-0 text-ff-muted" /> {slot}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {url ? (
              <button
                onClick={() => onNavigate(idx)}
                className="inline-flex items-center gap-1.5 rounded-[9px] bg-ff-green-100 px-4 py-2.5 text-[14px] font-extrabold text-ff-green-800 transition hover:brightness-95"
              >
                <Navigation size={15} /> Навигирай с Waze →
              </button>
            ) : (
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-ff-amber-soft bg-ff-amber-softer px-3 py-2 text-[12.5px] font-bold text-ff-amber-600">
                <AlertTriangle size={14} /> Тази спирка не е на картата
                <button onClick={onNext} className="ml-1 rounded-md bg-white/50 px-2 py-0.5 underline">
                  Пропусни
                </button>
              </div>
            )}
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={onPrev}
                disabled={idx === 0}
                aria-label="Предишна спирка"
                className="grid h-9 w-9 place-items-center rounded-lg border border-ff-border bg-ff-surface text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                onClick={onNext}
                aria-label="Следваща спирка"
                className="grid h-9 w-9 place-items-center rounded-lg border border-ff-border bg-ff-surface text-ff-ink-2 transition hover:bg-ff-surface-2"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>

          <p className="mt-2.5 text-[12px] text-ff-muted">
            Waze тръгва от текущото ти място до тази спирка. След доставка цъкни «Следваща» или бутона за навигация към следващата.
          </p>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck via lint**

Run:
```bash
cd client && pnpm lint
```
Expected: no errors for `waze-stepper.tsx` (unused-var / type errors would surface here).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/route/waze-stepper.tsx
git commit -m "feat(route): Waze stepper panel component"
```

---

## Task 3: Wire the stepper into `route-client.tsx`

**Files:**
- Modify: `client/src/components/route/route-client.tsx`

**Interfaces:**
- Consumes: `buildWazeTargets`, `wazeUrl` from `./waze` (Task 1); `WazeStepper` from `./waze-stepper` (Task 2).
- Produces: no exports — internal UI wiring.

- [ ] **Step 1: Add imports**

At the top of `client/src/components/route/route-client.tsx`, extend the React import and add the two new module imports.

Change line 3:
```tsx
import { useState } from 'react';
```
to:
```tsx
import { useEffect, useMemo, useState } from 'react';
```

After the existing `import { LocationRouteCard } from './location-route-card';` (line 24), add:
```tsx
import { WazeStepper } from './waze-stepper';
import { buildWazeTargets, wazeUrl } from './waze';
```

- [ ] **Step 2: Add Waze state, targets, and localStorage sync**

Inside `RouteClient`, right after the existing `const [extraLegs, setExtraLegs] = useState<string[]>([]);` (line 140), add:
```tsx
  // Waze step-by-step navigator: which target is next, and whether the panel is
  // open. `wazeIdx` reaches `wazeTargets.length` when every stop is done.
  const [showWaze, setShowWaze] = useState(false);
  const [wazeIdx, setWazeIdx] = useState(0);
  const wazeTargets = useMemo(
    () => buildWazeTargets(stops, end, origin),
    [stops, end, origin],
  );

  // Restore Waze progress for THIS date (survives reload / phone lock). Clamp to
  // the current target count. Keyed on the date only so re-ordering mid-run
  // doesn't reset the pointer.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`ff:waze:${route.date}`);
      const n = raw == null ? 0 : parseInt(raw, 10);
      setWazeIdx(Number.isFinite(n) ? Math.min(Math.max(n, 0), wazeTargets.length) : 0);
    } catch {
      setWazeIdx(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.date]);

  // Persist progress on every change.
  useEffect(() => {
    try {
      localStorage.setItem(`ff:waze:${route.date}`, String(wazeIdx));
    } catch {
      /* localStorage unavailable (private mode) — progress just won't persist */
    }
  }, [wazeIdx, route.date]);
```

- [ ] **Step 3: Add Waze handlers**

Right after the existing `openRoute` function (ends line 181), add:
```tsx
  // Open Waze for a single target and auto-advance the default to the next one.
  const wazeNavigate = (i: number) => {
    const url = wazeUrl(wazeTargets[i]);
    if (!url) {
      toast.error('Тази спирка не е на картата — провери адреса');
      return;
    }
    window.open(url, '_blank', 'noopener');
    setWazeIdx(Math.min(i + 1, wazeTargets.length));
  };
  const wazePrev = () => setWazeIdx((v) => Math.max(0, v - 1));
  const wazeNext = () => setWazeIdx((v) => Math.min(wazeTargets.length, v + 1));
  const wazeReset = () => setWazeIdx(0);
```

- [ ] **Step 4: Add the „Waze" toggle button**

In the stops-list header, the button group is `<div className="flex gap-2">` (line 466). After the „Старт" button's closing `</button>` (line 482), add:
```tsx
              <button
                onClick={() => setShowWaze((v) => !v)}
                disabled={!stops.length}
                title="Навигирай маршрута спирка по спирка с Waze"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[9px] border px-[11px] py-[7px] text-[13px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50',
                  showWaze
                    ? 'border-ff-green-500 bg-ff-green-100 text-ff-green-800'
                    : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
                )}
              >
                <Navigation size={15} /> Waze
              </button>
```

- [ ] **Step 5: Render the stepper panel**

The `extraLegs` block ends at line 402 (`)}` closing `{extraLegs.length > 0 && ( … )}`). Immediately after it, add:
```tsx
      {/* Waze step-by-step navigator — one stop at a time (Waze has no waypoints) */}
      {showWaze && wazeTargets.length > 0 && (
        <WazeStepper
          targets={wazeTargets}
          idx={wazeIdx}
          onNavigate={wazeNavigate}
          onPrev={wazePrev}
          onNext={wazeNext}
          onReset={wazeReset}
          onClose={() => setShowWaze(false)}
        />
      )}
```

- [ ] **Step 6: Add the Помощ bullet**

In the „Помощ" explainer `<ul>`, after the „Старт" bullet (`<b>Старт</b> — пуска навигация „завой по завой" в Google Maps на телефона.`, ends line 438), add a new `<li>`:
```tsx
            <li>
              <b>Waze</b> — навигация спирка по спирка. Waze води до една спирка наведнъж; цъкни
              „Навигирай", закарай, после мини на следващата. Помни докъде си стигнал за деня.
            </li>
```

- [ ] **Step 7: Lint**

Run:
```bash
cd client && pnpm lint
```
Expected: no new errors/warnings in `route-client.tsx` (watch for unused `useMemo`/`useEffect` or exhaustive-deps — the deps eslint-disable is intentional).

- [ ] **Step 8: Preview verification**

Start the client dev server and verify the flow on the Маршрути page for a farmer/date that has at least 2 geocoded delivery stops:
1. The „Waze" button appears next to „Google Maps"/„Старт" and is disabled when there are no stops.
2. Clicking it opens the stepper panel showing „Спирка 1" with the customer/address.
3. Clicking „Навигирай с Waze →" opens a `https://www.waze.com/ul?ll=…&navigate=yes` URL in a new tab AND the panel advances to „Спирка 2".
4. Reload the page — the panel (when reopened) resumes at „Спирка 2" (localStorage `ff:waze:<date>`).
5. „← Предишна" / „Следваща →" move the pointer; after the last target the panel shows „Всички спирки минати ✓" with „Започни отначало".

To intercept the opened URL without leaving the page, run in the preview console before clicking:
```js
window.open = (u) => { console.log('WAZE_OPEN', u); return null; };
```
Expected console line: `WAZE_OPEN https://www.waze.com/ul?ll=<lat>%2C<lng>&navigate=yes`.

If a seeded farmer route is not reachable in preview, fall back to `cd client && pnpm build` to confirm the production build/type-check passes, and note that runtime verification was build-only.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/route/route-client.tsx
git commit -m "feat(route): wire Waze stepper into Маршрути with per-date progress"
```

---

## Self-Review

**Spec coverage:**
- Third „Waze" button next to Google Maps/Старт → Task 3 Step 4. ✅
- Toggled stepper panel above the grid → Task 3 Step 5. ✅
- Current target (Спирка N, customer, address, slot) → Task 2. ✅
- Big „Навигирай с Waze" + prev/next + progress + hint + done state → Task 2. ✅
- Waze URL `ll` / `q` fallback / null → Task 1 (`wazeUrl`). ✅
- `window.open('_blank','noopener')`, one URL per click → Task 3 Step 3. ✅
- Targets = ordered stops + optional „обратно към базата" (origin for empty home end) → Task 1 (`buildWazeTargets`). ✅
- Auto-advance after navigate → Task 3 Step 3 (`setWazeIdx(i+1)`). ✅
- Persist per date in `localStorage` `ff:waze:<date>`, clamp on load → Task 3 Step 2. ✅
- Edge: 0 stops → button disabled (Task 3 Step 4); no-coords target → `q` fallback / disabled-with-Пропусни (Task 1 + Task 2); reorder shrink → clamp (Task 3 Step 2). ✅
- Help bullet → Task 3 Step 6. ✅
- Unit tests for `waze.ts` → Task 1 Steps 4–7. ✅
- No backend / migration → confirmed; only client files touched. ✅

**Placeholder scan:** No TBD/TODO/"add error handling"; all code blocks are complete. ✅

**Type consistency:** `WazePoint`/`WazeTarget`/`wazeUrl`/`buildWazeTargets` signatures identical across Task 1 (definition), Task 2 (`wazeUrl`, `WazeTarget` import), and Task 3 (`buildWazeTargets`, `wazeUrl` usage). `wazeIdx` range `0..targets.length` consistent between `WazeStepper` prop doc, the done-state check, and the clamp/handlers. ✅
