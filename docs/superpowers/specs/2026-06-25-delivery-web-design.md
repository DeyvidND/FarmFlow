# delivery-web — Next.js Delivery Panel (Design)

**Date:** 2026-06-25
**Branch:** `feat/delivery-web` (off `main`)
**Status:** Approved (brainstorming) — ready for implementation plan (sub-project 1)

## Goal

Replace the bare Alpine page at `dostavki.fermeribg.com/app` with a real Next.js app, `delivery-web`, that reuses the farmer-panel design system and patterns, so the standalone delivery product looks and behaves like the rest of ФермериБГ. Sub-project 1 delivers the foundation (app + auth + shell + design system + deploy) and the first screen (bulk import + live editor); later screens are separate specs.

## Context

- The delivery API is the standalone Nest app (`server/src/main.econt.ts`, the `econt` compose service, internal `econt:3100`). Endpoints: `/auth/{signup,login,me}`, `/import/*` (batches/rows/commit/template), `/shipping/*` (compare, risk, credentials, shipments, labels…), `/speedy/*`.
- Today `econt` also serves a static Alpine UI at `/app` (JWT in `localStorage`). That UI is the thing being replaced.
- The **admin** app (`admin/`) is the exact template to mirror: Next 14.2.35 + React 18 + Tailwind 3.4 (`ff-` tokens) + lucide + sonner; an httpOnly **session cookie** bridged to the API by a `/bff/[...path]` proxy (cookie→`Authorization: Bearer`, with CSRF + path-traversal guards); `middleware.ts` edge gate; `next.config.mjs` standalone-gated on `NEXT_OUTPUT_STANDALONE=1` + security headers + Sentry; `Dockerfile` standalone runtime. `API_BASE = process.env.API_URL ?? <local>`.
- Deploy: `deploy.yml` builds a matrix of images (`api/web/admin`) → GHCR, `scp`s `infra/hetzner/docker-compose.yml` to the box, `docker compose pull … && up`. Plain compose + Cloudflare token-tunnel; ingress hostnames are added in the CF dashboard.

## Architecture

`delivery-web/` is a new Next app modeled 1:1 on `admin/`, pointed at the econt API:
- **Auth = httpOnly cookie session** `ff_delivery_session` (distinct from `ff_admin_session` / farmer cookie) + a `/bff/[...path]` proxy to `API_URL=http://econt:3100`. This also resolves the prior audit P2 (JWT no longer in `localStorage`). Two route handlers set/clear the cookie: **login** (`POST {econt}/auth/login`) and **signup** (`POST {econt}/auth/signup`, standalone self-registration); logout clears it.
- **Design system = copied, not extracted.** Copy `globals.css` (the `ff-` token block) + `tailwind.config.ts` + `postcss.config.mjs` + the layout fonts from `admin/`. Mirror admin's hand-rolled `ff-`-classed components (no shadcn dependency, no new UI library). Extracting a shared `@fermeribg/ui` package is explicitly deferred.
- **Screens reuse the API contract**, not server code: client components call the BFF (`/bff/import/...`) exactly as `admin/src/lib/api-client.ts` calls `/bff/platform/...`.

### File structure (`delivery-web/`)
| Path | Responsibility |
|---|---|
| `package.json`, `next.config.mjs`, `tsconfig.json`, `postcss.config.mjs`, `tailwind.config.ts`, `Dockerfile`, `.eslintrc`/`next-env.d.ts` | scaffold mirrored from `admin/` (name `@fermeribg/delivery-web`, port **3003**) |
| `src/app/globals.css`, `src/app/layout.tsx`, `src/app/icon.svg` | design tokens + fonts + root layout (copied) |
| `src/lib/session.ts` | `SESSION_COOKIE='ff_delivery_session'`, `API_BASE=process.env.API_URL ?? 'http://localhost:3100'`, `extractApiMessage` |
| `src/lib/utils.ts` | `cn`, `eur`, date helpers (copied from admin) |
| `src/lib/api-client.ts` | typed `apiFetch` → `/bff/...` + import endpoints/types (port of the Alpine `app.js` calls) |
| `src/middleware.ts` | edge cookie gate; protect `/import` (and future), redirect `/login` |
| `src/app/api/session/login/route.ts` · `signup/route.ts` · `logout/route.ts` | set/clear the session cookie via econt `/auth/*` |
| `src/app/bff/[...path]/route.ts` | authenticated proxy to `API_URL` (copied from admin, base swapped) |
| `src/app/(auth)/login/page.tsx` | login **+ signup** (tabs or two forms) |
| `src/app/(panel)/layout.tsx` + `src/components/panel-chrome.tsx` | shell: topbar „ФермериБГ · Доставка" + logout (no multi-item nav yet — one screen) |
| `src/app/(panel)/import/page.tsx` + `src/components/import-client.tsx` | **bulk import + live editor** — React port of the Alpine logic |
| `sentry.*.config.ts`, `instrumentation.ts`, `src/app/global-error.tsx`, `src/app/api/ff-rt/route.ts` | Sentry parity (copied; no-op without DSN) |

### Bulk import screen (the port)
Reproduce the current Alpine flow in React + `ff-` styling:
- settings bar (carrier / currency / default weight / Speedy serviceId / file) → upload.
- editable, status-coloured rows (green/yellow/red) — desktop table + mobile cards (mirror `tenants-client.tsx` responsive split).
- per-row edit (`PATCH /import/batches/:id/rows/:rowId`) + delete; status pills; AI-degraded note.
- „Създай пратки" (commit, activation-gated → surfaces 403) + per-carrier label download via the BFF (blob), reusing the authenticated-fetch pattern.
All calls go through `/bff/import/*`; the file upload posts `multipart/form-data` through the BFF (it already streams the body).

## Deploy

- **New image** `ghcr.io/deyvidnd/farmflow-delivery-web` — add a `deploy.yml` build-matrix entry (dockerfile `delivery-web/Dockerfile`, build-arg `NEXT_PUBLIC_SENTRY_DSN` from a repo var like the others) and add `delivery-web` to the box `pull` list.
- **Compose** `infra/hetzner/docker-compose.yml`: new `delivery-web` service (image, `pull_policy: always`, `depends_on: [econt]`, env `NODE_ENV=production`, `API_URL=http://econt:3100`, `NEXT_OUTPUT_STANDALONE=1`). No published port (tunnel reaches it on the compose network).
- **Tunnel repoint (operator, one edit):** `dostavki.fermeribg.com` → `http://delivery-web:3003` (was `econt:3100`). `econt` stays as the internal API only; its `/app` static page is retired (left in place, just no longer the public entry).
- env.example: note `delivery-web` needs nothing beyond `API_URL` (set in compose) + optional `NEXT_PUBLIC_SENTRY_DSN`.

## Security

- httpOnly, `SameSite=Lax`, `Secure` session cookie (mirror admin) — no token in JS. BFF enforces same-site CSRF check + path-traversal rejection + `cache-control: private, no-store` (copied). Signup/login throttling already enforced server-side on econt. Security headers via `next.config` (copied).

## Testing

- CI: `delivery-web` typechecks + `next build` (add to the lint/build CI matrix or rely on the deploy build). The import pipeline's pure logic is already covered by 35 server tests — no duplication here.
- Manual smoke after deploy: `/login` → signup/login → `/import` upload → editable rows render in panel styling → commit gate (403 pre-activation) → labels.
- No new server tests (server unchanged this sub-project).

## Decomposition (follow-up specs, not this one)

Shipments list · Settings (carrier credentials + activation status) · COD-risk view (uses the new unified `RiskReport[]`) · cheapest-quote compare · single-shipment create. Each its own spec/plan after this foundation ships.

## Out of scope (v1)

The follow-up screens above; a shared `@fermeribg/ui` package; removing the econt `/app` static files; dark mode; i18n beyond the existing Bulgarian copy.
