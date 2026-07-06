# Маршрути: remove „Старт", add „Завърших доставките" — design

Date: 2026-07-06
Status: approved, ready for implementation plan
Scope: **client-only** (reuses existing `PATCH /orders/:id/status`, no backend/DB changes)

## Problem

Маршрути currently offers three export/nav actions: **Google Maps** (map
preview), **Старт** (turn-by-turn Google Maps navigation for the whole route),
and **Waze** (the step-by-step navigator just shipped). Farmers navigate with
their own phone's native app once they're on the road — they don't track
in-app turn-by-turn state, so „Старт" duplicates „Google Maps" (same deep
link, `dir_action=navigate` vs not) without adding real value.

What farmers actually need at the end of a route is a way to close out the
day: mark every stop delivered in one action, instead of editing orders one
by one on the Поръчки screen.

## Goal

1. Remove the „Старт" button (and its now-dead `navigate=true` code path).
2. Add a „Завърших доставките ✓" button that bulk-marks every stop in the
   current day's route as `delivered`, after an in-app confirm dialog.

## Non-goals

- No backend/API changes — reuses the existing `updateOrderStatus(id, status)`
  call (`client/src/lib/api-client.ts`), which already `PATCH`es
  `orders/:id/status`.
- Does not touch payment/COD state (`collected`, `codOutcome`) — delivery
  status and money-collected are separate, already-existing concerns
  (COD „Получих парите" flow). This button only sets `status: 'delivered'`.
- No new "route completed" empty state — the existing `stop-list.tsx:225-232`
  „Няма спирки за този ден" empty state already covers it once the day's
  stops (all `confirmed` orders) are gone from the route response. The
  success toast is what communicates "done for today", not a new screen.
- No per-stop individual delivered-toggle — out of scope; bulk-only per the
  approved design.

## Remove „Старт"

In `client/src/components/route/route-client.tsx`:

- Delete the „Старт" `<button>` (currently ~lines 540-547).
- `openRoute` currently takes a `navigate: boolean` param used only to
  distinguish „Google Maps" (`false`) from „Старт" (`true`). With „Старт"
  gone, only `false` is ever passed — simplify `openRoute()` to take no
  param, and simplify `dirUrls`/`legUrl` (lines ~71-97) to drop their
  `navigate` parameter and the `dir_action=navigate` branch entirely (dead
  code once the only caller always omits it).
- Drop the `navigate ?` ternary in the success toast — always
  `'Маршрутът се отваря в Google Maps'`.
- Remove the now-unused `Truck` icon import (`lucide-react`).

## Add „Завърших доставките"

**Placement:** where „Старт" used to be, in the same button group as
„Google Maps" and „Waze" (stops-list header, `route-client.tsx` ~line 528).

**Button:**
- Label „Завърших доставките ✓", primary/green styling (reuses the
  `ff-green-100`/`ff-green-800` treatment „Старт" used).
- `disabled={!stops.length}`, matching the other two buttons.
- Icon: `CheckCircle2` (lucide-react) — new import.

**Confirm dialog:** reuse the existing `client/src/components/ui/confirm-dialog.tsx`
(`ConfirmDialog`) component — already used elsewhere in the codebase
(`products-client.tsx`, `order-panel.tsx`, etc.) for exactly this
open-state + busy-state pattern. Do not build a new modal.

- `title`: „Завърши доставките за днес?"
- `message`: „Всички {N} спирки ще бъдат маркирани като доставени."
  ({N} = `stops.length` at click time.)
- `confirmLabel`: „Завърших"
- `tone`: `'primary'` (this is a normal, reversible-via-Поръчки action, not
  destructive — no `danger` tone).
- `busy`: true while the bulk update is in flight (buttons disabled, label
  „Момент…" — built into `ConfirmDialog` already).

**Bulk action — client-side, existing endpoint:**

```ts
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

- `RouteStop.id` is the order id (confirmed in `server/src/modules/routing/routing.service.ts:216`,
  `id: orders.id`), so `updateOrderStatus(s.id, 'delivered')` targets the
  right order per stop directly — no id mapping needed.
- `Promise.allSettled` (not `Promise.all`) so one failing PATCH doesn't
  block the rest from completing — same resilience pattern already used
  elsewhere in this codebase (operator daily digest).
- On partial failure, the failed orders simply remain `confirmed` and
  reappear as stops on the next `router.refresh()` — the farmer can retry
  the button, no separate error-recovery UI needed.
- After refresh, delivered stops drop out of the route response (route
  only includes `confirmed` orders); the existing empty state renders
  naturally.

## State

In `route-client.tsx`, alongside the existing `showLoc`/`showHelp`/`showWaze`
state:

```ts
const [confirmFinish, setConfirmFinish] = useState(false);
const [finishing, setFinishing] = useState(false);
```

Button `onClick={() => setConfirmFinish(true)}`. `ConfirmDialog` rendered
conditionally (`{confirmFinish && <ConfirmDialog .../>}`), `busy={finishing}`,
`onCancel={() => setConfirmFinish(false)}`, `onConfirm={finishDay}`.

## Files

- **Modify** `client/src/components/route/route-client.tsx`:
  - Remove „Старт" button, `navigate` param from `openRoute`/`dirUrls`/`legUrl`,
    `Truck` import.
  - Add `confirmFinish`/`finishing` state, `finishDay` handler, „Завърших
    доставките" button, `<ConfirmDialog>` render, `CheckCircle2` import,
    `ConfirmDialog` import.
- No changes to `waze.ts`, `waze-stepper.tsx`, `stop-list.tsx`,
  `confirm-dialog.tsx`, or any backend file.

## Edge cases

- **0 stops** → button disabled (same as siblings), dialog never opens.
- **Partial API failure** → toast reports the split, failed orders remain
  in the route for retry; no silent data loss.
- **Rapid double-click** → `busy`/`disabled` on the dialog's confirm button
  (built into `ConfirmDialog`) prevents a second concurrent bulk call.
- **COD orders** → `delivered` status set regardless of `collected`/
  `codOutcome` — those fields are untouched, matching the existing separate
  „Получих парите" flow (a farmer still marks money received independently).

## Testing

No new pure-logic module is introduced (this task only edits
`route-client.tsx`, which has no unit-test harness in this codebase — verified
via `pnpm lint` + manual/preview click-through, matching how Task 3 of the
Waze plan was verified). No automated test is planned beyond lint/build;
verification is preview-based:
1. Confirm the „Старт" button and its Google-Maps-navigate behavior are gone.
2. Confirm „Google Maps" preview and „Waze" stepper still work unchanged.
3. Click „Завърших доставките" → confirm dialog shows the correct stop count
   → confirm → stops disappear from the list, success toast shown.
4. Verify (via `Поръчки` screen or DB) that the affected orders' `status` is
   now `delivered` and `collected`/`codOutcome` are unchanged.

## Rollout

Pure client feature reusing an existing endpoint — no env/migration. Ships
with the next client build.
