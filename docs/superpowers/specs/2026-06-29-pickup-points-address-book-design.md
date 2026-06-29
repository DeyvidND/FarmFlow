# Pickup-points address book (dostavki sender)

Date: 2026-06-29
Branch base: `main`
Status: design approved, ready for implementation plan

## Problem

A farm can ship from more than one place (the farm, a town warehouse, different
Еcont/Speedy offices). Today dostavki stores a single sender per carrier
(`settings.delivery.econt.sender` / `…speedy.sender`). This adds a saved **address
book** of pickup points with one **active** point, while keeping the existing
single-sender contract that the waybill builder reads — so nothing downstream changes.

Builds on the just-shipped sender auto-fill + strip/modal
([2026-06-28-sender-autofill-and-carrier-card-design.md]).

## Key decision: "active point" model (zero downstream risk)

- `econt.sender` / `speedy.sender` stays the **active** pickup point — exactly the
  object `buildLabel` (econt.service.ts:577, 1545) and `buildShipmentRequest`
  (speedy.helpers.ts) already read. **Unchanged.**
- Add `econt.senders[]` / `speedy.senders[]` = the saved **book**. Each entry is the
  carrier's sender shape **plus** `id: string` and `label: string` (e.g. „Основна",
  „Склад Пловдив").
- "Select a point" = copy that point's sender fields into `.sender` (the active one).
  Auto-orders + manual + import all keep reading `.sender`, so they transparently use
  whatever point is active. No per-order pickup choice (YAGNI).

The book is **per carrier** (Еcont offices and Speedy sites/offices are different id
systems). No DB migration — `senders[]` lives in the same `settings.delivery.<carrier>`
jsonb blob.

## Data model

```ts
// client + server share the shape; PickupPoint = the carrier sender + id + label.
interface EcontPickupPoint extends EcontSender { id: string; label: string }
interface SpeedyPickupPoint extends SpeedySender { id: string; label: string }
// settings.delivery.econt: { ...creds, sender: <active>, senders: EcontPickupPoint[] }
```

`id` is a short client-generated string (e.g. `crypto.randomUUID()` slice); `label`
defaults to „Основна" for the first point, then a user-entered name.

## Backend

- **New save endpoint** per carrier: `POST /shipping/senders` (Еcont) +
  `POST /speedy/senders` (Speedy), JwtAuthGuard + CurrentTenant. Body
  `{ senders: PickupPoint[], activeId: string }`. The service:
  - writes `econt.senders = senders`,
  - sets `econt.sender` = the sender fields of the `activeId` point (strip `id`/`label`
    — or leave them; downstream ignores extra keys, but stripping keeps `sender` clean),
  - busts the tenant cache. `passwordEnc` untouched.
  - A pure helper `applySenderBook(blob, senders, activeId)` holds the mirror logic →
    unit-testable.
- **Migration on read** in `getConfig` (both services): if `senders` is absent/empty but
  `sender` is set, return `senders: [{ ...sender, id: <derived>, label: 'Основна' }]` and
  treat that point as active. A pure helper `readSenderBook(blob)` →
  `{ senders, activeId }` does this; the modal always receives a list. The
  auto-seeded sender (from connect) thus appears as point #1 automatically.
- `saveProfile` stays as-is for package/COD (unchanged). The sender editing moves to the
  new senders endpoint.

## Frontend (delivery-web)

- **`sender-modal.tsx` becomes a list manager** for one carrier:
  - lists the points; the active one shows a „✓ Активна" badge;
  - per point: [Избери] (set active), [✎] (edit inline → the existing name/phone/
    office/address form), [Изтрий];
  - „+ Добави точка" appends a new point (the same form);
  - on save → `POST …/senders { senders, activeId }`, then `onSaved()`.
  - Guard: cannot delete the last point; deleting the active point requires picking
    another first (or auto-promote the first remaining as active).
- **`sender-strip.tsx`**: shows the active point („Подаваш от: <label/name> · офис X");
  if `senders.length > 1`, append „· N точки". ✎ opens the modal.
- **`api-client.ts`**: `saveEcontSenders` / `saveSpeedySenders`; `getEcontConfig`/
  `getSpeedyConfig` now also surface `senders` (already spread by server `getConfig`).
- Package + COD stay in the modal under „Разширени" (unchanged).

## Data flow

```
connect ─▶ sender auto-seeded ─▶ getConfig: readSenderBook → senders:[{…,'Основна'}], active
modal: add/edit/delete/select points ─▶ POST /senders { senders, activeId }
   └─ applySenderBook → econt.senders = senders ; econt.sender = active point
waybill builder / auto-orders / import ─▶ read econt.sender (the active point)  [UNCHANGED]
```

## Error handling

- `readSenderBook` is defensive: missing/odd `senders` → derive from `sender`; missing
  both → empty list (strip shows the „⚠ Избери офис" prompt as today).
- `applySenderBook`: if `activeId` matches no point, fall back to the first point (never
  leave `sender` pointing at a deleted point). Empty `senders[]` → clear active sender.
- Saving the book never touches creds/handling/package/COD.

## Testing

- **Backend unit:** `readSenderBook` (sender→senders migration; already-has-senders
  passthrough; empty→[]); `applySenderBook` (mirrors active into sender; bad activeId →
  first; empty → cleared). Both Еcont + Speedy field shapes (Еcont `name`, Speedy
  `contactName`).
- **Frontend:** `pnpm -C delivery-web lint` + `build`.
- **Live smoke:** add a 2nd point, switch active → `settings.delivery.econt.sender`
  changes to the new point; delete a point; the auto-seeded point appears as „Основна".

## Non-goals

- Per-order pickup selection (auto-orders always use the active point).
- Import/export of points; sharing points across carriers (separate books).
- Any DB migration (jsonb-only).
- Touching the waybill builder / storefront order path (reads `.sender`, unchanged).
