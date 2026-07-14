# Design — AI-legibility docs layer

**Date:** 2026-07-14
**Status:** approved (design), pending spec review
**Author:** Claude (Opus 4.8) + operator

## Goal

Make the FarmFlow monorepo legible to AI agents (and humans) so assistance is faster
and more accurate — **without changing any application behavior**. This is a
documentation-layer project, not a code refactor. Zero runtime/merge risk.

Chosen scope (operator): full set — root map + per-app docs + a cross-cutting
`ARCHITECTURE.md` + an anti-drift check (warn-only CI).

## Non-goals

- No source-code refactoring, renames, or module splits.
- No behavior, API, schema, or config changes.
- Not documenting the separate `chaika` storefront repo (lives elsewhere).
- Not replacing `docs/farmflow/` (legacy design-handoff bundle — left as-is, but
  disambiguated in the root doc so agents don't mistake it for architecture).

## Verified facts (basis for the docs)

Monorepo: `pnpm@9.12.0` + `turbo@2.1`. Root package `fermeribg`. Node >=20.
Workspace members (`pnpm-workspace.yaml`): `server`, `client`, `admin`,
`delivery-web`, `packages/*`.

| Dir | pkg name | Stack | Role (to verify in impl) |
|-----|----------|-------|--------------------------|
| `server` | `@fermeribg/api` | NestJS | API; 50 `*.module.ts` under `src/modules` |
| `client` | `@fermeribg/web` | Next.js | main web / farmer panel |
| `admin` | `@fermeribg/admin` | Next.js | super-admin console |
| `delivery-web` | `@fermeribg/delivery-web` | Next.js | dostavki courier app |
| `packages/db` | `@fermeribg/db` | Drizzle | schema, migrations, seed |
| `packages/types` | `@fermeribg/types` | TS | shared types |
| `packages/help-content` | `@fermeribg/help-content` | — | help copy |
| `packages/help-ui` | `@fermeribg/help-ui` | — | help components |
| `storefront` | (none) | — | **build husk, no source → no doc** |

Root scripts: `build`/`dev`/`lint` (turbo), `db:generate`/`db:migrate`/`db:seed`
(→ `@fermeribg/db`). Server also has `test`; client has `e2e`+`test`.

CI: `.github/workflows/ci.yml` (build-test job: install → build → lint → migrate →
API test) and `deploy.yml` (auto-deploy on push→main).

`docs/farmflow/` = legacy Claude-Design handoff bundle, NOT architecture docs.

## Deliverables (files)

```
CLAUDE.md                    (root index/map)
ARCHITECTURE.md              (cross-cutting flows)
server/CLAUDE.md
client/CLAUDE.md
admin/CLAUDE.md
delivery-web/CLAUDE.md
packages/CLAUDE.md           (covers db / types / help-content / help-ui)
scripts/check-docs-fresh.mjs (anti-drift checker)
```
Plus: `docs:check` script in root `package.json`, and a warn-only
`docs-freshness` job in `.github/workflows/ci.yml`.

### Root `CLAUDE.md`
Short, scannable. Sections:
1. One-paragraph what-is-FarmFlow (multi-tenant farm commerce SaaS, ФермериБГ).
2. Monorepo app map table (dir → pkg → stack → role → entry file), verified.
3. Commands: install / dev / test / build / migrate / seed (real scripts).
4. Tenant model one-liner → link to `ARCHITECTURE.md`.
5. Top ~10 gotchas, one line each + links (seeded from memory, **re-confirmed**):
   hand-written migrations & journal-gap breakage; deploy auto-migrates on push→main;
   `scheduledForDay/Range` requires `leftJoin(deliverySlots)`; Europe/Sofia DST;
   chaika is a separate CF Workers repo; DB box split (PG on 10.0.0.3); Redis TTL
   staleness on public reads; Drizzle quirks (no `ANY()`→`inArray`, `CASE`→`::int`).
6. Disambiguation note: `docs/farmflow/` is legacy design bundle, ignore for arch.
7. Pointer to per-app docs. Last-verified stamp.

### `ARCHITECTURE.md`
The high-value cross-cutting file. Sections:
- Multi-tenant model: tenant slug, `tenants/<slug>/` R2 prefixing, isolation rules.
- Auth: farmer sub-account logins; operator impersonation / `actingAdminId`
  (60m single-use).
- Order lifecycle: availability windows → delivery slots → order → delivery →
  COD payment → route. Where each lives (module/file refs).
- The `scheduledForDay/Range` JOIN contract (helpers ref `deliverySlots.date`;
  every query must `leftJoin(deliverySlots)`; UPDATE → `id IN (subselect that joins)`).
- Migrations: hand-written only; drizzle journal index-gaps silently break the
  migrator; `deploy.yml` auto-applies on push→main.
- Deploy topology: Hetzner app box `89.167.124.37` auto-deploys on push→main;
  chaika = separate CF Workers repo; DB box (`10.0.0.3` priv); Redis on app box; R2.

All claims verified against code during implementation; unverifiable memory claims
are dropped, not guessed.

### Per-app `CLAUDE.md` (server, client, admin, delivery-web, packages)
Each self-contained, ~1 screen:
- Purpose (verified), entry file, dev/build/test commands.
- Key modules/dirs and what they own.
- App-specific conventions (verified from existing code, not invented).
- App-specific gotchas.
- Last-verified stamp.

## Anti-drift mechanism

Every generated doc carries a machine-checkable header comment:
```
<!-- last-verified: 2026-07-14 | invariants: apps=server,client,admin,delivery-web; server.modules=50 -->
```

`scripts/check-docs-fresh.mjs` (Node, no deps):
1. Reads the invariant header from each doc.
2. Recomputes live values: workspace app dirs exist; `server/src/**/*.module.ts`
   count; each per-app entry file exists.
3. On mismatch: prints a human-readable "docs may be stale — re-verify X" report.
4. Exit code: **0 always in CI (warn-only)**; a `--strict` flag exits non-zero for
   local/opt-in use.

Wiring:
- Root `package.json`: `"docs:check": "node scripts/check-docs-fresh.mjs"`.
- `ci.yml`: new job `docs-freshness` with `continue-on-error: true` running
  `pnpm docs:check` — surfaces drift in the CI log/annotations, never blocks a
  push→main deploy.

## Testing / verification

- Author-time: every factual claim cross-checked against the real files as written.
- `check-docs-fresh.mjs` self-test: temporarily bump/break one invariant → run
  `--strict` → confirm non-zero + correct message; restore → confirm clean.
- Sanity: fresh-eyes read of root + ARCHITECTURE for contradictions.

## Risks / mitigations

- **Drift** (docs lie → confidently wrong): mitigated by last-verified stamps +
  `docs:check`.
- **Over-documentation** (bloat nobody updates): keep per-app docs to ~1 screen;
  ARCHITECTURE is the only long file.
- **Duplicating memory/CLAUDE global**: repo docs are for anyone/any session;
  operator's private memory stays separate, not copied verbatim.

## Rollout

Single branch, one commit set. Pure additions (+ one CI job + one root script line).
No migration, no deploy coupling. Mergeable to `main` independently of app work.
