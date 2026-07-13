# Session 2 — implementation plan

## #3 revert COD outcome (no migration) — COMMIT 1
- `dto/update-cod-outcome.dto.ts`: enum `['received','refused','pending']`.
- `orders.service.ts setCodOutcome`: branch on `pending` → null out cod fields; void commission;
  call `codRisk.undoManualRefusal(prevRow)` when prev was `refused`.
- `cod-risk.service.ts`: add `undoManualRefusal(order)` — decrement strikes (floor 0), delete the
  last manual `returned` event for that phone+tenant. Best-effort.
- FE `payments-client.tsx` + `my-orders-client.tsx`: «Върни» control when `codOutcome != null`.
- `api-client.ts setCodOutcome`: widen outcome type; add `revertCodOutcome` helper.
- Tests: service spec (revert nulls + voids + un-strikes); dto spec.

## #8 payments totals exclude refused (no migration) — COMMIT 2
- `orders.service.ts`: owner `paymentTotalsCached` + farmer `paymentsForFarmer` totals —
  `sum(total) filter (where cod_outcome is distinct from 'refused')`.
- Reproduce: isolated Postgres (port 5434), run old vs new aggregate SQL, show refused excluded.
- Tests: keep paymentTotals pure-fold tests; add a note test for the filtered semantics.

## #9 + #10 turnover breakdown — COMMIT 3
- Migration `0097_order_delivered_at.sql`: `ALTER TABLE orders ADD COLUMN delivered_at timestamptz`;
  backfill delivered rows `= coalesce(cod_outcome_at, paid_at, created_at)`; index.
- schema.ts: add `deliveredAt`.
- `orders.service.ts updateStatus`: set `delivered_at=now()` on first transition into `delivered`;
  clear on transition out of `delivered`.
- `stats.service.ts`: new `turnoverBreakdown(tenantId, {range/from/to, basis, includeUndelivered, farmerId})`
  returning window + to-date turnover, platform income (rate bps), delivered/undelivered split, points[].
  Basis via a `basisDay` day-string expr (placed=bgDate(created_at); delivery=coalesce(slot.date,
  bgDate(created_at)); delivered=bgDate(delivered_at)). Farmer scope joins products.
- `stats.controller.ts`: `GET /stats/turnover`.
- FE: `TurnoverHistory` section in stats-client with basis segmented control + undelivered toggle +
  to-date/platform tiles + trend. `api-client.getTurnover`, types.
- Tests: pure helpers (basisDay expr builder, platform income calc) + controller wiring.

## #14 tomorrow farmer email + fulfilment — COMMIT 4
- Migration `0098_order_fulfillments.sql`: table (order_id, farmer_id, state enum, updated_at,
  unique(order_id,farmer_id)); schema.ts + index.ts exports.
- `digest.service.ts`: `runTomorrowForTenant` / `sendFarmerTomorrow` (reuse farmer digest render,
  «за утре»); `eligibleTenantIds` reused.
- `digest.processor.ts`: register `tomorrow` repeatable `0 18 * * *`; fan out `tenant-tomorrow`.
- `orders.service.ts`: `tomorrowForFarmer(tenantId, farmerId)` (tomorrow's confirmed orders w/ this
  farmer's items + fulfilment state + contact); `setFulfillment(id, tenantId, farmerId, state)` (IDOR-scoped).
- `orders.controller.ts`: `GET /orders/tomorrow`, `PATCH /orders/:id/fulfillment`.
- FE: `client/(admin)/tomorrow` page + `TomorrowClient` (mark in-production/fulfilled, contact, gaps).
  Sidebar link. api-client + types.
- Tests: fulfilment state transitions, tomorrow query grouping, digest tomorrow build.

## Verification
- `pnpm --filter @fermeribg/server test` (mocked DB) green.
- `pnpm --filter @fermeribg/server build` + `pnpm --filter @fermeribg/web build`.
- #8 reproduced on real Postgres (before/after numbers).
- #3 reproduced via service spec (revert path) + DTO.
