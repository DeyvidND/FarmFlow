<!-- last-verified: 2026-07-14 | invariants: files=server/src/modules/orders/order-scheduling.ts,packages/db/src/schema.ts -->

# FarmFlow — Architecture

The cross-cutting picture: things no single file shows, and the contracts that span
modules. Per-app detail lives in each app's `CLAUDE.md`. When a claim here disagrees
with the code, the code wins — fix this file.

## System shape

```
                 ┌─────────────┐   ┌─────────────┐   ┌───────────────┐
  browsers  ───► │ client      │   │ admin       │   │ delivery-web  │
                 │ (farmer     │   │ (super-     │   │ (dostavki     │
                 │  panel)     │   │  admin)     │   │  courier)     │
                 └──────┬──────┘   └──────┬──────┘   └───────┬───────┘
                        │  /bff/*         │  /bff/*          │  /bff/*
                        └────────────┬────┴──────────────────┘
                                     ▼
                         ┌───────────────────────┐
                         │ server @fermeribg/api  │  Postgres (Drizzle)
                         │ NestJS, 50 modules     │  Redis (cache/queues)
                         │ main.ts + main.econt.ts│  Cloudflare R2 (images)
                         └───────────────────────┘
  public storefront = chaika (separate Cloudflare Workers repo) ─► same API
```

Every frontend reaches the API through its own **BFF proxy** (`/bff/[...path]`),
never directly — keeps the API origin private and avoids browser-side firewall issues.

## Multi-tenancy

- The platform hosts many farms; each is a **tenant** with a `slug`.
- Almost all data is tenant-scoped. Backend queries filter by tenant; a query that
  can cross tenants is a bug unless it's an explicit super-admin (`admin` app) path.
- **R2 object storage is prefixed `tenants/<slug>/…`.** Deletes are guarded to that
  prefix so a client-settable `imageUrl` can't delete another tenant's files
  (`server/src/modules/storage/`). Keep the prefix guard on the deletion side.
- Public reads are cached in Redis; expect **staleness up to the TTL** after a write
  (e.g. ~300s) before public/storefront responses reflect a change.

## Identity & auth

- Farmers can have **sub-account logins** under one farm.
- **Operator impersonation:** a super-admin can act as a tenant via a 60-minute,
  single-use `actingAdminId` handoff (Operator Command Center). Audited.
- The three Next apps share a `session.ts` + `api-client.ts` pattern per app.

## Order → delivery → payment → route lifecycle

1. **Availability windows** (`modules/availability`) define when a farm sells.
2. **Delivery slots** (`modules/slots`, table `deliverySlots`) are concrete dated
   windows customers pick.
3. **Order** (`modules/orders`) is placed against a slot; stock is pooled/enforced.
4. **Delivery** is fulfilled either by the farm's own courier or a carrier
   (`modules/econt`, `econt-app`, `speedy`); COD is the common payment path.
5. **Payment**: COD marked received, or Stripe. `modules/vendor-finance` +
   `billing` record commission/fees (marketplace: each farmer is the legal seller,
   platform takes a cut).
6. **Route** (`modules/routing`) plans multi-day, multi-courier delivery routes.
7. Reminders: a day-of cron reminds own-delivery customers of their approved window
   (`modules/sms-reminder`, idempotent claim, per-tenant opt-in, EMAIL channel today).

### ⚠️ The `scheduledForDay` / `scheduledForRange` JOIN contract

`server/src/modules/orders/order-scheduling.ts` exposes scheduling helpers that
reference **`deliverySlots.date`**. Therefore:

- **Every SELECT that uses them MUST `leftJoin(deliverySlots)`** — otherwise Postgres
  throws `missing FROM-clause entry for table "delivery_slots"`. This is a hard
  runtime error, not a lint.
- **UPDATE/DELETE can't `leftJoin`** — filter via `id IN (subselect that joins
  deliverySlots)` instead.
- Live consumers: `orders`, `routing`, `digest`, `sms-reminder`, `handover`, `stats`.
  Add a consumer → add the join.

## Data & migrations

- Postgres via **Drizzle**. Schema: `packages/db/src/schema.ts` (single source).
- **Migrations are hand-written** numbered SQL in `packages/db/drizzle/` (latest
  `0104`; `out: './drizzle'`). Do not ship drizzle-kit's raw auto-output — review/edit
  by hand. Applied by the drizzle-orm migrator (`src/migrate.ts`), idempotent, tracked
  in the `__drizzle_migrations` table.
- A **journal index gap silently breaks the migrator** — every `.sql` needs a matching,
  contiguous entry in `drizzle/meta/_journal.json` (sequential `idx`, `tag` = filename
  without `.sql`). See the checklist in [`packages/CLAUDE.md`](packages/CLAUDE.md).
- Drizzle quirks that have bitten us: no `ANY()` in `sql\`\`` → use `inArray()`;
  `CASE … THEN` returns `text` → cast `::int`; correlated subqueries can unqualify
  columns.
- Time: **Europe/Sofia**, DST-aware. Slot/delivery date math must respect the tz.

## Deploy topology

- **Push to `main` auto-deploys** (`.github/workflows/deploy.yml`): build app images
  (`api`, `client`, `admin`, `delivery-web`) + a **migrator image**, push to GHCR,
  SSH to the Hetzner box, **run migrations first**, then `docker compose pull && up`.
- Deploy **ignores `**.md`, `infra/**`, `.codex/**`** — pure docs changes (like this
  file) do **not** trigger a redeploy.
- CI (`ci.yml`) is separate: install → build → lint → migrate test DB → API tests,
  on push and PR to `main`.
- Boxes: app box `89.167.124.37`; DB box private `10.0.0.3` (Postgres); Redis on the
  app box; images in R2. **chaika** deploys independently as Cloudflare Workers.
- Prod DB access (throwaway psql): `ssh -i ~/.ssh/fermeribg root@89.167.124.37`.

## Watch out

- Deploy **backend-first** when a frontend depends on a new API shape.
- After a write, public/storefront responses can lag by the Redis TTL.
- The demo/clone tenants can show different stock than the live tenant — "sold out"
  on a clone is not necessarily a bug.
- `docs/farmflow/` is a **legacy Claude-Design handoff bundle**, not architecture —
  ignore it for understanding the system.
