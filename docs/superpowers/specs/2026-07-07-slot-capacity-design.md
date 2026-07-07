# Delivery slot capacity (multiple orders / workers per slot)

Date: 2026-07-07
Status: approved

## Problem

A delivery slot (e.g. 14:00–14:30) currently holds **exactly one** order. A farm
that puts two people on a route can only sell one delivery per slot. The farmer
wants to say "this slot can take N orders" — N being how many people work that
slot — with an option to set it per slot, plus a sensible default.

Capacity columns (`max_orders` / `current_orders`) existed once and were dropped
in migration `0047`. This spec re-introduces capacity in a simpler form: a single
`capacity` integer per slot, no `current_orders` counter (booked is always
computed live from non-cancelled orders, as it already is today).

## Decisions (locked)

- **Model:** a plain capacity number per slot. Not named workers, no per-worker
  assignment or routing. "2 people" == "slot accepts 2 orders."
- **Where set:** a default on the recurring rule (`settings.slotRule`) **plus** a
  per-slot override on each concrete slot row.
- **Migration default:** `capacity = 1` for all existing slots and for the rule
  default. Current single-order behaviour is preserved; farms opt in by raising
  the number.
- **Range:** 1–20 (clamped both server-side and in the UI).

## Data model

### Slot row
Add to `delivery_slots` (schema.ts + new migration `0079_delivery_slot_capacity.sql`):

```sql
ALTER TABLE "delivery_slots" ADD COLUMN "capacity" integer NOT NULL DEFAULT 1;
```

No backfill needed — the `DEFAULT 1` fills existing rows, matching today's
one-order behaviour. Drizzle meta (`_journal.json` + snapshot) updated with the
migration.

### Rule
Add `defaultCapacity?: number` to `SlotRule` (`slot-rule.ts`). Defaults to 1.
`normalizeRule` clamps to 1–20 (0/absent → 1). The generator
(`materializeRule` / `slotRuleSlots`) stamps every generated slot with
`rule.defaultCapacity`.

`migrateRule` for legacy rules: absent `defaultCapacity` → 1. The removed legacy
`maxOrders` field stays ignored.

## Enforcement — the only two places that hardcode "1"

### 1. Booking gate — `orders.service.ts` (~line 1374)
The slot row is already `SELECT … FOR UPDATE` locked in the checkout transaction,
so concurrent bookings on the same slot serialize. Change the count check:

```ts
// was: if (count >= 1) throw new ConflictException('Слотът е запълнен');
if (count >= slot.capacity) throw new ConflictException('Слотът е запълнен');
```

`slot.capacity` comes from the already-selected locked row. Message unchanged.

### 2. Public picker — `slots.service.ts` `findPublicBySlug` (~line 252)
Return a slot while it has room, not only when empty. Add `capacity` to the
grouped select and change the HAVING:

```ts
// was: .having(sql`count(${orders.id}) = 0`)
.having(sql`count(${orders.id}) < ${deliverySlots.capacity}`)
```

`PublicSlot` shape stays trimmed — capacity is **not** exposed to the storefront
(a slot simply keeps appearing in the picker until it is full). The
same-day-cutoff filter is unchanged.

## Admin API / DTOs

- `create-slot.dto.ts`: add `capacity?` (int, 1–20, default 1).
- `update-slot.dto.ts`: add `capacity?` (int, 1–20) to the allow-list so a slot
  edit can change it (`slots.service.update` allow-list gains `capacity`).
- `slots.service.create`: include `capacity: dto.capacity ?? 1` in the base row.
- `slot-rule.dto.ts`: add `defaultCapacity?` (int, 1–20).
- `saveRule` needs no new logic: it already deletes future *unbooked generated*
  slots and rematerializes, so those pick up the new `defaultCapacity`
  automatically. Booked and manual slots keep their own `capacity`.
- `findAll` already returns `capacity` via `getTableColumns(deliverySlots)` — no
  query change; the `booked` computation is untouched.

## Client (admin panel)

- `types.ts`: `Slot` += `capacity: number`; `SlotRule` (client) +=
  `defaultCapacity?: number`.
- `lib/slots.ts` `slotColor(booked, capacity)`: green while `booked < capacity`,
  gray when full.
- `slot-pill.tsx`: render `booked/capacity` (e.g. `1/2`); label "Зает" only when
  `booked >= capacity`, otherwise "Свободен". When `capacity === 1` keep the
  current plain "Свободен"/"Зает" so nothing changes visually for farms that
  never touch it.
- `add-slot-dialog.tsx`: a number input "Поръчки на слот" (min 1, max 20,
  default 1); `SlotInput` += `capacity`; wired through `onSubmit`.
- `recurrence-card.tsx`: a "Поръчки на слот" number input beside the existing
  `slotMinutes` control, bound to `defaultCapacity`.
- Replace `booked >= 1` "is this slot free / what's the next free slot" logic
  with `booked >= capacity` at:
  - `app/(admin)/delivery/page.tsx:68` (freeThisWeek)
  - `components/dashboard/dashboard-client.tsx:300`
  - `components/layout/topbar.tsx:68`
  - `components/settings/config-sections.tsx:56` and `:102`
  (`DashboardSlot` gains `capacity` where these read it.)

## Storefront

No change. `slot-picker.tsx` consumes `PublicSlot`, which is unchanged; the picker
keeps offering an available slot until the server stops returning it (i.e. until
`booked` reaches `capacity`).

## Copy

Farmer-facing label: **"Поръчки на слот"** with helper text
*"колко доставки поемаш едновременно (напр. 2 човека = 2)"*. No "capacity" jargon,
no worker names.

## Edge cases

- **Lowering capacity below current booked** (e.g. 2 booked, set to 1): allowed.
  No new bookings pass the `>=` gate; the pill shows an over-full `2/1`. Not
  blocked — the farmer resolves it by cancelling/moving an order if they care.
- **Manual one-off slot**: default `capacity = 1`.
- **Cancelling an order** frees a unit automatically (booked is computed from
  non-cancelled orders) — no counter to decrement.
- **`slotMinutes` chunks**: each generated chunk inherits `rule.defaultCapacity`.

## Tests

- `slot-rule.spec.ts`: `normalizeRule` clamps `defaultCapacity` (0→1, 99→20);
  `slotRuleSlots` output carries the capacity intent (generator stamps it).
- `slots.service.spec.ts`: `findPublicBySlug` returns a capacity-2 slot with one
  booked order and hides it once two are booked; `findAll` returns
  `capacity` + `booked`.
- `orders.service` booking spec: a second order on a capacity-2 slot succeeds; a
  third throws `ConflictException('Слотът е запълнен')`; capacity-1 slot rejects
  the second (regression guard for existing behaviour).

## Out of scope

- Named workers / per-worker order assignment / per-worker routing.
- Exposing remaining capacity or a "N left" badge in the storefront picker.
- Per-weekday capacity (single rule-wide `defaultCapacity` only).
