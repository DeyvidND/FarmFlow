# Optional Econt + convenient self-delivery slots — design

Date: 2026-06-08
Status: approved (brainstorm) → spec for implementation

## Problem

Two farmer pains:

1. **Econt is too much accounting.** A farm that only self-delivers (or does
   market pickup) is still shown courier shipments, waybills, COD reconciliation
   and nomenclature sync. They want to ignore Econt entirely.
2. **Self-delivery slots are tedious and dumb.** Slots are bare time-windows
   (`date, timeFrom, timeTo, maxOrders`). A farmer who delivers a route every
   few days and phones the customer to arrange the exact time has no way to:
   - set the recurrence once and have slots appear forward automatically,
   - attach a note the customer sees ("фермерът ще се обади преди доставка"),
   - attach a private note for whoever drives the route (area, phone, order).

This is **chaika** (`fermerski-pazar-chaika`, the Пазар Astro storefront) +
the FarmFlow admin (`client/`) + the API (`server/`) + shared db.

## What already exists (do not rebuild)

- `EcontMode = 'off' | 'manual' | 'auto'` and the admin Segmented toggle
  (`econt-section.tsx`). `off` already hides Econt from customers and the
  econt-section already self-collapses when mode ≠ `auto`.
- chaika already has the four delivery methods incl. local self-delivery
  (`address`) with a live `/slots` picker, gated by `deliveryEnabled`.
- `deliverySlots` table with the bare columns above; `SlotsService` with
  `findAll`, `create` (incl. a weekday bulk helper `expandDates`), `update`,
  `remove`, `findPublicBySlug` (→ `PublicSlot`).

## Decisions (locked with user)

- Slot note: **both** — a customer-facing note and a private driver note.
- Recurrence: **a rule that auto-fills slots forward** (not just a bulk dialog).
- Econt: **default off for new farms + hide the accounting UI when off** (keep
  `manual`/`auto` for farms that want courier shipping). Not removed.

## Architecture

Money stays integer stotinki. Weekday convention stays `0=Sun … 6=Sat`
(matches existing `expandDates` `getUTCDay()`).

### A. Econt default-off + hide accounting

**Defaults** (`client/src/lib/delivery-data.ts` `DEFAULT_DELIVERY`):
- `methods.econtOffice.enabled = false`
- `methods.econtAddress.enabled = false`
- `econt.mode = 'off'` (ensure the default econt object sets it)
- keep `methods.ownSlots.enabled = true`; set `methods.pickup.enabled = true`
  so a brand-new farm ships with self-delivery + pickup ready.

Only affects tenants with **no saved** delivery config. Existing farms keep
their saved settings (their config is already persisted, so the hydrate default
never overrides them).

**Hide accounting** (`client/src/components/delivery/delivery-client.tsx`):
- Render `OfficePickerPreview` and `ShipmentsTable` only when
  `econtMode(cfg) === 'auto'`.
- `MethodsSection`: hide the `econtOffice`/`econtAddress` method rows when
  `econtMode(cfg) === 'off'` (keep them when `manual`/`auto`).
- econt-section: no change (already collapses to just the mode toggle).

Net: a self-delivery farm sees the master toggle, methods (self-delivery +
pickup), pricing, schedule, and the Econt mode toggle defaulted to off — no
waybills, no shipments table, no office preview.

**chaika** (`checkout.astro` + `checkout-page.ts`): the Econt radio options and
the Econt office/city fields must not render when `econtMode === 'off'`. Verify
current behaviour and fix the leak — the script already gates the office picker
on `auto`, but the radios themselves must be conditioned on the mode too. When
off, only pickup + local self-delivery remain.

### B. Slot notes

Migration (next number, e.g. `0030`) adds to `delivery_slots`:
- `customer_note text` — shown to the customer in the storefront picker.
- `driver_note text` — admin-only; never serialized to the storefront.
- `generated boolean not null default false` — true for rows the recurrence
  generator created (vs. one-off manual slots).

Server (`SlotsService` + DTOs):
- `findAll` already returns all columns via `getTableColumns` → notes included
  for the admin.
- `findPublicBySlug` / `PublicSlot`: add `customerNote` to the selected shape.
  **Do not** select `driver_note`.
- `CreateSlotDto` / `UpdateSlotDto`: add optional `customerNote?`, `driverNote?`.
- `create` / `update` persist them.

chaika (`src/lib/types.ts` `Slot` + `checkout-page.ts` slot picker): the `Slot`
type gains `customerNote?: string`; render it (muted line under the slot button
and/or in the "Избра:" confirmation) when present.

### C. Recurrence rule (auto-fill)

Stored as a **single rule** in `settings.delivery.slotRule` (jsonb) — no new
table. Shape:

```ts
interface SlotRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  weekdays: number[];        // for 'weekdays'; 0=Sun..6=Sat
  intervalDays: number;      // for 'interval', e.g. 3
  anchorDate: string;        // YYYY-MM-DD; interval counts from here; also lower bound
  timeFrom: string;          // HH:MM
  timeTo: string;            // HH:MM
  maxOrders: number;
  customerNote?: string;     // copied onto generated slots
  driverNote?: string;       // copied onto generated slots
  horizonDays: number;       // default 28 — how far ahead to keep filled
  skipDates: string[];       // dates the farmer deleted; never regenerate
  lastMaterializedDate?: string; // watermark (YYYY-MM-DD), idempotency guard
}
```

**Generator** — `SlotsService.materializeRule(tenantId, rule, today)`:
1. Compute target dates in `[max(today, anchorDate) … today + horizonDays]`:
   - `weekdays`: every date whose `getUTCDay()` ∈ `weekdays`.
   - `interval`: `anchorDate + k*intervalDays` that fall in the window.
2. Drop dates in `skipDates`.
3. Drop dates that already have a `generated` slot for this tenant on that date
   (query existing generated slots in the window once; diff in memory).
4. Insert the remaining as `generated:true` slots copying
   `timeFrom/timeTo/maxOrders/customerNote/driverNote`.
5. Set `lastMaterializedDate = today` in the saved rule.
Bounded: cap inserts per run (window ≤ ~366 like `expandDates`).

**When it runs** (never on the public read path):
- on rule save/update (admin `saveDelivery` or a dedicated rule endpoint),
- on admin slots-page server load (cheap top-up — idempotent via the date-diff),
- in the **daily digest job** (`DigestService`) to roll the horizon forward.
  If the digest is not actually scheduled, the slots-page top-up still covers
  the common case; note this and wire whichever scheduler the digest uses.

**Editing semantics:**
- Edit rule → delete future **unbooked** `generated` slots (`date >= today`,
  no non-cancelled orders) for the tenant, then re-materialize. Booked slots
  survive untouched (their notes may diverge from the new rule — acceptable).
- Delete a generated slot in the UI → add its `date` to `skipDates` (so the
  generator won't recreate it) and delete the row. (Deleting a *booked* slot is
  already guarded by FK from orders — keep existing behaviour.)
- Toggle rule off → stop generating; leave existing slots in place.

### D. Slots admin UX (`client/src/app/(admin)/slots/`)

- **Recurrence card**: edit the `slotRule` — repeat mode (weekdays chips vs.
  "every N days" + anchor), time, capacity, both notes, active toggle. Save
  triggers materialize. Show a line like "Следващи слотове до DD.MM".
- **Editable one-off slots**: today's `AddSlotDialog` is create-only; add an
  edit path (reuse the dialog with prefilled values calling `update`). Both add
  and edit expose `customerNote` + `driverNote` inputs.
- **slot-pill**: badge for `generated` slots; a small indicator when a
  `driverNote`/`customerNote` is present.

## Components / boundaries

- `delivery-pricing.ts` — unchanged (fees). The rule is schedule, not pricing.
- `SlotsService` — gains `materializeRule` + note handling; stays the single
  authority for slot rows. Generator is a pure date-math helper + one bulk
  insert, testable in isolation (like `expandDates`).
- Rule type lives next to `DeliveryConfig` (shared types) so admin + server +
  chaika agree on its shape.
- chaika reads only `customerNote`; the storefront has no concept of the rule.

## Error handling

- Generator validates the rule (valid weekdays / `intervalDays >= 1` /
  `anchorDate` parseable / `timeTo > timeFrom` / `maxOrders >= 1`); invalid rule
  → no generation, surface a `BadRequestException` on save.
- Materialize is idempotent (date-diff + watermark) — safe to run repeatedly
  and concurrently-ish (duplicate inserts avoided by the in-window diff; a
  unique index on `(tenant_id, date, time_from)` for generated rows is a
  nice-to-have backstop, deferred unless cheap).
- `driver_note` must never appear in any public payload — assert by selecting
  an explicit column list in `findPublicBySlug` (already the pattern there).

## Testing

- Unit (`slots.service.spec.ts` / a date-math helper spec): weekday expansion,
  interval expansion from anchor, horizon bound, `skipDates` exclusion,
  already-materialized exclusion, watermark.
- Service: edit-rule deletes only future unbooked generated slots; booked
  survive; delete records skipDate.
- Public shape: `findPublicBySlug` returns `customerNote`, never `driverNote`.
- Existing 132 tests stay green.

## Out of scope (YAGNI)

- Multiple concurrent rules / per-weekday different times (single rule only).
- Per-method free-over, weight pricing (unchanged).
- Removing Econt code paths (kept for `manual`/`auto` farms).
- Storefront showing the recurrence rule itself.
