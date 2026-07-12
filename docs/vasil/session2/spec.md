# Session 2 — „Пари & Фермер" spec

Branch `feat/vasil-money-stats` (off main 80aba44). Migration lane 0097–0099.

## Task #3 — Плащания: safe un-confirm / revert of COD money outcome
**Problem.** On the Плащания screen a COD order shows «Получих парите» (received) and
«Отказана» (refused) buttons only while `codOutcome == null`. Once the operator clicks
either — e.g. accidentally marks money received before the order is actually delivered —
the buttons disappear and there is **no way to revert**. Same dead-end on «Моите поръчки».

**Fix.** Allow reverting a COD outcome back to «Очаквано» (null). Extend the
`cod-outcome` endpoint DTO to accept `outcome: 'pending'` → sets `cod_outcome = NULL`,
clears `cod_outcome_at/reason/source`, **undoes the side effects** (void the dormant
commission accrual; remove the cod-risk strike that a manual refusal added). Farmer-panel
adds a «Върни» (revert) control on any row whose outcome is set. No migration.

## Task #8 — Плащания statistics are broken
**Real failure.** The money tiles («Общо», «Наложен платеж») sum every COD order in a
counted status **including ones the customer REFUSED at the door** (Отказана →
`cod_outcome='refused'`, but the order stays `confirmed/delivered`, never `cancelled`, so it
is still in `PAYMENT_COUNTED_STATUSES`). Refused money never arrives, yet it inflates the
totals — the farmer sees money that was returned counted as due/collected.

**Fix.** Exclude `cod_outcome='refused'` from the COD money **sums** in both the owner
(`paymentTotalsCached`) and producer (`paymentsForFarmer`) aggregates. Counts/badges stay
inclusive (the refused row is still listed with its «Отказана» badge; it just contributes
0 to the money). Reproduced against a real Postgres with the exact aggregate SQL. No migration.

## Task #9 — Turnover history with an explicit, switchable basis
Turnover is currently reported silently against **order-placed day** (`created_at`). Add an
explicit **basis** switch:
- `placed` — order-placed day (`created_at`), today's behaviour, now labelled.
- `delivery` — scheduled delivery day (`slot.date`, fallback BG creation day).
- `delivered` — day it was actually delivered (`delivered_at`, migration 0097).

Delivered a new `orders.delivered_at` (set on transition into `delivered`, cleared on revert
out of it; backfilled). New `GET /stats/turnover` endpoint keeps the existing `/stats`
untouched (no regression), reporting by the chosen basis. Day-string bucketing avoids
tz drift on slot dates.

## Task #10 — Turnover-to-date, platform income, undelivered split
`GET /stats/turnover` also returns:
- `turnoverStotinki` (window) + `turnoverToDateStotinki` (cumulative up to `to`).
- `platformIncomeStotinki` + `platformIncomeToDateStotinki` = turnover × configured
  commission rate (bps, from vendorFinance; farmer override respected). Honest 0 while dormant.
- Split of the window's turnover into **delivered** vs **undelivered** (`undeliveredRevenueStotinki`,
  `undeliveredOrderCount`) and an `includeUndelivered` toggle that excludes not-yet-delivered
  orders (which, on the `placed` basis, spill their turnover into earlier periods).

## Task #14 — Auto-email each farmer TOMORROW's orders + self-mark fulfilment
- **Worker.** New evening (18:00 Europe/Sofia) BullMQ repeatable in the existing `digest`
  queue → per-tenant fan-out → per-farmer email of **tomorrow's** confirmed orders (reuses the
  existing farmer-digest renderer, «за утре» wording). Sends to every farmer with an email
  and orders tomorrow (single-farmer shops too, not just multi-farmer).
- **Fulfilment state.** New `order_fulfillments(order_id, farmer_id, state)` table (migration
  0098), `state ∈ {pending,in_production,fulfilled}`. Farmer self-marks each of tomorrow's
  orders. Endpoints: `GET /orders/tomorrow`, `PATCH /orders/:id/fulfillment`.
- **Whom to call about gaps.** The «Утре» farmer-panel view lists tomorrow's orders with the
  customer contact (phone/email) surfaced, highlighting un-fulfilled ones so the farmer knows
  who to ring about a shortfall.

## Constraints / invariants
- Оборот excludes the delivery fee (line money only) — preserved.
- Migrations sequential 0097, 0098 (0099 spare); no `_journal.json` idx gap.
- No chaika edits; any storefront impact documented in `chaika-changes.md`.
- Commit after each task.
