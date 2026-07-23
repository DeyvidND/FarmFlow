<!-- last-verified: 2026-07-23 | invariants: files=server/src/main.ts,server/src/app.module.ts; server.modules=52 -->

# server — `@fermeribg/api` (NestJS)

The backend API for FarmFlow / ФермериБГ. Everything the panels and storefronts
talk to. Multi-tenant; Postgres (Drizzle) + Redis + Cloudflare R2.

## Run

```bash
pnpm --filter @fermeribg/api dev     # watch mode (nest start --watch)
pnpm --filter @fermeribg/api test    # jest
pnpm --filter @fermeribg/api build
```
Dev DB runs on port **5433** (see repo root `docker-compose.yml`).

## Entry points

- `src/main.ts` — the HTTP API process (the normal one).
- `src/main.econt.ts` — a **separate** process for the Econt delivery worker
  (`pnpm start:econt`). Don't assume one process; background/queue work can run here.
- `src/app.module.ts` — wires every feature module below.

## Layout

- `src/modules/*` — one folder per domain (52 `*.module.ts` total under `src/`). Each is a
  standard Nest module (`*.module.ts` / `*.controller.ts` / `*.service.ts` / `dto/`).
- `src/common/` — cross-cutting guards, interceptors, decorators, pipes.
- `src/config/` — config/env wiring.
- `src/types/` — server-local types (shared types live in `@fermeribg/types`).

### Module map (the ones you'll touch most)

| Area | Modules |
|------|---------|
| Commerce | `orders`, `products`, `catalog-cache`, `subcategories`, `availability`, `slots`, `reviews`, `recommendations` |
| Delivery/logistics | `routing`, `handover`, `econt`, `econt-app`, `speedy`, `cod-risk` |
| Tenancy/identity | `tenants`, `farmers`, `auth`, `platform` |
| Money | `billing`, `stripe`, `vendor-finance` |
| Comms | `order-email`, `order-protocol-email`, `newsletter`, `digest`, `sms-reminder`, `help` |
| Ops/AI | `ai-import`, `import`, `intake`, `image-queue`, `storage`, `analytics`, `stats`, `dashboard`, `demo-request`, `articles`, `public-bootstrap` |

## Conventions

- **Multi-tenant:** almost every query is scoped by tenant. Never write a query that
  can read/write across tenants. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
- **DTO validation:** class-validator. Note the recurring gotcha — `@IsOptional()`
  does **not** turn `''` into `undefined`; use `@Transform(({value}) => value === '' ? undefined : value)`
  for optional string fields, or empty-string bodies get through.
- **DB migrations are hand-written** — never trust drizzle-kit to auto-generate here.
  See ARCHITECTURE → Migrations.

## Adding a module — checklist

1. Create `src/modules/<name>/` with `<name>.module.ts` (+ `.controller.ts`,
   `.service.ts`, `dto/` as needed), following an existing sibling's shape.
2. **Register it in `src/app.module.ts`** `imports: [...]` — it won't load otherwise.
3. Tenant-scope every query (guards/decorators exist in `src/common/`); never read or
   write across tenants unless it's an explicit platform/super-admin path.
4. Optional string DTO fields: add the `@Transform('' → undefined)` (see Conventions).
5. Schema change? Hand-write the migration in `@fermeribg/db` — see
   [`../packages/CLAUDE.md`](../packages/CLAUDE.md) → *Adding a migration*.

## Landmines (verify before trusting)

- **`scheduledForDay` / `scheduledForRange`** (`src/modules/orders/order-scheduling.ts`)
  reference `deliverySlots.date`. **Every query using them MUST
  `leftJoin(deliverySlots)`**, or Postgres throws "missing FROM-clause entry".
  For UPDATEs that can't join, filter via `id IN (subselect that joins)`.
  Consumers: `orders`, `routing`, `digest`, `sms-reminder`, `handover`, `stats`.
- **R2 deletes are tenant-prefixed** (`src/modules/storage/`): object keys are guarded
  to `tenants/<slug>/…` so a client-settable `imageUrl` can't delete another tenant's
  files. Don't remove that prefix guard.
- **Europe/Sofia DST** — date math around slots/deliveries must respect the tz.
