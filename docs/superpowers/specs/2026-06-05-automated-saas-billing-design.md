# Automated SaaS Subscription Billing — Design

**Date:** 2026-06-05
**Branch:** `feat/media-galleries` (continues the existing uncommitted-then-committed line)
**Status:** approved — proceed to implementation plan

## Goal

Replace the manual "flip `subscriptionStatus` active/inactive by hand" model with **automated Stripe
billing**: the platform charges each farm **€30.00 / month** plus **€2.00 per newsletter broadcast**,
auto-collected from a card on file. A super-admin **`premium`** flag makes a farm's subscription
**free** (no charge, always active). The platform takes **0 %** of customer orders (already the case),
and the per-broadcast email charge already exists in the `email_pushes` ledger at €2.00.

This is **platform-side** billing — the platform is the merchant, the farmer is the customer. It is
**separate** from Stripe Connect (which handles customer→farm *order* payments on the farm's own
connected account).

## Decisions (locked with the user)

| Topic | Decision |
|---|---|
| Engine | **Stripe subscription** (€30/mo recurring price) + **€2 invoice items** per broadcast that roll into the next invoice. Stripe stores the card, auto-charges, runs dunning/retries. |
| Email unit | **€2 per broadcast/campaign** (one `email_pushes` row = one push), *not* per recipient. Matches existing infra. |
| Pricing | **Flat €30 / €2. No fee passthrough / gross-up.** Platform absorbs the ~€0.70/charge Stripe fee (~€7/mo at 10 farms). |
| Payment failure | **Notify + visible grace timer (default 7 days) → then auto-suspend.** First failed payment starts the countdown; Stripe keeps retrying; if still unpaid at grace end, a daily cron sets the farm `inactive` (features gate off). |
| New farm | **Card required, no trial.** Farmer adds a card via Stripe Checkout (subscription mode) to activate. |
| Premium | Super-admin boolean per farm → **no Stripe customer/subscription, no charges, status forced active.** |
| Stripe Tax | **Off** (avoids extra ~0.5 %/charge). VAT/НАП handling stays in the owner's accounting — automating collection adds no tax obligation. |
| Currency | **EUR** (matches the rest of the system). |

## Reuses existing infrastructure

- `email_pushes` table — already one row per broadcast with `price_stotinki` (default 200 = €2).
- `tenants.subscription_status` enum + `subscription_since` column + the gating
  (`ActiveSubscriptionGuard`, dashboard `subscriptionActive`).
- `@nestjs/schedule` (digest cron pattern) for the grace-expiry sweep.
- `stripe_events` table for webhook idempotency.
- The same `STRIPE_SECRET_KEY` / Stripe client — platform billing calls simply **omit** the
  `stripeAccount` option (Connect calls keep it).
- Farmer `/payments` page and the super-admin tenants panel.

---

## 1. Data model — migration 0027 (additive)

`tenants` add:
- `premium boolean NOT NULL DEFAULT false` — free plan, no Stripe sub.
- `stripe_customer_id text` — platform-side Stripe Customer (distinct from `stripe_account_id`, the
  Connect account).
- `stripe_subscription_id text` — the active €30/mo subscription.
- `grace_until timestamptz` — set when a payment first fails; the suspend deadline.

`subscription_status` enum — widen from `active | inactive` to **`active | past_due | inactive`**.
- `active` — paid / premium → full access.
- `past_due` — payment failed, inside grace window → **still full access** (visible warning + countdown).
- `inactive` — suspended (grace expired or cancelled) → features gated off.

`email_pushes` add:
- `stripe_invoice_item_id text` — the Stripe invoice item created for this push (double-bill guard;
  null = not billed, e.g. premium or a billing error).

**Gating change:** `ActiveSubscriptionGuard` and `dashboard.subscriptionActive` already key off
`status === 'inactive'` → `past_due` is automatically treated as allowed. No gating-logic change
needed beyond widening the enum.

---

## 2. Backend — new `BillingModule` (platform account)

`server/src/modules/billing/`. The service uses the existing Stripe client **without** the
`stripeAccount` option (so all calls hit the platform account).

### `BillingService`
- `getOrCreateCustomer(tenantId)` → find/create a Stripe Customer (email+name from tenant), persist
  `stripe_customer_id`. Premium farms never reach here.
- `startCheckout(tenantId)` → Stripe **Checkout in `subscription` mode** with the €30/mo price
  (`STRIPE_BILLING_PRICE_ID`). One hosted flow collects the card + creates the customer + subscription.
  Returns `{ url }`. Refuses if `premium` (nothing to pay).
- `billingPortal(tenantId)` → Stripe **Billing Portal** session (update card, view/download invoices,
  cancel). Returns `{ url }`.
- `recordEmailPush(tenantId, push)` → `invoiceItems.create({ customer, amount: 200, currency:'eur',
  description })` → Stripe folds it into the next subscription invoice. Persist the id on the push.
  **Premium or no active subscription → skip** (record the push with `price_stotinki = 0` for premium
  so the ledger shows free).
- `summary(tenantId)` → billing snapshot for the farmer page: `plan` (standard|premium), `status`,
  `graceUntil`, card `last4`/brand, next-charge estimate (€30 + €2 × pushes this cycle), recent
  invoices (amount, status, date, hosted URL). **Never throws** (mirror `connectSummary`'s safe-default
  pattern) so the page renders every state from one call.
- `setPremium(tenantId, premium)` (super-admin) → toggle flag; when turning premium **on**, cancel any
  active Stripe subscription and force `subscription_status = active`, clear `grace_until`.

### Webhooks (extend the existing `handleWebhook` + `stripe_events` idempotency)
One endpoint receives both Connect and platform events. New cases:
- `checkout.session.completed` (mode = subscription) → store `stripe_subscription_id`, status `active`.
- `invoice.paid` → status `active`, clear `grace_until`.
- `invoice.payment_failed` → **first failure starts grace**: status `past_due`,
  `grace_until = now + BILLING_GRACE_DAYS`, send the farmer a "payment failed" email (idempotent — don't
  reset an already-set `grace_until`). Stripe keeps retrying on its dunning schedule.
- `customer.subscription.deleted` (or status `canceled`/`unpaid`) → status `inactive`.

The existing `checkout.session.completed`/`payment_intent.succeeded` order-payment handling must stay —
disambiguate by `session.mode` / presence of `metadata.orderId` vs subscription.

### Grace-expiry cron
`@Cron` daily (Europe/Sofia): farms where `status = 'past_due'` and `grace_until < now` → set
`inactive` (suspend). Logs each suspension.

### Premium short-circuit
Premium farms: no customer, no subscription, `recordEmailPush` skips, `subscription_status` stays
`active`, billing summary returns `plan: 'premium'`.

### Controller `BillingController` (`/billing`, `JwtAuthGuard`, tenant-scoped)
- `GET /billing/summary`
- `POST /billing/checkout` → `{ url }` (`@Throttle` 30/min, like account-session)
- `POST /billing/portal` → `{ url }`

Webhook stays on the existing `POST /stripe/webhook`.

---

## 3. Backend — wiring into existing modules

- **Newsletter** `broadcast()` → after a successful send, call `BillingService.recordEmailPush` (it
  already inserts the `email_pushes` row; move/keep the pricing there). Premium → price 0, no invoice
  item. Keeps the email-billing ledger truthful.
- **Platform** (super-admin) service → `setPremium`, and `listTenants`/`tenantDetail`/`emailBilling`
  gain `premium` + the new billing fields (plan, status, graceUntil). `setStatus` (manual override)
  stays as an operator escape hatch.
- **Orders / Stripe Connect** → unchanged. `STRIPE_PLATFORM_FEE_BPS` stays `0` (locked); the farmer
  Payments UI commission line reads "0 % комисиона".

---

## 4. Frontend — farmer admin (`client/`, :3000)

Extend the existing `/payments` page with an **„Абонамент"** (subscription) section above/below the
Connect (order-payments) section:
- Plan line: **Стандартен — €30/мес + €2 на бюлетин**, or **Премиум — безплатно**.
- Status badge: Активен / **Просрочен — спира след N дни** (visible grace countdown) / Спрян.
- Card on file (brand + last4) or a **„Добави карта"** button → `POST /billing/checkout` → redirect.
- **„Управление на плащането"** → `POST /billing/portal` → redirect (update card, invoices).
- Next-charge estimate: €30 + €2 × (broadcasts this cycle).
- Premium farms see the free state, no card UI.

New `components/payments/subscription-card.tsx`; `payments-client.tsx` renders it from
`GET /billing/summary`. Publishable key already wired (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`); Checkout
& Portal are redirects, so no new client SDK needed.

## 5. Frontend — super-admin (`admin/`, :3002)

- **Tenants list + detail**: show plan (Стандартен / **Премиум**) + billing status
  (Активен / Просрочен +days-left / Спрян). Add a **premium toggle** (`setPremium`). Keep the manual
  active/inactive override.
- **„Имейл сметки"** page: drop "Плащанията събираш ти, ръчно" — now Stripe-collected. Show billed vs
  paid where available; keep the per-farm push ledger.

---

## 6. Config / env (`env.validation.ts` + `.env.example`)

- `STRIPE_BILLING_PRICE_ID` — the €30/mo recurring Price, created once on the platform account
  (dashboard or a one-off setup script). Empty → billing disabled (Checkout returns a clear error),
  same graceful-degrade pattern as the rest of Stripe.
- `BILLING_BASE_PRICE_STOTINKI=3000` (display/estimate only; the real charge is the Stripe price).
- `EMAIL_PUSH_PRICE_STOTINKI=200` (exists).
- `BILLING_GRACE_DAYS=7`.
- `STRIPE_PLATFORM_FEE_BPS=0` (locked — no order commission).
- **No Stripe Tax.**

---

## 7. Testing & verification

- `BillingService` unit tests: premium short-circuit (no customer/sub/charge), `recordEmailPush`
  double-bill guard + premium-skip, grace transition (`invoice.payment_failed` → past_due + grace set
  once), suspend cron (past_due + expired → inactive), summary never-throws on Stripe error / disabled.
- Webhook: idempotent (redeliver no-ops), order-payment vs subscription disambiguation unaffected.
- Migration applies to dev DB; enum widened; gating still blocks only `inactive`.
- `pnpm --filter @farmflow/api build` + full server test suite green; `client` + `admin` `next build`.
- **Live Stripe test deferred** (same gap as existing Connect work) — needs real `STRIPE_SECRET_KEY`,
  a created `STRIPE_BILLING_PRICE_ID`, the webhook registered for invoice/subscription + Connect events.
  Disabled-safe paths verified without keys.

## 8. Out of scope (defer)

Annual plans · per-recipient email pricing · Stripe Tax / VAT automation · custom dunning email copy
(use Stripe's) · multiple seats/users per farm · proration beyond Stripe defaults.

## 9. НАП / tax note

Stripe is a payment processor only — it does not report to or register with НАП, and automating
collection creates **no new tax obligation** (same revenue, same declarations as manual invoicing).
The only new cost is Stripe's per-charge processing fee (~€0.70 on €30, EEA cards), which the platform
absorbs by decision. VAT/ДДС stays in the owner's accounting; Stripe Tax is intentionally **off**.
