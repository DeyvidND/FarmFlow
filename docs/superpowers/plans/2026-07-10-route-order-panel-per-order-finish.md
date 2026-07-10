# Route card: order side-panel + per-order finish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two icon buttons to the „Маршрут за доставка" card — one opens the existing order side panel for the current stop, one marks the current stop delivered and advances to the next (one click, no dialog).

**Architecture:** Client-only. A tiny pure module holds the "which stop is next" pointer (unit-tested with vitest). `route-client.tsx` gains state + two handlers + two icon buttons and renders the existing `OrderPanel` unchanged. One new api-client helper (`getOrder`) hits the existing `GET /orders/:id`.

**Tech Stack:** Next.js (App Router) client component, TypeScript, lucide-react icons, sonner toasts, vitest.

## Global Constraints

- No backend, DB, or migration changes. `GET /orders/:id` already exists and returns the full `Order` (items + payment) via `serializeOrder(withItems)`.
- Two new buttons are **icon-only** (`title` + `aria-label`), placed in the route card header button row (`route-client.tsx` ~L729–772).
- "Current stop" = the existing `activeId` highlight; default first stop.
- Per-order finish is **one click, no confirm dialog**.
- Bulk „Завърших доставките" stays unchanged.
- All UI copy in Bulgarian, matching surrounding tone.
- Deviation from spec (intentional, for a lean change): finished stops are **not** greyed in the list (would require threading a prop through `StopList`). Progress is conveyed by the advancing highlight + a toast counter „остават N" + the single end-of-run `router.refresh()`.

---

### Task 1: Pure finish-pointer module (`route-finish.ts`)

**Files:**
- Create: `client/src/components/route/route-finish.ts`
- Test: `client/src/components/route/route-finish.test.ts`

**Interfaces:**
- Produces: `nextUnfinishedId(stops: { id: string }[], finished: ReadonlySet<string>): string | null` — the first stop id not in `finished`, or `null` when every stop is finished (or there are no stops).

- [ ] **Step 1: Write the failing test**

Create `client/src/components/route/route-finish.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextUnfinishedId } from './route-finish';

const stops = (...ids: string[]) => ids.map((id) => ({ id }));

describe('nextUnfinishedId', () => {
  it('returns the first stop when none are finished', () => {
    expect(nextUnfinishedId(stops('a', 'b', 'c'), new Set())).toBe('a');
  });

  it('skips finished stops and returns the next one', () => {
    expect(nextUnfinishedId(stops('a', 'b', 'c'), new Set(['a']))).toBe('b');
    expect(nextUnfinishedId(stops('a', 'b', 'c'), new Set(['a', 'b']))).toBe('c');
  });

  it('respects the given stop order, not the set order', () => {
    expect(nextUnfinishedId(stops('c', 'a', 'b'), new Set(['c']))).toBe('a');
  });

  it('returns null when every stop is finished', () => {
    expect(nextUnfinishedId(stops('a', 'b'), new Set(['a', 'b']))).toBeNull();
  });

  it('returns null when there are no stops', () => {
    expect(nextUnfinishedId([], new Set())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/components/route/route-finish.test.ts`
Expected: FAIL — `Failed to resolve import "./route-finish"` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `client/src/components/route/route-finish.ts`:

```ts
/**
 * Per-order "finish" pointer for the route card. Returns the first stop the
 * courier hasn't marked delivered yet (in the displayed stop order), or `null`
 * when every stop is done / the list is empty. Pure so it can be unit-tested
 * without the component.
 */
export function nextUnfinishedId(
  stops: { id: string }[],
  finished: ReadonlySet<string>,
): string | null {
  for (const s of stops) {
    if (!finished.has(s.id)) return s.id;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/components/route/route-finish.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/route/route-finish.ts client/src/components/route/route-finish.test.ts
git commit -m "feat(route): pure next-unfinished-stop pointer for per-order finish"
```

---

### Task 2: `getOrder` api-client helper

**Files:**
- Modify: `client/src/lib/api-client.ts` (after `updateOrder`, ~L572)

**Interfaces:**
- Consumes: existing `apiFetch<T>` and `Order` type (already imported — `updateOrderStatus` returns `apiFetch<Order>`).
- Produces: `getOrder(id: string): Promise<Order>` — the full single order (items + payment) that `OrderPanel` renders.

- [ ] **Step 1: Add the helper**

In `client/src/lib/api-client.ts`, immediately after the `updateOrder` export (the block ending at ~L572), insert:

```ts
/** Full single order (items + payment) — hydrates the order side panel. */
export const getOrder = (id: string) => apiFetch<Order>(`orders/${id}`);
```

- [ ] **Step 2: Typecheck / lint**

Run: `cd client && npx tsc --noEmit`
Expected: no new errors (the file already imports `Order` and `apiFetch`).

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/api-client.ts
git commit -m "feat(api-client): getOrder(id) — full order for the route panel"
```

---

### Task 3: Two icon buttons + order panel wiring in `route-client.tsx`

**Files:**
- Modify: `client/src/components/route/route-client.tsx`

**Interfaces:**
- Consumes: `nextUnfinishedId` (Task 1), `getOrder` (Task 2), existing `OrderPanel`, existing `updateOrderStatus`, existing `activeId`/`setActiveId`, `orderedStops`, `router`.
- Produces: no exported surface — internal UI.

- [ ] **Step 1: Extend imports**

In the lucide-react import (L5–18), add `ClipboardList` and `PackageCheck` to the icon list.

Change the api-client import (L20) from:

```ts
import { updateOrderStatus } from '@/lib/api-client';
```

to:

```ts
import { getOrder, updateOrderStatus } from '@/lib/api-client';
```

Add these imports below the existing type import (after L21):

```ts
import type { Order } from '@/lib/types';
import type { OrderStatus } from '@/lib/utils';
import { OrderPanel } from '@/components/orders/order-panel';
import { nextUnfinishedId } from './route-finish';
```

- [ ] **Step 2: Add state**

Immediately after the `finishing` bulk state (`const [finishing, setFinishing] = useState(false);`, ~L359), add:

```ts
  // Per-order finish: ids marked delivered this session (drive the "next" pointer).
  const [finishedIds, setFinishedIds] = useState<Set<string>>(new Set());
  const [finishingOne, setFinishingOne] = useState(false);
  // Order side panel opened from the route card for the current stop.
  const [panelOrder, setPanelOrder] = useState<Order | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
```

- [ ] **Step 3: Reset the finish pointer on day / courier switch**

In the effect that resets `activeId` on courier/day change (L170–173), add a reset for `finishedIds` so a new leg starts clean. Change:

```ts
  useEffect(() => {
    setActiveId(active.stops[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCourierIdx, route.date, route.couriers]);
```

to:

```ts
  useEffect(() => {
    setActiveId(active.stops[0]?.id ?? null);
    setFinishedIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCourierIdx, route.date, route.couriers]);
```

- [ ] **Step 4: Add handlers**

Immediately after the `finishDay` function (ends ~L374), add:

```ts
  // The first stop not yet finished this session — drives the finish button's
  // target and disabled state. Recomputed each render from the current order.
  const currentFinishId = nextUnfinishedId(orderedStops, finishedIds);

  // Mark the current (first unfinished) stop delivered and advance the highlight.
  // One click, no dialog. Refresh once when the whole leg is done (delivered
  // orders then drop out of the route on the server).
  const finishCurrent = async () => {
    if (!currentFinishId) return;
    const cur = orderedStops.find((s) => s.id === currentFinishId);
    if (!cur) return;
    setFinishingOne(true);
    try {
      await updateOrderStatus(cur.id, 'delivered');
      const next = new Set(finishedIds).add(cur.id);
      setFinishedIds(next);
      const nextId = nextUnfinishedId(orderedStops, next);
      setActiveId(nextId ?? cur.id);
      const remaining = orderedStops.length - next.size;
      toast.success(`${cur.customer ?? 'Клиент'} завършена · остават ${remaining}`);
      if (nextId == null) router.refresh(); // all done — reconcile with the server
    } catch {
      toast.error('Неуспешно маркиране — опитай пак');
    } finally {
      setFinishingOne(false);
    }
  };

  // Open the full order side panel for a stop (fetch the order first).
  const openStopPanel = async (stopId: string) => {
    setOpeningId(stopId);
    try {
      setPanelOrder(await getOrder(stopId));
    } catch {
      toast.error('Неуспешно зареждане на поръчката');
    } finally {
      setOpeningId(null);
    }
  };

  // Status action from inside the panel (Потвърди / Маркирай доставена / Откажи /
  // Промени статус) — updates the panel copy and refreshes the route.
  const panelAction = async (status: OrderStatus) => {
    if (!panelOrder) return;
    setPanelBusy(true);
    try {
      const updated = await updateOrderStatus(panelOrder.id, status);
      setPanelOrder(updated);
      toast.success('Статусът е обновен');
      router.refresh();
    } catch {
      toast.error('Неуспешна промяна на статуса');
    } finally {
      setPanelBusy(false);
    }
  };
```

- [ ] **Step 5: Add the two icon buttons**

In the route card header button row, immediately after the Google Maps button (`</button>` at ~L750, before the Waze button), insert:

```tsx
              <button
                onClick={() => {
                  const id = activeId ?? orderedStops[0]?.id;
                  if (id) void openStopPanel(id);
                }}
                disabled={!orderedStops.length || openingId != null}
                title="Отвори поръчката (детайли, потвърди, откажи)"
                aria-label="Отвори поръчката"
                className="inline-flex items-center justify-center rounded-[9px] border border-ff-border bg-ff-surface px-[11px] py-[7px] text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ClipboardList size={16} />
              </button>
              <button
                onClick={() => void finishCurrent()}
                disabled={!currentFinishId || finishingOne}
                title={
                  currentFinishId
                    ? `Завърши текущата поръчка (остават ${orderedStops.length - finishedIds.size})`
                    : 'Всички поръчки в маршрута са завършени'
                }
                aria-label="Завърши текущата поръчка"
                className="inline-flex items-center justify-center rounded-[9px] bg-ff-green-100 px-[11px] py-[7px] text-ff-green-800 transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <PackageCheck size={16} />
              </button>
```

- [ ] **Step 6: Render the order panel**

Immediately after the `confirmFinish` `ConfirmDialog` block (ends ~L821), add:

```tsx
      {panelOrder && (
        <OrderPanel
          order={panelOrder}
          busy={panelBusy}
          onClose={() => setPanelOrder(null)}
          onAction={(s) => void panelAction(s)}
          onSaved={(updated) => {
            setPanelOrder(updated);
            router.refresh();
          }}
        />
      )}
```

- [ ] **Step 7: Typecheck + lint**

Run: `cd client && npx tsc --noEmit && npx next lint --file src/components/route/route-client.tsx`
Expected: no new type errors; lint clean for the file.

- [ ] **Step 8: Verify in the browser preview**

Start the dev server (preview_start `web` / existing launch config), open `/route`, and confirm:
1. The route card header shows two new icon buttons (clipboard + package-check) between Google Maps and Waze.
2. Clicking the clipboard icon opens the right-hand `OrderPanel` for the highlighted stop, populated with customer, address, items, payment, and the Потвърди / Маркирай доставена / Откажи / Промени статус controls. Closing it works.
3. Marking a status inside the panel toasts „Статусът е обновен" and the panel/route reflect it (check `preview_console_logs` / `preview_network` for a `PATCH orders/:id/status` 200).
4. Clicking the package-check icon marks the current stop delivered, toasts „<клиент> завършена · остават N", and moves the list highlight to the next stop. Repeating steps through the leg; on the last one the route refreshes and the button goes disabled.

Capture a screenshot as proof.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/route/route-client.tsx
git commit -m "feat(route): open order panel + per-order finish icon buttons"
```

---

### Task 4: Help copy for the two buttons

**Files:**
- Modify: `client/src/components/route/route-client.tsx` (help modal `<ul>`, ~L634–684)

**Interfaces:** none.

- [ ] **Step 1: Add two help list items**

In the help modal `<ul>`, immediately after the „Завърших доставките" `<li>` (the bulk item, ~L657–661), insert:

```tsx
            <li>
              <b>Отвори поръчката</b> (иконата с листа) — отваря панела на текущата (маркираната)
              спирка: детайли, продукти, потвърждение, отказ и промяна на статус — без да излизаш от
              маршрута.
            </li>
            <li>
              <b>Завърши поръчката</b> (иконата с кутия и отметка) — маркира текущата поръчка като
              доставена и минава на следващата, една по една. За разлика от „Завърших доставките", което
              маркира всички наведнъж.
            </li>
```

- [ ] **Step 2: Lint**

Run: `cd client && npx next lint --file src/components/route/route-client.tsx`
Expected: clean.

- [ ] **Step 3: Verify in preview**

Reload `/route`, open Помощ, confirm the two new bullet points render correctly (Cyrillic intact, bold labels).

- [ ] **Step 4: Commit**

```bash
git add client/src/components/route/route-client.tsx
git commit -m "docs(route): help copy for order-panel + per-order finish buttons"
```

---

## Self-Review

**Spec coverage:**
- Button 1 (order side panel) → Task 2 (`getOrder`) + Task 3 (button, `openStopPanel`, `OrderPanel` render). ✅
- Button 2 (per-order finish stepper) → Task 1 (pointer) + Task 3 (button, `finishCurrent`). ✅
- Icon-only + tooltips → Task 3 Step 5. ✅
- One click, no dialog → `finishCurrent` has no `ConfirmDialog`. ✅
- Bulk stays → untouched. ✅
- Current stop = `activeId`, default first → Step 5 button uses `activeId ?? orderedStops[0]`; finish uses first-unfinished. ✅
- Reconcile via single refresh when done → `finishCurrent` refreshes only when `nextId == null`, mirroring `finishDay`. ✅
- Help copy → Task 4. ✅
- Spec's optional greying → intentionally dropped (documented in Global Constraints).

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `nextUnfinishedId` signature identical across Task 1 (def) and Task 3 (use). `getOrder(id): Promise<Order>` matches `setPanelOrder(await getOrder(...))`. `OrderStatus` imported from `@/lib/utils` (same source `order-panel.tsx` uses). `OrderPanel` props (`order`, `busy`, `onClose`, `onAction`, `onSaved`) match its definition. ✅
