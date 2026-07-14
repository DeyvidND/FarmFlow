<!-- last-verified: 2026-07-14 | invariants: files=packages/db/src/schema.ts,packages/db/src/migrate.ts,packages/types/src/index.ts -->

# packages — shared workspace libraries

Four internal packages consumed by the apps. All build with `tsc`.

| Package | Name | What it owns |
|---------|------|--------------|
| `db` | `@fermeribg/db` | Drizzle schema, migrations, seed, DB bootstrap |
| `types` | `@fermeribg/types` | Shared TypeScript types across apps |
| `help-content` | `@fermeribg/help-content` | Help copy: categories, FAQs, search index |
| `help-ui` | `@fermeribg/help-ui` | React help components (search bar, accordion, tabs) |

## `@fermeribg/db` — the important one

```bash
pnpm db:generate   # drizzle-kit generate (review output — see below)
pnpm db:migrate    # apply migrations
pnpm db:seed       # seed dev data
```

- `src/schema.ts` — the single source of truth for the DB schema.
- `src/migrate.ts` — the migrator (also shipped as an image via
  `Dockerfile.migrate`; the deploy runs it **before** app images come up).
- `migrations/*.sql` — numbered, **hand-written** SQL (latest: `0104_sms_reminder.sql`)
  + `migrations/meta/` journal.
- `seed.ts`, `bootstrap.ts`, `ensure-extension.sql`, `backfill-purchases.ts`.

### Migration landmines (read before adding one)

- **Hand-write migrations.** Do not trust drizzle-kit auto-generation to be the final
  artifact — review and edit the SQL by hand.
- A **gap in the drizzle journal index silently breaks the migrator** — new migrations
  must be contiguous and the `meta/` journal consistent, or migrate no-ops/fails quietly.
- Re-seeding **rotates tenant ids** — anything caching a tenant id across a reseed goes
  stale.

## Notes

- `help-content` has specs (`content.spec.ts`, `search.spec.ts`) — run its `test`.
- Cross-app types belong in `@fermeribg/types`, not copied into each app.
- Schema/data flow context → [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
