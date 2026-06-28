# Carrier handling policy — преглед/тест преди плащане + хладилна доставка

Date: 2026-06-28
Branch base: `main`
Status: design approved, ready for implementation plan

## Problem

Two carrier-API features cut COD refusals and protect perishable food, both already
partly supported by our Econt payload but **never reachable by a farmer**:

1. **Преглед / тест преди плащане** — the recipient may open (or test) a наложен-платеж
   parcel before paying. On food this is the biggest lever against COD refusals: the
   buyer sees the goods are fine and pays instead of refusing on suspicion.
2. **Хладилна доставка** — perishable/refrigerated handling. Econt `refrigeratedPack`
   is already emitted by `buildLabel`, but only when `order.refrigerated` is set —
   and no storefront/auto order ever sets it, and there is no farmer toggle.

Today both are dead: the code can carry the flags, nothing turns them on.

## Decision: one farm-level policy, carrier-agnostic

Farmers set the intent **once** in carrier config; it auto-applies to every COD /
storefront order and every manual dostavki shipment. Rationale:

- Refrigerated is a property of the **goods** (the farm's products are perishable),
  not of an individual order. Per-shipment = farmer forgets once → spoiled delivery.
- Inspect-before-pay is **one COD policy** for the whole farm — same answer every order.
- The real refusal-reduction happens on **storefront auto-orders**, which auto-create
  shipments; a per-shipment toggle in dostavki can never touch them. Only a farm
  default covers them.
- Fewer clicks, no per-order cognitive load.

Per-shipment override is explicitly **out of scope** (YAGNI). Can be added later as an
override on top of the default if a real one-off need appears.

## Data model

Add to `settings.delivery` (jsonb — **no migration**):

```ts
handling?: {
  inspectBeforePay?: 'off' | 'open' | 'test'; // отвори / тествай преди наложен платеж
  refrigerated?: boolean;                      // хладилна доставка
}
```

Defaults: `inspectBeforePay: 'off'`, `refrigerated: false` → existing shipments are
**byte-identical**; no behavior change until a farmer opts in. The policy is shared
across carriers; each `CarrierAdapter` translates the shared intent into its own
payload (mirrors the existing carrier-agnostic config like free-over / markup).

`inspect` only ever applies to a COD shipment (`paymentMethod === 'cod' && !paidAt`).
On a prepaid/online order it is ignored regardless of the toggle.

## Data flow

```
panel carrier config ── writes ──▶ settings.delivery.handling
                                        │
                ┌───────────────────────┴───────────────────────┐
        storefront COD order                            manual dostavki create
          (auto-ship)                                         │
                └────────────▶ order → shipment builder ◀──────┘
                                        │
                       ┌────────────────┴────────────────┐
                  Econt buildLabel               Speedy buildShipmentRequest
                  • refrigeratedPack = 1          • additionalServices.refrigerated? (spike)
                  • inspect service (mapper)      • additionalServices.obpd          (spike)
```

The order→shipment builders (`buildOrderShipmentInput` for Speedy, the Econt
equivalent on the storefront-order path, and the manual create DTOs) gain the two
flags, sourced from `cfg.handling`. They currently never set refrigerated/inspect.

## Components

1. **Types / config**
   - `client/src/lib/types.ts`: add `handling` to `DeliveryConfig`.
   - server delivery config type mirrors it.
   - Panel UI: one shared „Обработка на пратката" sub-block (carrier-agnostic, so it
     lives once, not per-carrier-card): a select Изключено / Преглед (отвори) / Тест,
     and a „Хладилна доставка" toggle.

2. **Threading (storefront + manual)**
   - Econt: the storefront order→label path and manual-shipment DTO read
     `cfg.handling` → set `order.refrigerated` and a new inspect flag.
   - Speedy: `buildOrderShipmentInput` + `ManualInput` carry `refrigerated` + `inspect`
     from `cfg.handling`.

3. **Econt payload** (`econt.service.ts buildLabel`)
   - `refrigeratedPack` — already wired; just needs the flag fed in (step 2).
   - inspect-before-pay — add via a single mapper `econtInspectService(mode)` so the
     **exact Econt field name lives in one place** and is corrected after a live check.

4. **Speedy payload** (`speedy.helpers.ts buildShipmentRequest`)
   - `obpd` (open/test before pay) and `refrigerated`, behind spike. `obpd` needs a
     return-shipment service id + payer; until confirmed live, default-off keeps it
     inert. If the live contract lacks a field → no-op + `logger.warn`, Econt-only.

## Phasing (de-risk the live demo)

- **Phase 1 — Econt + shared model + UI + threading + tests.** Econt is the confident
  carrier and `refrigeratedPack` is confirmed. Ships value immediately. Inspect field
  sits behind the one-line mapper, easy to correct once confirmed against live creds.
- **Phase 2 — Speedy refrigerated + `obpd`.** Heavier (`obpd` return-shipment config),
  both fields unconfirmed. Do **after** real creds confirm the field names. The
  default-off toggle keeps it safe to ship the model now and fill Speedy in later.

## Spikes (must verify against live creds — user demos with real creds today)

- **Econt inspect field** — exact `services` key + value for „отвори преди да платиш" /
  „тествай преди да платиш". Implement behind `econtInspectService(mode)`; confirm live.
- **Speedy `obpd`** — shape (`option: 'OPEN'|'TEST'`, return-shipment service id + payer).
- **Speedy refrigerated** — whether the live contract exposes a refrigerated/temperature
  additional service at all; if not, document Econt-only.

## Testing

- Unit (payload builders): a plain shipment is unchanged; the field appears **only**
  when policy is set; inspect appears only on a COD shipment.
- Threading: a storefront COD order on a farm with `handling` set → the built shipment
  input carries `refrigerated` / `inspect`.
- UI: defaults render off; round-trips through save.
- Live smoke with real creds (Phase 1 Econt now; Phase 2 Speedy once confirmed).

## Non-goals

- Per-shipment override.
- Speedy fields shipped before live confirmation.
- Any DB migration (jsonb-only).
