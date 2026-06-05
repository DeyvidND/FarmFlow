# Farmer-facing Stripe payments UI — design

**Date:** 2026-06-05
**Branch:** feat/media-galleries (continues current uncommitted work)
**Status:** approved direction (visual brainstorm), pending spec review

## 1. Goal

Give each farmer a single place in their admin panel to connect their own Stripe
account, see whether they can take card payments, and see when their money
arrives — **simple for a low-tech farmer, but descriptive and useful**. Weave
payment status into the existing orders table so the farmer can tell paid-online
from cash/COD at a glance.

The connection to the third party (Stripe) uses **Stripe Connect embedded
components** — real Stripe-hosted UI mounted inside FarmFlow, themed to match.
This is less code than building custom dashboards and keeps onboarding/KYC,
payouts and the payments list maintained by Stripe.

## 2. Scope

**In scope (this spec):**
- New farmer-admin route `(admin)/payments` ("Плащания") — the connect + manage hub.
- Sidebar nav entry "Плащания".
- Backend: one new endpoint to mint a Stripe **Account Session**, and a small
  **summary** endpoint for the friendly payout card. Reuse existing
  `ensureConnectedAccount` / `accountStatus` / webhook.
- Orders: expose a derived `paymentStatus` on the admin order DTO; render a
  payment badge in the orders table + a row in the order detail panel.
- Graceful disabled/degraded states (no Stripe key, not connected, mid-onboarding).

**Out of scope (follow-up, tracked separately):**
- Super-admin (platform :3002) Stripe oversight table + `account.updated`
  status columns. (User previously chose "Both"; the farmer UI ships first.)
- Changing the platform fee model. `STRIPE_PLATFORM_FEE_BPS` stays env-driven.
- Live end-to-end verification with real card charges — needs real platform
  keys + Connect enabled (see §10).

## 3. Decisions

1. **Placement:** dedicated "Плащания" page (chosen in brainstorm), not a Settings card.
2. **Detail level:** simple summary on top (connected? when does money arrive?),
   detail (payments list) below.
3. **Payments list:** keep it — embedded Stripe `payments` component (near-zero
   extra code, shows who paid + refunds).
4. **Commission line:** shown. "Получаваш 100%" when fee bps = 0, else
   "Комисиона FarmFlow: X%". Computed from `STRIPE_PLATFORM_FEE_BPS`.
5. **Payout card:** our own UI (friendly big-number) fed by a summary endpoint
   (`balance.retrieve` + next payout), NOT the raw embedded payouts list — the
   embedded `payouts` component is available but kept out of v1 to stay simple.
6. **Payment status source of truth:** derived **server-side** into a
   `paymentStatus` enum; raw Stripe ids are NOT sent to the client.
7. **Gating:** the Плащания page is **not** subscription-gated — it is how a farm
   gets paid. (Other gated screens use the lock pattern; payments is core.)

## 4. Architecture

Stripe Connect, Express accounts, **direct charges** on the connected account
(already implemented in `stripe.service.ts`). Embedded components are mounted via
an **Account Session**:

```
Browser (Плащания page)
  │  loadConnectAndInitialize({ publishableKey, fetchClientSecret })
  ▼
BFF proxy  /api/session/stripe/account-session   (cookie → JWT)
  ▼
API  POST /stripe/connect/account-session  (JwtAuthGuard, tenant-scoped)
  │  ensureConnectedAccount(tenantId)
  │  stripe.accountSessions.create({ account, components:{…} })
  ▼  { client_secret }
Browser mounts: NotificationBanner, AccountOnboarding | Payments + AccountManagement
```

The webhook (`POST /stripe/webhook`, already built) flips orders to paid and is
what makes the orders payment badge accurate. **Operational note:** the webhook
must be registered in Stripe as a **Connect** endpoint (events fire on connected
accounts because charges are direct). This is config, documented in
`docs/SECURITY.md` / a Stripe setup note, not code.

## 5. Backend changes (`server/`)

### 5.1 New: `POST /stripe/connect/account-session`
In `StripeConnectController` (already exists) + `StripeService`:
- `createAccountSession(tenantId)`:
  - `accountId = await ensureConnectedAccount(tenantId)`
  - `session = stripe.accountSessions.create({ account: accountId, components: {
      account_onboarding: { enabled: true },
      notification_banner: { enabled: true },
      payments:           { enabled: true, features: { refund_management: true } },
      account_management: { enabled: true },
    }})`
  - return `{ clientSecret: session.client_secret }`
- Disabled-safe: if no `STRIPE_SECRET_KEY`, the existing `get stripe()` throws
  `BadRequestException('Stripe не е конфигуриран')` → client shows the
  "not configured" state.

### 5.2 New: `GET /stripe/connect/summary`
Friendly payout card data. Returns:
```ts
{
  connected: boolean; chargesEnabled: boolean; payoutsEnabled: boolean;
  detailsSubmitted: boolean;          // (reuse accountStatus fields)
  availableStotinki: number;          // balance.available (eur) → minor units
  pendingStotinki: number;            // balance.pending
  nextPayout: { amountStotinki: number; arrivalDate: string } | null;
  feeBps: number;                     // STRIPE_PLATFORM_FEE_BPS for the commission line
}
```
- Implemented via `stripe.balance.retrieve({}, { stripeAccount })` and
  `stripe.payouts.list({ limit: 1, status: 'pending'|'in_transit' }, { stripeAccount })`.
- Returns zeros / `connected:false` when not configured or no account (no throw)
  so the page can render every state from one call. Balance/payout lookups run
  only when `chargesEnabled` (a fresh, unsubmitted account can reject them) and
  are wrapped so any Stripe error degrades to zeros rather than failing the page.
- Currency is EUR (matches the rest of Stripe integration). Minor units pass
  through unchanged (consistent with `moneyFromStotinki`).

### 5.3 Publishable key to the client
Embedded components need the **platform publishable key** in the browser. Add
`STRIPE_PUBLISHABLE_KEY` to `env.validation.ts` + `.env(.example)` (optional;
empty = page shows "not configured"). Surface it to the Next app as
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (publishable keys are safe in the client).

### 5.4 Orders DTO — derived `paymentStatus`
`orderWithSlot` already selects all order columns (`getTableColumns(orders)`),
including `paidAt`, `stripeCheckoutSessionId`, `stripePaymentIntentId`. In the
admin order serialization (the `list` / detail mapping in `orders.service.ts`),
add a derived field and stop leaking raw Stripe ids:
```ts
paymentStatus =
  row.paidAt                       ? 'paid'            // online, card captured
  : row.stripeCheckoutSessionId    ? 'pending_online'  // online started, unpaid
  :                                  'cash';           // cash / COD, no online attempt
```
Also expose `paidAt` (already serialized in the public summary; mirror it here).
Do **not** add raw `stripePaymentIntentId`/`stripeCheckoutSessionId` to the DTO.

## 6. Frontend — Плащания page (`client/`)

Deps: `pnpm --filter <client> add @stripe/connect-js @stripe/react-connect-js`.

### 6.1 Route + data
- `app/(admin)/payments/page.tsx` — server component, `force-dynamic`. Fetches
  `GET /stripe/connect/summary` with the session cookie (mirror `orders/page.tsx`).
  Passes the summary + `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` presence down.
- `components/payments/payments-client.tsx` — client component, renders the state
  machine below.

### 6.2 States (single page, branches on summary)
- **Not configured** (no publishable key / Stripe disabled): info card — "Картовите
  плащания още не са активирани от платформата." No connect button. (Dev/empty-keys.)
- **Not connected** (`connected:false`): big CTA card — icon, "Приемай плащания с
  карта", plain-Bulgarian explainer ("Stripe е услуга за картови плащания. Парите
  идват директно при теб. ~5 мин."), one button "Свържи Stripe" → mounts the
  embedded `<ConnectAccountOnboarding>` (inline; no external redirect).
- **Onboarding incomplete** (`connected && !detailsSubmitted` or `!chargesEnabled`):
  amber "Почти готово" banner + `<ConnectNotificationBanner>` +
  `<ConnectAccountOnboarding>` to finish.
- **Connected & active** (`chargesEnabled`): the daily view —
  1. Status header (ours): green dot, "Свързано · приемаш плащания с карта",
     masked account, "Управлявай в Stripe →" (toggles `<ConnectAccountManagement>`).
  2. Payout card (ours): big `nextPayout.amountStotinki` + arrival date;
     налично сега / този месец minis from summary.
  3. `<ConnectPayments>` — recent payments + refunds (embedded).
  4. Commission line (decision 4).
  - `<ConnectNotificationBanner>` always mounted at top to surface any new
    Stripe required-actions.

### 6.3 Connect provider + theming
- `<ConnectComponentsProvider connectInstance={…}>` where the instance is built by
  `loadConnectAndInitialize({ publishableKey, fetchClientSecret, appearance })`.
- `fetchClientSecret` → `POST /api/session/stripe/account-session` (BFF) → returns
  `clientSecret`.
- `appearance.variables` mapped to FarmFlow tokens: `colorPrimary #2c5530`,
  `colorBackground #ffffff`, `colorText #26241d`, `borderRadius 12px`,
  font Commissioner — so embedded UI matches the panel.

### 6.4 BFF proxies (Next route handlers)
Follow existing split (`/api/session/*` for cookie→JWT POST, `/bff/*` for GET):
- `POST /api/session/stripe/account-session` → API `POST /stripe/connect/account-session`.
- `GET /bff/stripe/summary` is optional (page.tsx server-fetches directly with the
  cookie like `orders/page.tsx`); only add if the client needs to refetch.

### 6.5 Sidebar
Add to `NAV_GROUPS` under "Ежедневие", after "Поръчки":
`{ href: '/payments', label: 'Плащания', Icon: CreditCard }` (lucide). Not gated.

## 7. Orders integration

### 7.1 Types
`client/src/lib/types.ts` `Order`: add
`paidAt: string | null;` and
`paymentStatus: 'paid' | 'pending_online' | 'cash';`.

### 7.2 Table badge (`orders-client.tsx`)
Small pill rendered next to status (reuse `StatusBadge` look or a local pill):
- `paid` → green "Платена"
- `pending_online` → amber "Чака плащане"
- `cash` → gray "При доставка"
Desktop: add to the Статус cell (stacked) or a compact icon to avoid a new column
on small screens. Mobile card: append to the status row.

### 7.3 Order detail panel (`order-panel.tsx`)
Add an `InfoRow` (CreditCard icon) "Плащане" → same three labels, with paid time
when `paidAt` present ("Платена · 10:24").

## 8. Disabled / degraded behavior

- No `STRIPE_SECRET_KEY` → summary returns `connected:false` + page shows
  "not configured"; account-session endpoint 400s (never reached because the page
  doesn't mount the provider without a publishable key).
- No publishable key → page renders "not configured" (no embedded provider).
- Orders payment badge works regardless of Stripe config: cash orders → "При
  доставка"; only `paid`/`pending_online` require Stripe to have run.

## 9. Files touched (summary)

**server/**
- `modules/stripe/stripe.service.ts` — `createAccountSession`, `connectSummary`.
- `modules/stripe/stripe.controller.ts` — `POST /connect/account-session`, `GET /connect/summary`.
- `modules/orders/orders.service.ts` — derive `paymentStatus`, expose `paidAt`; drop raw stripe ids.
- `config/env.validation.ts`, `.env`, `.env.example` — `STRIPE_PUBLISHABLE_KEY`.

**client/**
- `app/(admin)/payments/page.tsx` (new), `components/payments/payments-client.tsx` (new).
- `components/payments/*` — small subcomponents (status header, payout card).
- `app/api/session/stripe/account-session/route.ts` (new BFF).
- `components/layout/sidebar.tsx` — nav entry.
- `lib/types.ts` — Order payment fields.
- `components/orders/orders-client.tsx`, `components/orders/order-panel.tsx` — badge + row.
- `lib/api-client.ts` — `getStripeSummary` / account-session helper if needed.
- env: `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.

## 10. Verification

- **Builds/types:** `pnpm -r build` clean; tsc clean.
- **Disabled-safe (no keys):** summary → `connected:false`; page renders
  "not configured"; orders table shows cash badges; no console errors.
- **Orders badge logic:** unit-level — seed/mark an order `paidAt` → "Платена";
  set `stripeCheckoutSessionId` only → "Чака плащане"; neither → "При доставка".
- **Live (requires real platform keys + Connect enabled — may be deferred like
  email/SES):** onboard a test connected account via the embedded component →
  `chargesEnabled` flips → summary shows balance/next payout → a test card payment
  appears in `<ConnectPayments>` and flips its order to "Платена".
- Theming: embedded components visually match panel (manual preview).

## 11. Follow-up (phase 2, separate spec)

Super-admin oversight (platform :3002): `account.updated` Connect-webhook handler
persisting `chargesEnabled/payoutsEnabled/detailsSubmitted` columns on `tenants`;
`GET /platform/stripe/accounts` table; optional drill-in account session for
support. Deferred so the farmer UI ships first.
