# API + Query Optimization Audit — Fix Plan & SDD

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. Steps use `- [ ]` checkboxes. Owner runs Opus plan+execute inline (no Sonnet delegation, per userpref).

**Goal:** Fix all P1/P2/P3 findings from the 2026-06-27 6-agent perf audit across server (NestJS+Drizzle+PG+Redis), farm panel (`client`), super admin (`admin`), delivery-web — without changing observable behavior.

**Architecture:** Three workstreams: (A) **DB/schema** — one new drizzle migration `0065` adding indexes + a functional unique index, generated from `schema.ts` edits; (B) **server services** — query batching, single-flight cache guards, cron SQL filters, tenant-read dedup; (C) **frontend** — kill redundant fetches, add a lightweight notifications-count endpoint, fetch-skip guards.

**Tech Stack:** NestJS, Drizzle ORM, PostgreSQL, Redis (`PublicCacheService`), Next.js App Router (3 apps), Jest (`server/`).

**Migration numbering:** next is `0065`. Generated via `pnpm --filter @fermeribg/db generate` after editing `packages/db/src/schema.ts`. Journal auto-updated.

**Verification baseline:** `cd server && pnpm test` (full jest suite) must stay green after every server task. Build gate: `pnpm -w build` (or per-app `pnpm --filter <app> build`).

---

## Design decisions (SDD)

### D1 — Indexes (migration 0065)
Add to `shipments` table (`schema.ts:460` index block):
- `shipments_carrier_status_idx` on `(carrier, status)` — serves both refresh crons' active-status filter + Speedy `listShipments`.
- `shipments_tenant_report_idx` on `(tenantId, reportStatus)` — serves cod-risk `listCandidates`.
- `shipments_tenant_cod_idx` on `(tenantId)` **partial** `WHERE cod_amount_stotinki IS NOT NULL` — serves Econt COD recon. (If drizzle partial-index syntax is awkward, fall back to plain `(tenantId, codSettledAt)`; tenant_idx already partially covers — see Task 2 note.)

Add functional unique index on `users`:
- `users_email_lower_idx` UNIQUE on `lower(email)` — makes the login lookup sargable.

Drizzle supports `sql` in `.on()`: `uniqueIndex('users_email_lower_idx').on(sql\`lower(${users.email})\`)`. If drizzle-kit fails to emit the functional index, hand-append the `CREATE UNIQUE INDEX` to the generated `0065_*.sql` (keep schema.ts annotated so intent is recorded).

**Risk:** `users_email_lower_idx` is UNIQUE — if any two rows differ only by case it will fail to build. Mitigation: pre-check in Task 1 step 1 with a query; if dupes exist, build NON-unique index instead (still fixes sargability) and log a follow-up.

### D2 — Cron refresh (Econt + Speedy)
Two coupled changes per carrier:
1. **SQL filter** the cron select: `carrier = 'econt'` (Econt) + `status NOT IN ('delivered','returned','refused','cancelled')` + `econtShipmentNumber IS NOT NULL` (Econt) / `trackingNumber IS NOT NULL` (Speedy). Drops full-table scan to index range scan over live shipments.
2. **Drop the per-shipment re-SELECT**: cron selects the full row once, calls a new private `refreshStatusForRow(row)`; public `refreshStatus(tenantId, id)` becomes `fetch row → refreshStatusForRow(row)`. Eliminates N `SELECT *` (incl. `trackingJson` jsonb).

Keep the JS terminal-status guard as a belt-and-braces filter (UI status derivation can differ from stored `status`).

### D3 — Single-flight for recommendations
Copy the exact `inflight = new Map<string, Promise<unknown>>()` pattern from `insights.service.ts:303,322-327` into `recommendations.service.ts`. Wrap `rankedBestSellers` and `coOccurMap` recompute branches. Key by the Redis key string.

### D4 — Public article from cached list
`findPublicArticleBySlug` → call `findPublicBySlug(slug)` (Redis-cached) and `.find(a => a.slug === articleSlug)`, mirroring `products.service.ts:636` `findPublicProductBySlug`. Removes 2 PG queries on a public path. Preserve the existing not-found error.

### D5 — syncVariants: batch + transaction
Wrap the variant insert/update/delete + cheapest-price sync in `this.db.transaction`. Batch inserts into one `insert(productVariants).values(rows)`. Keep updates as-is inside the tx (bounded count).

### D6 — Tenant-read dedup
- `import.resolve.ts`: thread the already-loaded tenant settings/creds into per-row resolves so `loadStored(tenantId)` isn't re-hit per row. Lowest-risk impl: add a per-call memo `Map<tenantId, settings>` passed through, or a short TTL inside `loadStored`. Chosen: **request-scoped memo passed from `ImportService` into resolve helpers.**
- Speedy `codReconciliation`: collect `(id, settledAt)` then batch-update (one statement via `CASE`, or `Promise.all` of updates — choose `Promise.all`, bounded by 60-day window).
- Econt `listShipments`: `Promise.all([orderJoinQuery, manualQuery])`.
- billing `summary`: `Promise.all([customers.retrieve, invoices.list])`.

### D7 — Frontend
- **Notifications endpoint:** new `GET /me/notifications/count` (auth-scoped) returning `{ products, windows, pendingReviews, ... }` counts the badge needs, computed server-side cheaply (counts, not full lists). `Topbar` calls it once + caches via a module-level store with 60s stale window; bell-open lazy-loads detail lists only then.
- **Orders eager-load:** replace `useLoadAllList` drain with server-side paginated fetch on demand (API supports `q`/status/cursor). Keep UX (search/filter) by routing through the API. *Scoped as its own task; larger change.*
- **POTW panel:** accept tenant POTW fields + product list as props from the server page; drop in-component `getTenant()`/`listProductOptions()`.
- **delivery-web config dedup:** `CarrierOnboarding` skips fetch when `onSettings`; `SettingsClient` save handlers use the `{configured:true}` response instead of re-GET.
- **Minor P3:** media-manager reuse `addMedia` list; availability-client server-render windows; admin client-search note.

---

## Tasks

### Task 1: Migration 0065 — indexes
**Files:** Modify `packages/db/src/schema.ts:460-464` (shipments index block) + users index block; Generate `packages/db/drizzle/0065_*.sql`.

- [ ] **Step 1: Pre-check email case dupes.**
  Run (psql against dev DB, port 5433):
  `SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;`
  Expected: 0 rows. If rows → make `users_email_lower_idx` NON-unique in step 2 and note follow-up to dedupe.
- [ ] **Step 2: Edit `schema.ts`.** Add to shipments index callback:
  ```ts
  carrierStatusIdx: index('shipments_carrier_status_idx').on(t.carrier, t.status),
  tenantReportIdx: index('shipments_tenant_report_idx').on(t.tenantId, t.reportStatus),
  ```
  Add to `users` index callback (create one if absent), importing `sql`:
  ```ts
  emailLowerIdx: uniqueIndex('users_email_lower_idx').on(sql`lower(${users.email})`),
  ```
- [ ] **Step 3: Generate migration.** Run `pnpm --filter @fermeribg/db generate`. Inspect `0065_*.sql` — confirm 3 `CREATE INDEX` statements. If the functional `lower(email)` index is missing, hand-append:
  `CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_idx" ON "users" (lower("email"));`
- [ ] **Step 4: Verify build.** `pnpm --filter @fermeribg/db build`. Expected: success.
- [ ] **Step 5: Commit.** `perf(db): add shipments(carrier,status)/(tenant,report) + users lower(email) indexes (migr 0065)`

### Task 2: COD recon index (decide)
- [ ] If D1's partial index is desired: add `shipments_tenant_cod_idx` partial in same migration (fold into Task 1). Drizzle partial: `.where(sql\`${t.codAmountStotinki} is not null\`)` on the index builder. If unsupported cleanly, skip — `tenant_idx` + carrier filter is acceptable; record decision in commit body.

### Task 3: Auth login uses sargable lookup
**Files:** `server/src/modules/auth/auth.service.ts:38-43`; Test `server/src/modules/auth/*.spec.ts` (or add).
- [ ] **Step 1:** Confirm a login test exists; if not, add one asserting case-insensitive login still works (mixed-case stored + lowercase input). Run, see it pass on current code.
- [ ] **Step 2:** No query change needed — the `lower(email)` predicate now matches `users_email_lower_idx` from Task 1. Keep code as-is. (The index is the fix.)
- [ ] **Step 3:** `cd server && pnpm test -- auth`. Expected: PASS.
- [ ] **Step 4: Commit** (folded into Task 1 or noted) — no code change.

### Task 4: Econt cron — SQL filter + drop per-row re-SELECT
**Files:** `server/src/modules/econt/econt.service.ts` (~`946-1014`).
- [ ] **Step 1:** Read `refreshStatus(tenantId, id)` + `refreshActiveShipments` fully.
- [ ] **Step 2:** Extract a private `refreshStatusForRow(row)` containing everything `refreshStatus` does after its row fetch.
- [ ] **Step 3:** `refreshStatus(tenantId, id)` = fetch full row (existing select) → `return this.refreshStatusForRow(row)`.
- [ ] **Step 4:** `refreshActiveShipments`: select **full rows** with `where(and(eq(carrier,'econt'), isNotNull(econtShipmentNumber), notInArray(status, ['delivered','returned','refused','cancelled'])))`; loop calls `refreshStatusForRow(r)` (no second query). Keep JS terminal guard.
- [ ] **Step 5:** `cd server && pnpm test -- econt`. Expected: PASS (adjust any test that stubbed the double-select).
- [ ] **Step 6: Commit** `perf(econt): filter status-refresh cron in SQL; drop per-shipment re-SELECT`

### Task 5: Speedy cron — same shape
**Files:** `server/src/modules/speedy/speedy.service.ts` (~`341-428`).
- [ ] **Step 1:** Mirror Task 4: `refreshStatusForRow`, cron selects full rows `where(and(eq(carrier,'speedy'), isNotNull(trackingNumber), notInArray(status, [...terminal])))`.
- [ ] **Step 2:** `codReconciliation`: collect updates, replace serial `await update` loop with `await Promise.all(updates.map(...))`.
- [ ] **Step 3:** `listShipments` for Econt counterpart handled in Task 7. Speedy `listShipments` now index-served by `(carrier,status)` — no code change.
- [ ] **Step 4:** `pnpm test -- speedy`. Expected: PASS.
- [ ] **Step 5: Commit** `perf(speedy): SQL-filter cron, batch COD recon updates`

### Task 6: Recommendations single-flight
**Files:** `server/src/modules/recommendations/recommendations.service.ts`.
- [ ] **Step 1:** Add `private readonly inflight = new Map<string, Promise<unknown>>();`
- [ ] **Step 2:** In `rankedBestSellers` + `coOccurMap`, after cache-miss: check `inflight.get(key)`; if present return it; else build `compute = (async()=>{...recompute+set...})().finally(()=>this.inflight.delete(key))`, set it, return. Mirror `insights.service.ts:322-327`.
- [ ] **Step 3:** `pnpm test -- recommendations`. Expected: PASS.
- [ ] **Step 4: Commit** `perf(recos): single-flight guard on bestsellers + co-occurrence recompute`

### Task 7: Server query micro-fixes (batch commit)
**Files:** `articles.service.ts:197`, `products.service.ts:371` + `:624`, `econt.service.ts:897`, `billing.service.ts:202/217`, `reviews.service.ts:42`.
- [ ] **Step 1 (articles):** `findPublicArticleBySlug` → `const list = await this.findPublicBySlug(slug); const a = list.find(x=>x.slug===articleSlug); if(!a) throw <existing notfound>; return a;`
- [ ] **Step 2 (syncVariants):** wrap insert/update/delete + price-sync in `this.db.transaction(async (tx)=>{...})`; batch inserts into one `tx.insert(productVariants).values(rows)`.
- [ ] **Step 3 (products cold build):** `const [media, variants] = await Promise.all([mediaUrlsByProduct(...), variantsByProduct(...)])`.
- [ ] **Step 4 (econt listShipments):** `const [rows, manual] = await Promise.all([...])`.
- [ ] **Step 5 (billing summary):** `Promise.all([customers.retrieve, invoices.list])`.
- [ ] **Step 6 (reviews create):** resolve tenant via `(await this.publicCache.resolveTenant(this.db, slug)).id`.
- [ ] **Step 7:** `cd server && pnpm test`. Expected: full suite PASS.
- [ ] **Step 8: Commit** `perf(server): cached article read, batched variants tx, parallel independent queries`

### Task 8: Import tenant-read dedup
**Files:** `server/src/modules/import/import.resolve.ts`, `import.service.ts`.
- [ ] **Step 1:** Read `createBatch`/`commit` + `resolve.ts` helpers to map `loadStored` call sites.
- [ ] **Step 2:** Resolve tenant settings/creds **once** in the service; pass into resolve helpers (add param) OR add a per-batch `Map` memo. Avoid changing external-API cache behavior.
- [ ] **Step 3:** `pnpm test -- import`. Expected: PASS.
- [ ] **Step 4: Commit** `perf(import): resolve tenant settings once per batch, not per row`

### Task 9: Notifications count endpoint + Topbar
**Files:** Server: `auth`/`me` controller (find where `/me/*` lives) + service; add `GET /me/notifications/count`. Client: `client/src/lib/api-client.ts`, `client/src/components/layout/topbar.tsx`.
- [ ] **Step 1:** Locate the `/me` controller. Add endpoint returning `{ products:number, windows:number, pendingReviews:number, ... }` via COUNT queries (not full lists), tenant-scoped.
- [ ] **Step 2:** Add `getNotificationCounts()` to `api-client.ts`.
- [ ] **Step 3:** `Topbar`: replace 4-call `loadNotifs` with one count call; module-level store + 60s stale window so navigation doesn't refire; bell-open lazy-loads detail lists.
- [ ] **Step 4:** Server `pnpm test`; client `pnpm --filter <client> build`. Manual smoke: badge shows counts.
- [ ] **Step 5: Commit** `perf(panel): single notifications-count endpoint; stop 4 fetches per navigation`

### Task 10: Orders server-side pagination
**Files:** `client/src/components/orders/orders-client.tsx`, related page + api-client.
- [ ] **Step 1:** Read current `useLoadAllList` usage + `listOrders` signature + existing `getPayments` server-paginated pattern (reuse).
- [ ] **Step 2:** Replace eager drain with on-demand keyset page fetch; wire search/status filter to API params (`q`, status, cursor).
- [ ] **Step 3:** `pnpm --filter <client> build`; smoke search + paginate.
- [ ] **Step 4: Commit** `perf(panel): server-side orders pagination/search; stop eager all-page load`

### Task 11: POTW panel props
**Files:** `client/src/app/(admin)/products/page.tsx`, `client/src/components/products/product-of-week-panel.tsx`, `products-client.tsx`.
- [ ] **Step 1:** Page passes POTW fields (already has tenant) + product list down as props.
- [ ] **Step 2:** Panel drops `getTenant()`/`listProductOptions()`; reads props.
- [ ] **Step 3:** `pnpm --filter <client> build`; smoke POTW edit.
- [ ] **Step 4: Commit** `perf(panel): POTW panel reuses page-loaded tenant + products`

### Task 12: delivery-web config dedup + minor frontend P3s
**Files:** `delivery-web/src/components/carrier-onboarding.tsx`, `settings-client.tsx`; `client/.../media-manager.tsx`, `availability-client.tsx` (+ its page).
- [ ] **Step 1:** `CarrierOnboarding`: `if (onSettings) { setCount(2); return; }` before fetch.
- [ ] **Step 2:** `SettingsClient` save handlers: use `{configured:true}` response, drop follow-up GET.
- [ ] **Step 3 (media):** have `addMedia` return refreshed list; caller reuses unless async/timeout branch.
- [ ] **Step 4 (availability):** server page fetches windows, passes `initialWindows`; client `reload()` only post-edit.
- [ ] **Step 5:** Build affected apps; smoke.
- [ ] **Step 6: Commit** `perf(delivery-web,panel): dedup config fetches; reuse upload list; SSR availability windows`

### Task 13: P3 cleanups (optional, lower priority)
- [ ] Checkout/estimate tenant double-reads — thread loaded tenant (server). Skip if risk > reward.
- [ ] Cron one bounded retry on transient courier 5xx (cron path only, NOT inline checkout).
- [ ] Rate-limiter refund minute-bucket fix (`nekorekten-rate-limiter.ts:179`) — return reserved keys from `reserve()`, DECR those.
- [ ] Admin client-side search note: raise list `limit` or add `?q=` server search once any admin list > 50.
- [ ] Commit per fix.

---

## Self-review
- **Coverage:** every audit finding P1(#1-5) → Tasks 1,3,4,5,9. P2(#6-12) → Tasks 4,5,6,7,8,10,11,12. P3 → Tasks 7,12,13. ✓
- **Type consistency:** `refreshStatusForRow` named identically in Tasks 4 & 5. `getNotificationCounts` Task 9. ✓
- **Migration:** single 0065 holds all indexes; generated not hand-rolled (except functional-index fallback). ✓
- **Risk gates:** unique-index dupe pre-check (Task 1.1); full jest after each server task; per-app build for frontend. ✓

## Execution order
1,3 → 4,5 → 6,7,8 (server, run full suite) → 9,11,12 (frontend quick wins) → 10 (bigger) → 13 (optional). Tasks within a tier are independent.
