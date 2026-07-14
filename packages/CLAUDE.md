<!-- last-verified: 2026-07-14 | invariants: files=packages/db/src/schema.ts,packages/db/src/migrate.ts,packages/db/drizzle/meta/_journal.json,packages/types/src/index.ts -->

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
- `drizzle/*.sql` — numbered, **hand-written** SQL (latest: `0104_sms_reminder.sql`;
  the folder is `drizzle/`, not `migrations/` — `out: './drizzle'` in
  `drizzle.config.ts`) + `drizzle/meta/_journal.json` (the journal).
- `src/migrate.ts` runs the drizzle-orm migrator over `drizzle/`; idempotent, applied
  state tracked in the `__drizzle_migrations` table.
- `seed.ts`, `bootstrap.ts`, `ensure-extension.sql`, `backfill-purchases.ts`.

### Adding a migration — checklist

1. Edit `src/schema.ts` to reflect the desired shape.
2. Add `drizzle/NNNN_<name>.sql` (next number after `0104`), **hand-written**. Don't
   ship drizzle-kit's raw auto-output — review/edit by hand.
3. Add the matching entry to `drizzle/meta/_journal.json`: next sequential `idx`
   (the current tail is `idx:102` → `0104`), `version:"7"`, a `when` epoch-ms, and
   `tag` = the filename **without** `.sql`. **No gaps** — a missing/duplicate `idx`
   silently breaks the migrator (migrate no-ops or fails quietly).
4. `pnpm db:migrate` locally to apply; the migration re-runs in CI and, on push→main,
   in the deploy's migrator step (before app images come up).

### Other landmines

- Re-seeding **rotates tenant ids** — anything caching a tenant id across a reseed goes
  stale.
- Drizzle-in-`sql\`\``: no `ANY()` (use `inArray()`); `CASE…THEN` returns `text` (cast
  `::int`); correlated subqueries can unqualify columns.

## Notes

- `help-content` has specs (`content.spec.ts`, `search.spec.ts`) — run its `test`.
- Cross-app types belong in `@fermeribg/types`, not copied into each app.
- Schema/data flow context → [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
