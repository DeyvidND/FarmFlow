# Spec — Daily delivery digest + customer broadcast emails

**Date:** 2026-06-03 · **Repo:** FarmFlow (`server`, `client`, `packages/types`) · **Status:** approved

## Goals
1. **Daily digest** email to each farm owner (`tenant.email`) at ~07:00 Europe/Sofia: today's confirmed deliveries split into self-delivery (slot times) vs Еконт, counts + route summary. Skip farms with nothing today.
2. **Broadcast**: a new farmer-admin tab to email collected **newsletter subscribers**, with a GDPR unsubscribe link.

Collection already works (`newsletter_subscribers`, `POST /public/:slug/newsletter`, storefront form). **No DB migration needed.**

## Shared infra (server)

### EmailModule / EmailService (nodemailer)
- Deps: `nodemailer`, `@types/nodemailer`, `@nestjs/schedule`.
- `sendMail({ to, subject, html, text? })`.
- Transport selection:
  - `SMTP_HOST` set → real SMTP (`nodemailer.createTransport({host, port, auth})`).
  - else → **dev transport**: write `<MAIL_PREVIEW_DIR>/<ts>-<to>.html` and log a line. Lets us build/verify with no account.
- Env (all **optional**, add to `env.validation`): `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (default `FarmFlow <no-reply@farmflow.bg>`), `MAIL_PREVIEW_DIR` (default `<server>/.mail-preview`). Gitignore the preview dir.
- `ScheduleModule.forRoot()` in `app.module`.

## Feature 1 — Daily digest

- `DigestModule` / `DigestService`:
  - `buildDigest(tenantId, date)`: query today's **confirmed** orders (reuse orders/routing services); split by `deliveryType` (`address` = self-delivery, with slot `from–to`; `econt` = courier, with office); totals (# self, # econt, # customers); short route summary (stops/km if available). Returns a structured object + rendered HTML/text, or `null` if nothing today.
  - `@Cron('0 7 * * *', { timeZone: 'Europe/Sofia' })` `runDailyDigests()`: for each tenant with an `email`, build digest; if non-null, `email.sendMail(tenant.email, …)`. Log per-tenant result; never throw out of the cron (catch per tenant).
- `POST /digest/test` (tenant JWT): build + send today's digest to the current tenant's owner email now; return `{ sent: boolean, reason? }`. For manual testing.

## Feature 2 — Broadcast

- `NewsletterModule` / service (tenant JWT unless noted):
  - `GET /subscribers` → `{ subscribers: [{id, email, createdAt}], activeCount, unsubscribedCount }` (tenant-scoped; active = `unsubscribedAt IS NULL`).
  - `POST /broadcast` `{ subject, body }` → for each active subscriber: render HTML (body, escaped, + footer with a personalized **unsubscribe link**); `sendMail`. Return `{ sent: count }`. Guarded by `class-validator` (subject/body non-empty, length caps). Sends sequentially (small concurrency ok); failures per-recipient logged, don't abort the batch.
  - **Unsubscribe token**: `JwtService.sign({ sub: subscriberId, typ: 'unsub' })` (reuse auth JwtService/secret; long/no expiry). Link: `<PUBLIC_API_BASE or APP_URL>/public/unsubscribe?token=…` (base from env `PUBLIC_APP_URL`/`API_PUBLIC_URL`, default `http://localhost:3000`).
  - **`GET /public/unsubscribe?token=…`** (PUBLIC, no guard): verify token (`typ==='unsub'`); set `unsubscribedAt = now` if not already; return a small Bulgarian HTML page ("Отписахте се успешно."). Invalid token → friendly error page. Idempotent.
- Active-subscriber queries everywhere filter `unsubscribedAt IS NULL`.

## Client (`client`, tenant admin :3005)
- Sidebar `NAV` += `{ href: '/newsletters', label: 'Имейл клиенти', Icon: Mail }` (lucide). `middleware.ts` PROTECTED += `/newsletters` (+ matcher).
- `/newsletters` page: subscriber count + table (email, signup date), and a **compose** card (subject input, body textarea) with a **Изпрати** button → confirm dialog (shows recipient count) → `POST /bff/broadcast` → toast `Изпратени до N клиента`. Reads list via `/bff/subscribers`.

## Types
- Add shared response types if helpful (`packages/types`): `Subscriber`, `BroadcastResult`, `DigestSummary` (optional — can be local).

## Testing (TDD, server)
- EmailService dev transport writes a file / records the message (mock fs).
- `buildDigest`: splits address vs econt correctly; returns null when no confirmed orders.
- `POST /broadcast`: sends to active subscribers only (excludes unsubscribed), count correct, each email contains an unsubscribe link.
- Unsubscribe: valid token sets `unsubscribedAt` + idempotent; invalid token rejected; unsubscribed excluded from next broadcast.
- `GET /subscribers`: tenant-scoped, excludes other tenants.
- Cron wrapper: per-tenant error is caught (one failure doesn't stop others).

## Verification (live, dev transport)
- `POST /digest/test` → open the `.mail-preview` HTML → confirm self-delivery/Еконт split renders.
- `POST /broadcast` → preview files generated, each with unsubscribe link → hit one unsubscribe URL → confirm page + `unsubscribedAt` set + excluded from a second broadcast.

## Out of scope
- Broadcast history/analytics table, scheduling broadcasts, rich-text/templates beyond subject+body, double opt-in, per-customer (order) emails (subscribers only), digest content config UI.

## Risks
- Real deliverability needs valid SMTP + SPF/DKIM (prod concern; dev uses preview transport).
- Cron runs in the API process; if multiple API instances run, guard against double-send later (single instance now).
- Unsubscribe token is unauthenticated by design — it only flips `unsubscribedAt`, low-risk; token is signed so not guessable/enumerable.
