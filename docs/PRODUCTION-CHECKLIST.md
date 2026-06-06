# Production deployment checklist

Status legend: ☐ todo · ☑ done · ⚠️ gotcha

Deploy target: **one VM running Dokploy**. Flow = GitHub Actions builds the four
app images and pushes them to **GHCR**; Dokploy **pulls** them (nothing compiles
on the VM) and runs them behind **Traefik** (auto TLS). The marketing site stays
on Vercel; the Пазар storefront is its own Dokploy app (separate repo).

Pieces in this repo:
- Dockerfiles per app (`server/ client/ admin/ storefront`), built from repo root.
- `.github/workflows/deploy.yml` — build + push to `ghcr.io/deyvidnd/farmflow-*`, then ping Dokploy redeploy webhooks.
- `.github/workflows/ci.yml` — build/lint/test on push/PR.
- `docker-compose.prod.yml` — Dokploy "Docker Compose" app: pulls the GHCR images, Traefik labels, `dokploy-network`.
- `.env.production.example` — every runtime var + the build-time GitHub variables.

## 1. Hosting & infra (Dokploy)
- ☐ Create the **GitHub Actions variables** (build-time `NEXT_PUBLIC_*`) and **secrets** (Dokploy webhooks) listed at the bottom of `.env.production.example`. Push to `main` → images land in GHCR.
- ☐ Dokploy: provision **managed Postgres** + **managed Redis** (Databases). ⚠️ Redis down = auth/checkout 500 (rate-limiter is Redis-backed).
- ☐ Dokploy: create a **Docker Compose** app from this repo using `docker-compose.prod.yml`; paste env from `.env.production.example`; set `DATABASE_URL`/`REDIS_URL` to the managed instances.
- ☐ GHCR images are **private** by default — give the VM/Dokploy a GHCR pull token (or make the packages public).
- ☐ Create a **redeploy webhook** per app in Dokploy → put the URLs in the GitHub secrets so pushes auto-deploy.
- ☐ Postgres: automated backups + tested restore.

## 2. DNS & TLS
- ☐ `farmsteadflow.com` apex + `www` → marketing site (already on Vercel: `try.` subdomain).
- ☐ App host(s): e.g. `app.farmsteadflow.com` (web), `admin.farmsteadflow.com`, `api.farmsteadflow.com`.
- ☐ **Wildcard `*.farmsteadflow.com`** for per-tenant storefronts. ⚠️ A wildcard TLS cert needs Traefik's **DNS-01 challenge** (a Cloudflare API token) — HTTP-01 cannot issue wildcards. Configure the `letsencrypt` resolver in Dokploy/Traefik with the Cloudflare token.
- ☐ All behind HTTPS; HSTS via the proxy.

## 3. Environment / secrets (prod `.env`)
Validated in `server/src/config/env.validation.ts`. Required/important:
- ☐ `NODE_ENV=production` — also disables Swagger (`/docs` is dev-only now).
- ☐ `DATABASE_URL`, `REDIS_URL` → managed instances.
- ☐ `JWT_SECRET` — long random, unique to prod.
- ☐ `ENCRYPTION_KEY` — ⚠️ without it, Econt credentials can't be saved (courier disabled).
- ☐ `CORS_ORIGIN` — **comma-separated** allowlist of first-party origins (e.g. `https://app...,https://admin...`). Storefronts use the public `/public/*` CORS-open routes.
- ☐ `TRUST_PROXY` — ⚠️ set to the number of proxy hops (e.g. `1` behind Cloudflare/nginx) or client-IP rate-limiting keys on the proxy IP.
- ☐ `R2_*` (account, keys, bucket, public URL) for media.
- ☐ `STOREFRONT_URL`, `PUBLIC_APP_URL`, `API_PUBLIC_URL`, `NEXT_PUBLIC_API_URL` → real URLs.
- ☐ Google Maps: browser + server keys (⚠️ restrict to prod domain/referrer + server IP; mind the `DEMO_MAP_ID` fallback).

## 4. Stripe → LIVE
- ☐ Swap to **live** `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`.
- ☐ Live **Connect** onboarding (`STRIPE_CONNECT_COUNTRY`), live `STRIPE_PLATFORM_FEE_BPS`.
- ☐ Live platform-billing `STRIPE_BILLING_PRICE_ID` (€30/mo price on the platform account).
- ☐ Point the live Stripe webhook at `https://api.../<stripe-webhook-path>`; verify signature works in prod.
- ☐ Test a live card end-to-end (order → pay → payout to connected account).

## 5. Email (Amazon SES) — finish go-live
- ☐ SES **production access** approved (out of sandbox).
- ☐ Create **SMTP credentials** → set `SMTP_HOST=email-smtp.eu-central-1.amazonaws.com`, `SMTP_USER`, `SMTP_PASS`.
- ☐ `EMAIL_TRANSACTIONAL_FROM`, `EMAIL_BULK_FROM` (`@farmsteadflow.com`), `SES_CONFIG_SET_*`.
- ☐ `EMAIL_WEBHOOK_SECRET` + create the SNS HTTPS subscription → `/email/webhook?secret=...`. `EMAIL_SNS_VERIFY=true` (default; signatures verified).
- ☑ DNS: DKIM + SPF (⚠️ merged with Cloudflare Email Routing) + DMARC verified.
- ☐ Live send test (reset email + a digest).

## 6. Database
- ☐ **Run migrations BEFORE first traffic** — the images don't migrate on boot, and the API errors against an empty schema. `drizzle-kit migrate` (the 29 files in `packages/db/drizzle`) needs the repo + DB reach, so run from a machine that has both:
  ```
  DATABASE_URL=<managed-postgres-url> pnpm db:migrate
  ```
  Expose the Dokploy Postgres connection string for this (one command per deploy that changes the schema). Re-run after every deploy with new migrations.
- ⚠️ **Do NOT `pnpm db:seed`** in prod — it's demo data and rotates tenant ids.
- ☐ Confirm Euro switch (migration 0028) + pickup delivery type applied; spot-check prices.
- ☐ Automated backups + a tested restore.

## 7. Security
- ☑ Helmet, CORS allowlist, Redis throttler, SNS signature verification.
- ☑ Swagger gated to non-production.
- ☐ Run `security-review` on the diff before cut-over.
- ☐ Verify no secrets committed; rotate any that ever were.
- ☐ Container images run as non-root (Dockerfiles set `USER node`) ✓ — keep it.

## 8. Integrations to verify
- ☐ **Econt**: live per-tenant creds; ⚠️ sender profile + office-code picker still needed for full shipping labels.
- ☐ **R2**: prod bucket + public URL; image hosts allowlisted in `storefront/next.config.mjs`.

## 9. Observability
- ☐ Error tracking (e.g. Sentry) on API + Next apps.
- ☐ Uptime monitor hitting `GET /health`.
- ☐ Centralised logs; alerting on 5xx + bounce/complaint spikes.

## 10. Legal / GDPR (EU, payments + email)
- ☐ Privacy policy, Terms of Service, cookie consent.
- ☐ Data-subject request path; data-retention policy.

## 11. Pre-cut-over verification
- ☐ CI green (build + lint + test).
- ☐ Manual smoke on staging: signup → create product → place order → pay (live test) → receive email → Econt label.
- ☐ Rollback plan (previous image tag + DB backup).
