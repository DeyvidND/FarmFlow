<!-- last-verified: 2026-07-14 | invariants: apps=server,client,admin,delivery-web; server.modules=50; files=server/src/main.ts,packages/db/src/schema.ts,ARCHITECTURE.md -->

# FarmFlow / ФермериБГ

Multi-tenant farm-commerce SaaS: many farms (tenants) each get a storefront + an
operations panel; the platform handles catalog, orders, availability/slots, delivery
(own courier or carriers), COD/Stripe payments, routing, and marketplace finance.

**Start here, then open the relevant app's `CLAUDE.md`.** For anything cross-cutting
(tenancy, order→delivery→payment→route, migrations, deploy) read
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Monorepo map

pnpm@9.12 + turbo. Node ≥20. Workspace: `server`, `client`, `admin`, `delivery-web`,
`packages/*`.

| Dir | Package | Stack | Role | Docs |
|-----|---------|-------|------|------|
| `server` | `@fermeribg/api` | NestJS | Backend API (50 modules) | [server/CLAUDE.md](server/CLAUDE.md) |
| `client` | `@fermeribg/web` | Next.js | **Farmer/operator panel** (main) | [client/CLAUDE.md](client/CLAUDE.md) |
| `admin` | `@fermeribg/admin` | Next.js | Super-admin console | [admin/CLAUDE.md](admin/CLAUDE.md) |
| `delivery-web` | `@fermeribg/delivery-web` | Next.js | Dostavki courier app | [delivery-web/CLAUDE.md](delivery-web/CLAUDE.md) |
| `packages/*` | `@fermeribg/db,types,help-content,help-ui` | TS | Shared libs (DB, types, help) | [packages/CLAUDE.md](packages/CLAUDE.md) |

Not apps: `storefront/` is a **build husk** (no source). The real public storefront is
**chaika**, a separate Cloudflare Workers repo. `docs/farmflow/` is a **legacy design
handoff bundle**, not architecture — ignore for understanding the system.

## Commands

```bash
pnpm install                       # frozen-lockfile in CI
pnpm dev                           # turbo: all apps in dev
pnpm build            # pnpm lint  # turbo across the workspace
pnpm --filter @fermeribg/api test  # backend tests (client also has test + e2e)
pnpm db:generate | db:migrate | db:seed   # → @fermeribg/db
```
Dev DB is Postgres on port **5433** (root `docker-compose.yml`). Per-app run commands
live in each app's doc.

## Top gotchas (one-liners — details behind the links)

1. **Migrations are hand-written**; a drizzle journal index-gap silently breaks the
   migrator. → [packages/CLAUDE.md](packages/CLAUDE.md)
2. **Push to `main` auto-deploys** (Hetzner); migrator runs before app images.
   Docs (`**.md`) don't trigger deploys. → [ARCHITECTURE.md](ARCHITECTURE.md)
3. **`scheduledForDay/Range` require `leftJoin(deliverySlots)`** on every query, or
   Postgres throws. → [ARCHITECTURE.md](ARCHITECTURE.md)
4. **R2 deletes are tenant-prefixed** (`tenants/<slug>/`) to stop cross-tenant deletes.
5. **Public reads are Redis-cached** — expect staleness up to the TTL after a write.
6. **Europe/Sofia + DST** for all slot/delivery date math.
7. **Frontends call the API via their `/bff` proxy**, never the API origin directly.
8. **Drizzle:** no `ANY()` (use `inArray`); `CASE…THEN` needs `::int`.
9. **Optional string DTOs:** `@IsOptional()` doesn't coerce `''`→`undefined`; add
   `@Transform`.
10. **Re-seeding rotates tenant ids**; deploy **backend-first** when the frontend
    needs a new API shape.

## Docs freshness

These docs carry a `last-verified` header with machine-checkable invariants. Run
`pnpm docs:check` to detect drift (also runs warn-only in CI). If it flags a file,
re-verify the claims against the code and bump the stamp. **Code always wins over docs.**
