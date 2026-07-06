# Route Finish-Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the redundant „Старт" turn-by-turn button from Маршрути and replace it with a „Завърших доставките ✓" button that bulk-marks the day's stops as delivered after an in-app confirmation.

**Architecture:** Single-file client change in `route-client.tsx`. „Старт" and its now-unreachable `navigate=true` code path are deleted. The new button opens the existing `ConfirmDialog` component, and on confirm runs `Promise.allSettled` over the existing `updateOrderStatus(id, 'delivered')` API call — one PATCH per stop, no new backend endpoint.

**Tech Stack:** Next.js 14 (App Router) client component, React 18, TypeScript, Tailwind (`ff-*` tokens), lucide-react icons, sonner toasts, existing `client/src/components/ui/confirm-dialog.tsx`.

## Global Constraints

- **Client-only.** No backend/API changes — reuses `updateOrderStatus(id, status)` from `client/src/lib/api-client.ts` (already `PATCH`es `orders/:id/status`). No DB migration, no new env vars.
- Does **not** touch payment/COD fields (`collected`, `codOutcome`) — only sets `status: 'delivered'`.
- No new empty-state screen — the existing `client/src/components/route/stop-list.tsx:225-232` „Няма спирки за този ден" state already covers "route is empty" once delivered stops drop out of the route response.
- Reuse the existing `ConfirmDialog` (`client/src/components/ui/confirm-dialog.tsx`) — do not build a new modal.
- `RouteStop.id` **is** the order id (confirmed in `server/src/modules/routing/routing.service.ts:216`, `id: orders.id`) — `updateOrderStatus(s.id, 'delivered')` targets the correct order directly.
- Use `Promise.allSettled` (not `Promise.all`) for the bulk update so one failing PATCH doesn't block the rest.
- Copy in Bulgarian, matching existing route-client tone.
- No unit-test harness covers `route-client.tsx` in this codebase (React-hooks component, no RTL/jsdom setup) — verification is `pnpm lint` + `pnpm build` + preview click-through, matching how the Waze feature's route-client wiring task was verified.

---

## Task 1: Remove „Старт", add „Завърших доставките"

**Files:**
- Modify: `client/src/components/route/route-client.tsx`

**Interfaces:**
- Consumes: `updateOrderStatus(id: string, status: string): Promise<Order>` from `@/lib/api-client` (existing, already used elsewhere in the codebase — e.g. `client/src/components/orders/orders-client.tsx`).
- Consumes: `ConfirmDialog` from `@/components/ui/confirm-dialog` — props `{ title: string; message: React.ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: 'primary' | 'danger'; busy?: boolean; onConfirm: () => void; onCancel: () => void }` (existing component, unchanged).
- Produces: no exports — internal UI change only.

- [ ] **Step 1: Read the current file to confirm anchor text**

Open `client/src/components/route/route-client.tsx` and locate these three regions (line numbers below are a guide — anchor on the shown text, since prior edits may have shifted lines slightly):

1. Imports (lines 1-26).
2. `legUrl`/`dirUrls`/`openRoute` (lines ~71-97, ~199-215).
3. The button group in the stops-list header (lines ~528-561).

- [ ] **Step 2: Simplify `legUrl`/`dirUrls` — drop the now-single-purpose `navigate` param**

Current code (`route-client.tsx:70-97`):
```ts
/** Build one Google Maps directions URL for a sequence of nodes (origin → … → destination). */
function legUrl(nodes: Point[], navigate: boolean): string {
  const params = new URLSearchParams({ api: '1', travelmode: 'driving' });
  const o = pt(nodes[0]);
  if (o) params.set('origin', o);
  params.set('destination', pt(nodes[nodes.length - 1]));
  if (navigate) params.set('dir_action', 'navigate');
  let url = `https://www.google.com/maps/dir/?${params.toString()}`;
  const mids = nodes.slice(1, -1).map(pt).filter(Boolean);
  if (mids.length) url += `&waypoints=${mids.map(encodeURIComponent).join('|')}`;
  return url;
}

/** Farm → stops as one or more chained Google Maps legs (≤9 waypoints each). */
function dirUrls(origin: Point, stops: RouteStop[], end: Point | null, navigate = false): string[] {
  if (!stops.length) return [];
  const perLeg = nodesPerLeg(); // 11 on desktop, 5 on mobile
  const points: Point[] = [origin, ...stops];
  if (end && (end.lat != null || end.address)) points.push(end);
  const urls: string[] = [];
  let i = 0;
  while (i < points.length - 1) {
    const seg = points.slice(i, i + perLeg);
    urls.push(legUrl(seg, navigate));
    i += seg.length - 1; // each leg's destination is the next leg's origin
  }
  return urls;
}
```

„Старт" (the only caller that ever passed `navigate = true`) is being removed in this task, so the parameter is now always `false` at every call site. Replace both functions with the param removed:

```ts
/** Build one Google Maps directions URL for a sequence of nodes (origin → … → destination). */
function legUrl(nodes: Point[]): string {
  const params = new URLSearchParams({ api: '1', travelmode: 'driving' });
  const o = pt(nodes[0]);
  if (o) params.set('origin', o);
  params.set('destination', pt(nodes[nodes.length - 1]));
  let url = `https://www.google.com/maps/dir/?${params.toString()}`;
  const mids = nodes.slice(1, -1).map(pt).filter(Boolean);
  if (mids.length) url += `&waypoints=${mids.map(encodeURIComponent).join('|')}`;
  return url;
}

/** Farm → stops as one or more chained Google Maps legs (≤9 waypoints each). */
function dirUrls(origin: Point, stops: RouteStop[], end: Point | null): string[] {
  if (!stops.length) return [];
  const perLeg = nodesPerLeg(); // 11 on desktop, 5 on mobile
  const points: Point[] = [origin, ...stops];
  if (end && (end.lat != null || end.address)) points.push(end);
  const urls: string[] = [];
  let i = 0;
  while (i < points.length - 1) {
    const seg = points.slice(i, i + perLeg);
    urls.push(legUrl(seg));
    i += seg.length - 1; // each leg's destination is the next leg's origin
  }
  return urls;
}
```

- [ ] **Step 3: Simplify `openRoute` — drop the `navigate` param and its ternary**

Current code (`route-client.tsx:199-215`):
```ts
  const openRoute = (navigate: boolean) => {
    const urls = dirUrls(origin, stops, endPoint, navigate);
    if (!urls.length) {
      toast.error('Няма спирки за маршрут');
      return;
    }
    // Open the first leg now (this click is the user gesture); queue the rest as
    // buttons so the browser doesn't block a burst of pop-ups.
    window.open(urls[0], '_blank', 'noopener');
    if (urls.length > 1) {
      setExtraLegs(urls.slice(1));
      toast.info(`Дълъг маршрут — ${urls.length} отсечки. Отвори всяка с бутоните долу.`);
    } else {
      setExtraLegs([]);
      toast.success(navigate ? 'Навигацията се отваря в Google Maps' : 'Маршрутът се отваря в Google Maps');
    }
  };
```

Replace with:
```ts
  const openRoute = () => {
    const urls = dirUrls(origin, stops, endPoint);
    if (!urls.length) {
      toast.error('Няма спирки за маршрут');
      return;
    }
    // Open the first leg now (this click is the user gesture); queue the rest as
    // buttons so the browser doesn't block a burst of pop-ups.
    window.open(urls[0], '_blank', 'noopener');
    if (urls.length > 1) {
      setExtraLegs(urls.slice(1));
      toast.info(`Дълъг маршрут — ${urls.length} отсечки. Отвори всяка с бутоните долу.`);
    } else {
      setExtraLegs([]);
      toast.success('Маршрутът се отваря в Google Maps');
    }
  };
```

- [ ] **Step 4: Add finish-day state and the `finishDay` handler**

Immediately after the existing Waze handlers block (right after `const wazeReset = () => setWazeIdx(0);`, `route-client.tsx:229`), add:

```ts
  // Bulk "finish the day" action: marks every stop's order as delivered.
  // Does not touch payment/COD fields — those are a separate, existing flow.
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const finishDay = async () => {
    setFinishing(true);
    const results = await Promise.allSettled(
      stops.map((s) => updateOrderStatus(s.id, 'delivered')),
    );
    setFinishing(false);
    setConfirmFinish(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed === 0) {
      toast.success(`Всички ${stops.length} спирки маркирани като доставени`);
    } else {
      toast.error(`${stops.length - failed}/${stops.length} маркирани, ${failed} неуспешни — опитай пак`);
    }
    router.refresh();
  };
```

- [ ] **Step 5: Update imports**

Replace the icon import block (`route-client.tsx:5-18`):
```tsx
import {
  CalendarDays,
  ChevronDown,
  Navigation,
  Truck,
  Home,
  Flag,
  Clock,
  Route as RouteIcon,
  HelpCircle,
  Settings,
  Mail,
  AlertTriangle,
} from 'lucide-react';
```
with (drop `Truck`, add `CheckCircle2`):
```tsx
import {
  CalendarDays,
  ChevronDown,
  Navigation,
  CheckCircle2,
  Home,
  Flag,
  Clock,
  Route as RouteIcon,
  HelpCircle,
  Settings,
  Mail,
  AlertTriangle,
} from 'lucide-react';
```

Replace the `api-client` import (`route-client.tsx:20`):
```ts
import { setStopLocation } from '@/lib/api-client';
```
with:
```ts
import { setStopLocation, updateOrderStatus } from '@/lib/api-client';
```

Add a new import for `ConfirmDialog` right after the `waze`/`waze-stepper` imports (`route-client.tsx:25-26`):
```tsx
import { WazeStepper } from './waze-stepper';
import { buildWazeTargets, wazeUrl } from './waze';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
```

- [ ] **Step 6: Remove „Старт", add „Завърших доставките" in the button group**

Current code (`route-client.tsx:531-561`):
```tsx
            <div className="flex gap-2">
              <button
                onClick={() => openRoute(false)}
                disabled={!stops.length}
                title="Отваря целия маршрут в Google Maps за преглед"
                className="inline-flex items-center gap-1.5 rounded-[9px] border border-ff-border bg-ff-surface px-[11px] py-[7px] text-[13px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Navigation size={15} /> Google Maps
              </button>
              <button
                onClick={() => openRoute(true)}
                disabled={!stops.length}
                title="Пуска навигация „завой по завой“ в Google Maps"
                className="inline-flex items-center gap-1.5 rounded-[9px] bg-ff-green-100 px-[11px] py-[7px] text-[13px] font-bold text-ff-green-800 transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Truck size={15} /> Старт
              </button>
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
            </div>
```

Replace with (note `openRoute(false)` → `openRoute()`; „Старт" replaced by „Завърших доставките"):
```tsx
            <div className="flex gap-2">
              <button
                onClick={() => openRoute()}
                disabled={!stops.length}
                title="Отваря целия маршрут в Google Maps за преглед"
                className="inline-flex items-center gap-1.5 rounded-[9px] border border-ff-border bg-ff-surface px-[11px] py-[7px] text-[13px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Navigation size={15} /> Google Maps
              </button>
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
              <button
                onClick={() => setConfirmFinish(true)}
                disabled={!stops.length}
                title="Маркира всички спирки за днес като доставени"
                className="inline-flex items-center gap-1.5 rounded-[9px] bg-ff-green-100 px-[11px] py-[7px] text-[13px] font-bold text-ff-green-800 transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckCircle2 size={15} /> Завърших доставките
              </button>
            </div>
```

- [ ] **Step 7: Render the confirm dialog**

Find the closing `</div>` of the component's outermost `animate-ff-fade-up` wrapper (the very last `</div>` before the component's final `);`, right after the `grid h-[calc(100vh-...)]` stops-list/map grid `<div>` closes). Add the dialog render immediately before that final closing `</div>`:

```tsx
      {confirmFinish && (
        <ConfirmDialog
          title="Завърши доставките за днес?"
          message={`Всички ${stops.length} спирки ще бъдат маркирани като доставени.`}
          confirmLabel="Завърших"
          busy={finishing}
          onCancel={() => setConfirmFinish(false)}
          onConfirm={finishDay}
        />
      )}
```

(If the exact closing structure looks different from this description once you read the live file, place the dialog as a sibling at the end of the component's returned JSX tree — it's a fixed-position overlay (`inset-0`), so its exact position in the tree doesn't affect layout, only that it renders once, guarded by `confirmFinish`.)

- [ ] **Step 8: Update the „Помощ" explainer**

Find the „Старт" bullet in the help `<ul>` (`route-client.tsx`, currently reads):
```tsx
            <li>
              <b>Старт</b> — пуска навигация „завой по завой“ в Google Maps на телефона.
            </li>
```

Replace with:
```tsx
            <li>
              <b>Завърших доставките</b> — маркира всички спирки за деня като доставени
              (след потвърждение). Не пипа информацията дали парите са получени — това е
              отделно.
            </li>
```

- [ ] **Step 9: Run lint**

```bash
cd client && pnpm lint
```
Expected: `✔ No ESLint warnings or errors`. In particular, confirm no `no-unused-vars` on `Truck` (removed) or on the old `openRoute`/`dirUrls`/`legUrl` `navigate` params (removed).

- [ ] **Step 10: Run the production build**

```bash
cd client && pnpm build
```
Expected: build succeeds (type-check passes) — confirms `ConfirmDialog`'s prop types, `updateOrderStatus`'s signature, and the simplified `openRoute`/`dirUrls`/`legUrl` signatures all line up.

- [ ] **Step 11: Preview verification**

Start the client dev server and open Маршрути for a date with at least 2 confirmed delivery stops:
1. Confirm „Старт" is gone; only „Google Maps", „Waze", „Завърших доставките" remain in the header button group.
2. Click „Google Maps" — confirm it still opens the map preview link (unchanged behavior) and the success toast reads „Маршрутът се отваря в Google Maps".
3. Click „Waze" — confirm the stepper panel still opens and works (unchanged from the prior feature).
4. Click „Завърших доставките" — confirm the `ConfirmDialog` opens with title „Завърши доставките за днес?" and the correct stop count in the message.
5. Click „Отказ" — dialog closes, no network call, stops unchanged.
6. Click „Завърших доставките" again → „Завърших" — confirm the button shows „Момент…" briefly, then a success toast „Всички N спирки маркирани като доставени", the dialog closes, and (after the `router.refresh()`) the stops disappear from the list — the page falls back to the existing „Няма спирки за този ден" empty state.
7. Confirm via the Поръчки screen (or DB) that the affected orders now have `status: 'delivered'` and that `collected`/`codOutcome` were NOT changed by this action.

If a seeded farmer route with real delivery stops is not reachable in the preview environment, fall back to `pnpm build` (already run in Step 10) as the verification evidence, and note in the report that runtime click-through was not exercised live.

- [ ] **Step 12: Commit**

```bash
git add client/src/components/route/route-client.tsx
git commit -m "$(cat <<'EOF'
feat(route): replace Старт with bulk Завърших доставките action

Старт duplicated the Google Maps preview link with no real value —
farmers navigate with their own phone's app, not in-app turn-by-turn
state. Replaced it with a bulk "finish the day" action that marks every
stop delivered via the existing PATCH /orders/:id/status endpoint,
gated behind the existing ConfirmDialog component. Does not touch
payment/COD fields.
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Remove „Старт" button + dead `navigate=true` path → Step 2, 3, 6. ✅
- `Truck` import removed → Step 5. ✅
- New „Завърших доставките" button, disabled when `!stops.length` → Step 6. ✅
- `ConfirmDialog` reused (not a new modal), correct title/message/confirmLabel/tone/busy → Step 7. ✅
- Bulk action via `Promise.allSettled` + existing `updateOrderStatus` → Step 4. ✅
- Partial-failure toast + retry-by-refresh (no separate error UI) → Step 4. ✅
- No payment/COD fields touched → confirmed, `finishDay` only calls `updateOrderStatus(s.id, 'delivered')`, nothing else. ✅
- No new empty-state screen → confirmed, plan doesn't touch `stop-list.tsx`. ✅
- Help bullet updated → Step 8. ✅
- No backend/migration/env changes → confirmed, only `route-client.tsx` touched. ✅
- Testing = lint + build + preview click-through (no unit-test harness for this file) → Steps 9-11, matches spec's Testing section. ✅

**Placeholder scan:** No TBD/TODO; all code blocks are complete and copy-pasteable. ✅

**Type consistency:** `updateOrderStatus(id: string, status: string)` used identically to its real signature in `client/src/lib/api-client.ts:544-545`. `ConfirmDialog` props (`title`, `message`, `confirmLabel`, `busy`, `onCancel`, `onConfirm`) match the real component's signature in `client/src/components/ui/confirm-dialog.tsx:11-30` exactly (tone defaults to `'primary'`, so omitting it is correct — this is not a destructive action). `openRoute()`/`dirUrls(origin, stops, endPoint)`/`legUrl(nodes)` signatures are consistent across Steps 2, 3, and 6 (all drop `navigate`). `confirmFinish`/`finishing`/`finishDay` names are consistent between Step 4 (definition) and Steps 6-7 (usage). ✅
