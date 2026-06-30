# Admin: Audit drill-down + Demo/Real tabs + Demo-excluded Insights

Date: 2026-06-30
Status: Approved

## Goal

Four admin (super-admin „Администрация") changes:

1. **Одит** (audit) — drill-down by ферма and by производител.
2. **Фермери** (tenants) — реални/демо tab switcher (replace stacked sections).
3. **Производители** (producers) — add реални/демо tab switcher.
4. **Анализ** (insights) — exclude demo tenants from aggregates.

Demo/real split lives on the standalone Фермери + Производители pages. Одит only
gets farm + producer drill-down (no demo/real split inside it).

## Current state (from exploration)

| Page | Route | Client | API | Service |
|---|---|---|---|---|
| Одит | `(panel)/audit` | `audit-client.tsx` | `GET /platform/audit` | `listAuditLogs()` |
| Фермери | `(panel)/tenants` | `tenants-client.tsx` | `GET /platform/tenants` | `listTenants()` |
| Производители | `(panel)/producers` | `producers-client.tsx` | `GET /platform/farmers` | `listAllFarmers()` |
| Анализ | `(panel)/insights` | `insights-client.tsx` | `GET /platform/insights` | `insights.service.ts` |

- `tenants.is_demo` boolean + `demo_expires_at`. `GlobalFarmer.isDemo` inherited from parent tenant.
- Audit rows carry `tenant_id` + `tenant_name`; **no farmer id**.
- `tenants-client.tsx` already splits `!isDemo` / `isDemo` into two stacked sections (lines ~546-547).
- `producers-client.tsx` is a flat list with a per-row ДЕМО badge, no split.
- `insights.service.ts` `computeInsights()` tenants query has no `is_demo` filter → demos pollute adoption %, signals, dropdown.

## Design

### 1. Одит — drill-down

Segmented control: **„Всички" | „По ферма" | „По производител"**.
- **Всички**: current flat keyset log, default, unchanged.
- **По ферма**: farm dropdown → `GET /platform/audit?tenantId=<id>`.
- **По производител**: producer dropdown → `GET /platform/audit?farmerId=<id>`.

Backend:
- **Migration `0072`** — `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS farmer_id uuid;`
  plus `CREATE INDEX IF NOT EXISTS ... ON audit_logs (farmer_id, created_at DESC);`
  Idempotent (hand-written, per migration lesson — no drizzle generate).
- **`audit.interceptor.ts`** — stamp `farmer_id` from `req.user?.farmerId` (set only when
  the actor is a farmer-role user). Old rows stay null; producer drill-down is
  populated going forward. Fire-and-forget unchanged.
- **`listAuditLogs()` + controller** — accept optional `tenantId` / `farmerId` query
  filters, ANDed into the existing keyset WHERE. Keyset cursor preserved.
- Frontend `audit-client.tsx` — segmented control + the two dropdowns (farms from
  `/platform/tenants`, producers from `/platform/farmers`, or a lightweight list).

### 2. Фермери — tabs

`tenants-client.tsx`: keep the existing `real` / `demo` filtered arrays, render under a
tab switcher **„Реални (n)" | „Демо (n)"** instead of two stacked sections. Demo badge,
delete-confirmation rules, sort all unchanged. No backend change.

### 3. Производители — tabs

`producers-client.tsx`: derive `realProducers = rows.filter(r => !r.isDemo)` /
`demoProducers = rows.filter(r => r.isDemo)`, render under **„Реални (n)" | „Демо (n)"**
tabs. Search applies within the active tab. Per-row ДЕМО badge stays. No backend change.

### 4. Анализ — exclude demo

`insights.service.ts`:
- `computeInsights()` tenants query → `.where(eq(tenants.isDemo, false))`.
- `timeseries()` → when no `tenantId`, restrict orders to non-demo tenants
  (`tenant_id in (select id from tenants where is_demo = false)`).
- Bust/῾skip cache: existing `platform:insights` (90s TTL) self-heals; no manual bust
  needed but acceptable to flush on deploy.

Frontend `insights-client.tsx` unchanged — fewer farms in dropdown is automatic.

## Out of scope

- No demo/real split inside Одит.
- No backfill of `farmer_id` on historic audit rows.
- No change to producer/tenant data model beyond the audit column.

## Testing

- Backend unit tests: `listAuditLogs` honours `tenantId`/`farmerId`; insights exclude demo.
- Migration idempotency: re-run safe (IF NOT EXISTS).
- Manual: panel tabs switch, audit dropdowns filter, Анализ no longer counts demo.
