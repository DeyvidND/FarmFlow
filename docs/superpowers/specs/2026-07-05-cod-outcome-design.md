# COD Outcome — unified cash-on-delivery settlement across delivery modes

Date: 2026-07-05

## Problem

Наложен платеж (COD) orders have no first-class "money outcome" concept.

- Current model conflates money with fulfillment: "Получих парите" on the Плащания
  screen calls `updateOrderStatus(id, 'delivered')`; a COD order is deemed collected
  only because `order.status === 'delivered'` (`payments-client.tsx:248-266`,
  `orders.service.ts` `toPaymentOrder`).
- There is no "отказана"/refused state on `orders`. Courier returns/refusals ARE
  detected (`cod-risk.helpers.ts` `isReturnedStatus`) and feed the "Некоректен клиент"
  fraud-strike system (`cod-risk.service.ts` `recordReturnIfApplicable`), but this never
  surfaces on the Плащания/Поръчки screens and never touches `orders`.
- No auto-received: no cron or courier signal marks COD money as received; it is a pure
  manual click.
- Econt already auto-reconciles COD money (`shipments.codCollectedAt` / `codSettledAt`
  → badge Очаквано→Събрано→Преведено, `payments-client.tsx:104-109`). Speedy shares the
  reconciliation batch (settledAt) but does NOT populate `codCollectedAt`.

Three delivery modes need coherent handling:

- **Лична доставка** — farmer's own delivery: `deliveryType='address'` or own
  `deliveryType='courier'`. No courier signal.
- **На място** — pickup at farm: `deliveryType='pickup'`. No courier signal.
- **Деливъри сървис** — Econt (`econt`/`econt_address`) and Speedy
  (`courier` + `carrier='speedy'`). Courier status tracked in `shipments`.

## Goal

A dedicated COD-money outcome on the order, decoupled from fulfillment status:
auto-driven from real courier signals where they exist, manual where they do not,
and consistently surfaced (badges) + wired into cod-risk on refusal.

Non-goal: NO blind time-based auto-received (a next-day timer would count uncollected
cash as collected). Received is set only from a real signal (courier) or a manual click.

## Data model

New enum + columns on `orders` (one migration, hand-written per repo convention):

```
export const codOutcomeEnum = pgEnum('cod_outcome', ['received', 'refused']);

// on orders:
codOutcome:       codOutcomeEnum('cod_outcome'),                 // nullable; NULL = Очаквано
codOutcomeAt:     timestamp('cod_outcome_at', { withTimezone: true }),
codOutcomeReason: text('cod_outcome_reason'),                    // nullable; manual refusals only
codOutcomeSource: text('cod_outcome_source'),                    // 'courier' | 'manual'
```

- `NULL` codOutcome = still pending (Очаквано).
- Orthogonal to `orders.status`. Payments screen no longer derives "collected" from
  `status='delivered'`; it reads `codOutcome`.
- `codOutcomeSource` is an audit of who set it. (Enum reserves 'auto' semantics but we
  only ever write 'courier' or 'manual'; keep the column free-text to avoid a second
  enum migration.)

### Backfill (in the same migration)

Existing COD orders already marked delivered were the old "collected" signal:

```
UPDATE orders
   SET cod_outcome = 'received',
       cod_outcome_at = COALESCE(paid_at, created_at),
       cod_outcome_source = 'manual'
 WHERE payment_method = 'cod' AND status = 'delivered' AND cod_outcome IS NULL;
```

## Transition matrix

| Mode | received (auto) | refused (auto) | manual |
|---|---|---|---|
| Econt (`econt`/`econt_address`) | `codCollectedAt` populated | shipment status `returned`/`refused` | override button |
| Speedy (`courier`+`carrier='speedy'`) | status=`delivered` (+ new `codCollectedAt`) | status `returned`/`refused` | override button |
| Лична доставка (`address` / own `courier`) | — | — | manual: Получих парите / Отказана |
| На място (`pickup`) | — | — | manual: Получих парите / Отказана |

## Auto wiring (courier)

In `refreshStatusForRow` (both `econt.service.ts` and `speedy.service.ts`), after the
shipment row is updated and the existing `recordReturnIfApplicable` call, add an
order-COD-outcome sync for order-backed COD shipments:

- shipment reached delivered **and** COD collected → set order `codOutcome='received'`,
  `codOutcomeSource='courier'`, `codOutcomeAt=now`.
- `isReturnedStatus(status)` true → set order `codOutcome='refused'`,
  `codOutcomeSource='courier'`, `codOutcomeAt=now`.
- **Idempotent + no-clobber:** update only `WHERE cod_outcome IS NULL` (a prior manual
  override is never overwritten by a later courier refresh).
- Best-effort: a failure here must never fail the shipment refresh (same try/catch
  posture as the existing cod-risk / shipped-email calls).
- **Speedy gap:** Speedy `refreshStatusForRow` does not currently write
  `codCollectedAt`. Add: when Speedy status becomes `delivered` on a COD parcel, set
  `codCollectedAt=now` so the Събрано/Преведено reconciliation badge also works for
  Speedy. (Received-outcome keys off status=`delivered`; the codCollectedAt write is for
  the reconciliation badge parity.)

The "received" decision reuses the carrier's own delivered signal:
- Econt: `codCollectedAt` non-null (set from Econt's `cod` payload, `econt.service.ts:1259`).
- Speedy: canonical `status === 'delivered'` (`parseTrackStatus`).

## Manual wiring (pickup / own)

New endpoint: `PATCH orders/:id/cod-outcome` body `{ outcome: 'received' | 'refused', reason?: string }`.

- Tenant-scoped, IDOR-safe (same guard as the existing order-status update).
- Only valid for `paymentMethod='cod'` orders. Reject otherwise (400).
- Writes `codOutcome`, `codOutcomeAt=now`, `codOutcomeSource='manual'`, and
  `codOutcomeReason` when `outcome='refused'` (reason optional).
- On `outcome='refused'` → call a new `codRisk.recordManualRefusal(order)` that records a
  strike keyed on `normalizePhone(order.customerPhone)` (parallel to the shipment-keyed
  `recordReturnIfApplicable`; writes `codRisk` + `codRiskEvents` with
  `lastEventType='returned'`). Applies to ALL modes, incl. courier overrides to refused.
  Must be idempotent per order (guard so re-marking the same order refused does not add a
  second strike — e.g. only strike on the NULL→refused transition).
- `received` replaces the current Плащания "Получих парите" behavior of calling
  `updateOrderStatus(id, 'delivered')`. Money and fulfillment are now separate:
  marking received no longer flips fulfillment `status`.

## API surface

`GET` order/payment list responses gain `codOutcome`, `codOutcomeAt`, `codOutcomeReason`
so the client renders badges without a second fetch. The Econt/Speedy reconciliation row
(`CodReconRow`) is still used for the Събрано/Преведено split; `codOutcome` supersedes the
"expected vs collected" fallback for non-courier orders.

## UI

- **payments-client.tsx** — `codSettlementBadge` becomes 4-state:
  - `codOutcome='refused'` → **Отказана** (red).
  - else Econt/Speedy reconciliation: `settledAt` → Преведено, `collectedAt`/`codOutcome='received'` → Събрано.
  - else `codOutcome='received'` → Събрано (non-courier).
  - else Очаквано.
  - `CollectButton` / `onCollect` calls the new `cod-outcome` endpoint (`received`)
    instead of `updateOrderStatus(id, 'delivered')`. Add an "Отказана" action.
- **order-panel.tsx** — new "Плащане (наложен платеж)" section:
  - pickup / own delivery: buttons **Получих парите** and **Отказана** (+ optional reason
    input on refusal).
  - Econt / Speedy: read-only outcome badge, with a small "коригирай" override link that
    hits the same manual endpoint (courier signal can be wrong).
  - Hidden entirely for non-COD (`paymentMethod='online'`) orders.
- **orders list** — show the **Отказана** badge on refused COD rows.

## Testing

- Unit — transition matrix: courier delivered→received; courier returned/refused→refused;
  manual received; manual refused; idempotent (courier refresh does NOT clobber a manual
  override); non-COD rejected by the manual endpoint.
- Unit — `recordManualRefusal`: strike on NULL→refused only; no double-strike on repeat.
- Migration spec — backfill marks existing `cod + delivered` as `received`.
- Speedy — delivered COD parcel sets `codCollectedAt` (reconciliation-badge parity).

## Files touched (indicative)

- `packages/db/src/schema.ts` — enum + columns + index if needed; new migration file.
- `server/src/modules/orders/orders.service.ts` — serialize `codOutcome*`; manual endpoint service method.
- `server/src/modules/orders/orders.controller.ts` — `PATCH :id/cod-outcome`.
- `server/src/modules/orders/dto/` — new `update-cod-outcome.dto.ts`.
- `server/src/modules/econt/econt.service.ts` — outcome sync in `refreshStatusForRow`.
- `server/src/modules/speedy/speedy.service.ts` — outcome sync + `codCollectedAt` on delivered.
- `server/src/modules/cod-risk/cod-risk.service.ts` — `recordManualRefusal`.
- `client/src/lib/api-client.ts` + `types.ts` — `codOutcome*` fields; `setCodOutcome` call.
- `client/src/components/payments/payments-client.tsx` — 4-state badge; refused action; endpoint swap.
- `client/src/components/orders/order-panel.tsx` — payment section.
- `client/src/components/orders/orders-client.tsx` — refused badge in list.
