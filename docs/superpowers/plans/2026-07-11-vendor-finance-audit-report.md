# Vendor-Finance (dormant marketplace ledger) — Post-Implementation Audit

**Branch:** `feat/vendor-finance-dormant` · **Date:** 2026-07-11
**Scope audited:** the full 12-task dormant vendor-finance feature — commission ledger + monthly subscription charges, per-farmer overrides, owner/producer panel screens, and the three money seams.
**Method:** 5 parallel Opus auditors, one per risk dimension (money-math/dormancy, security/multi-tenancy, migration/schema, seam-integration, panel-gating). Full server suite run as the integration gate.

---

## Verdict

**Ship-ready as a dormant feature.** With commission rate 0 and subscription fee off — the default for every tenant — no money is charged, no cross-tenant leak exists, and no existing user-facing behavior changes. Two real defects in the shipped work were found **and fixed** in this branch. The remaining findings are go-live correctness gaps and P3 hardening, captured as follow-up tasks; none blocks shipping the dormant feature.

**Test gate:** full server suite **1459/1460 green**. The single failure (`orders.reschedule.spec.ts:157`) is a pre-existing date-bomb (hardcoded `toDate: '2026-07-10'` trips the past-day guard now that the date has passed) — unrelated to vendor-finance, flagged as its own task.

---

## Fixed in this branch (commit `043e914`)

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | P1 | **`/my-report` producer screen was unreachable.** Task 10 added the nav item to `FARMER_NAV` but never whitelisted the route in `FarmerRouteGuard` → producers were bounced to `/stats`. The whole screen was dead for its intended user. | Added `/my-report` to `FARMER_ALLOWED` (`farmer-route-guard.tsx:10`). |
| 2 | P2 | **Finance override inputs leaked onto single-farm panels.** The per-farmer commission %/fee inputs rendered unconditionally on the **ungated** `/farmers` screen, so non-marketplace owners saw new fields — breaking the "zero panel change for non-marketplace tenants" dormancy guarantee. The plan's premise (line 18, "Фермери screen only multi-farmer tenants use") was factually wrong. | Gated the inputs on `multiFarmer` (already available in `FarmersClient` as `multi`), threaded into `FarmerPanel`. State still initialises from the farmer row, so existing overrides round-trip with no data loss when hidden. |

---

## Go-live gaps — must close before enabling (flagged: task "Vendor-finance go-live seam gaps")

Dormant today (rate 0 → zero-value); wrong commission once live.

- **[P1] Card refund never voids the accrual.** `stripe.service.ts` `markOrderRefunded` (~770-791) cancels the order via a direct `db.update` that **bypasses** `orders.updateStatus`, so the cancel-branch `voidForOrder` never fires. Paid→accrued→fully-refunded leaves the entry `accrued` → farmer billed on refunded money. Mirror of the cancel seam; add a `voidForOrder` there.
- **[P2] COD accrual goes stale on item edit.** `updateOrder`'s only money-freeze guard is `if (dto.items && current.paidAt)` — COD never sets `paidAt`, so a received (accrued) COD order stays editable; editing items recomputes the total but `accrueForOrder` is `onConflictDoNothing` on `(orderId,farmerId)` → commission frozen on pre-edit gross. Re-accrue on edit, or block item edits once accrued.
- **[P3, by-design] Un-cancel of a card order** leaves the void orphaned (no re-accrue path). Arguably correct — un-cancelling shouldn't silently re-collect.
- **Reconciliation:** seams fire **after** commit (fire-and-forget, try/catch-swallowed) — intended so a ledger failure never rolls back an order write, but a crash in that window silently drops an accrual (under-charge). Consider a pre-go-live reconciliation sweep.

---

## Dormancy — the honest caveat

"Dormant" here means **records zero-commission history**, not **writes nothing**:

- **[P3]** Accrual runs on the collected-money hot path for **all** tenants; any collected, farmer-attributed order writes a `commission_entries` row (gross > 0, rate 0, commission 0). This is by design — the rate snapshot needs the history — and is fire-and-forget/error-swallowing, so no behavior changes. Orders with no farmer-attributed items correctly write nothing.
- **[P2]** `commission.service.ts` `summary()` returns **real** gross/orderCount regardless of `commissionEnabled`, and `GET /commission/summary` is role-gated (admin+farmer) but **not** `multiFarmer`-gated. A non-marketplace admin can hit the API and get own-tenant turnout-by-farmer totals (commission 0). Not a cross-tenant leak — for a single-farm tenant it equals data already on `/stats` — but if strict invisibility is wanted, gate the endpoint/route on `multiFarmer`.

The `/marketplace-finance` **route** is likewise nav-gated but not route-gated; direct URL entry by a single-farm admin degrades gracefully (dormant empty state, `изключена` chip, generate returns the "taxation off" conflict) — no leak, no crash. Server endpoint is the real guard and it is tenant-scoped.

---

## Verified correct (no defect)

**Money-math** — rate snapshot persisted per entry (`onConflictDoNothing` on `(order_id,farmer_id)`, first snapshot wins, later rate changes never retro-alter history); precedence `override ?? default` preserves an explicit `0` override; double-received does not double-accrue; void→accrue leaves exactly one active entry; settled rows stay final; rounding is integer-in/integer-out (`Math.round(gross*rateBps/10000)`), no overflow, no floats reach the DB; subscription generate is idempotent per `(farmer,period)`, rejects bad periods, skips fee ≤ 0.

**Security / multi-tenancy** — global default-deny `TenantRolesGuard`; every vendor-finance query tenant-filtered; producer scope forced by `effectiveFarmerId` (ignores a foreign `?farmerId`, 403 on missing token id); PATCH `/subscriptions/:id` re-checks `tenantId` in the UPDATE WHERE (cross-tenant id → 404) and is admin-only; public farmers payload strips `commissionRateBps`/`subscriptionFeeStotinki`/`tenantId` **before** the cache write; DTOs validated (`whitelist + forbidNonWhitelisted`, period regex, enum, UUID, bounds); all Drizzle-parameterised — no injection surface.

**Migration / schema** — `0085_vendor_finance` is purely additive (2 enums, 2 nullable farmers columns, 2 tables), zero drift vs `schema.ts`, journal correctly sequenced at idx 85; dormancy defaults (NULL overrides); duplicate-preventing unique constraints (`(order_id,farmer_id)`, `(farmer,period)`) and summary-query indexes present; **migrate-before-push runbook** (Task 12) is explicit and correct — critical because deploy does not run migrations and a bare-`.select()` column mismatch would 500 every storefront.

**Seam integration** — module exports `CommissionService`; `@Optional()` no-ops in existing harnesses; three scoped transitions (card paid, COD received/refused, cancel) wired idempotently, exactly-once (Stripe accrue sits after the `if (!flipped.length) return` guard; `setCodOutcomeForFarmer` delegates to `setCodOutcome`), non-blocking, correct `(orderId, tenantId)` args with the order's own tenant.

**Panel / UX** — `multiFarmer` gate defaults false at every hop; producer `/my-report` scoping airtight (`summary.farmers[0]`, backend pins own id); producers cannot edit their own commission (panel is owner-only `/farmers`); bps↔% and stotinki↔€ conversions correct (no /100-vs-/10000 mixup); benign dormant empty states throughout.

---

## P3 hardening batch (flagged: task "Vendor-finance P3 hardening batch")

1. `setStatus` PATCH `:id` — add `ParseUUIDPipe` (non-UUID → 500 instead of 404).
2. `commission.service.ts` revive UPDATE (~126) + farmer-override `inArray` (~99) — add `tenantId` predicate for consistency (not exploitable; `orderId`/ids are already tenant-derived).
3. `vendor-finance.settings.ts` `num()` — cap the tenant-default rate at 10000 bps to match the per-farmer override's `@Max(10000)`.
4. **Policy:** `farmers.service.ts` `findAll` returns finance fields unstripped to a farmer-role caller (own id) — either strip when `role==='farmer'` or update the "owner/admin-only" comment.

## Unrelated pre-existing (out of scope, noted)

- `orders.reschedule.spec.ts` date-bomb (the 1 suite failure) — separate task.
- `/site-analytics` is in `FARMER_NAV` but missing from `FARMER_ALLOWED` — same route-guard bug class as fix #1, pre-existing; one-liner if touched again.
