# Day-of SMS delivery-window reminder

**Date:** 2026-07-13
**Status:** Approved (brainstorming) → ready for implementation plan
**Origin:** Vasil's suggestion — besides the confirmation email, send an SMS on the
delivery day reminding the customer of the day + the delivery time window.

## Problem

Today FarmFlow already notifies own-delivery customers of their delivery time window
(Task #13, migration 0094) **by email only**. The operator generates windows from the
optimized route, reviews/edits them, approves, and clicks "Извести", which emails each
customer their `HH:MM–HH:MM` window (`OrderConfirmationService.sendDeliveryWindow`,
invoked from `RoutingService.notifyDeliveryWindows`,
`server/src/modules/routing/routing.service.ts:1264`).

Two gaps:
1. Email is easy to miss on the morning of delivery. A same-day SMS is a far better
   reminder for a physical delivery that needs the customer to be home.
2. Customers with a phone but no email get no window notification at all today.

The existing code already anticipated this: the `notifyDeliveryWindows` doc comment reads
*"Channel-extensible: a future ViberService slots in beside the email."* SMS slots in the
same way.

## Goal

On the **delivery day**, automatically send each own-delivery customer a short SMS
reminder in Bulgarian with their order number and approved delivery window — **once**,
idempotently, without operator action that morning.

This is a **transactional** message about an order the customer placed (not marketing).

## Scope decisions (approved)

| # | Decision | Rationale |
|---|----------|-----------|
| A | **Own-delivery (`deliveryType='address'`) orders only** | Mirrors the existing window email. Econt/Speedy courier orders already carry their own carrier SMS notification; they are excluded from this reminder. |
| B | **Cyrillic message** | Cyrillic SMS is UCS-2 = 70 chars/segment, so a Bulgarian message is likely 2 segments (≈2× cost). Accepted over transliterated Latin, which reads poorly. Message kept tight to minimise segments. |
| C | **Per-tenant toggle `settings.sms.dayOfReminder`, default OFF** | SMS costs money per message; each farm opts in. Platform runs one gateway account; sender ID = "ФермериБГ" (configurable). |
| Trigger | **Automatic morning cron ~08:00 Europe/Sofia** | No operator action that morning. Modelled on the existing 07:00 digest repeatable. |
| Provider | **BG-local HTTP SMS gateway** (SMSAPI.bg / Mobica / iSMS-style) | Cheaper for BG numbers, local alphanumeric sender-ID support, BG invoicing. Behind a swappable `SmsProvider` interface so the concrete gateway is a config/adapter choice. |

### Workflow dependency (accepted)

The 08:00 cron sends only for windows the operator has already **approved** (or already
emailed → status `sent`). So the operator must approve the day's windows **the evening
before**. If windows aren't approved by cron time, nothing is sent for those orders (they
are counted/logged, not silently dropped). This matches how the day already works: windows
are generated and approved as part of route planning the day before.

## Architecture

Five pieces. Each is independently testable.

### 1. `SmsService` + `SmsProvider` adapter (new module `common/sms`)

- **`SmsProvider` interface** — one method: `send(to: string, body: string): Promise<{ providerMessageId: string | null; segments: number }>`. Throws on gateway failure.
- **`HttpSmsProvider`** — concrete adapter for the chosen BG gateway. Reads
  `SMS_GATEWAY_URL`, `SMS_GATEWAY_TOKEN` (or user/pass), `SMS_SENDER_ID` (default
  `ФермериБГ`) from env. POSTs the message; parses the gateway's message-id + status.
- **`LogOnlySmsProvider`** — fallback when no gateway creds are configured. Logs the
  message and returns a synthetic id. This keeps dev/staging safe (no real sends, no
  spend) and lets the whole pipeline be exercised end-to-end without a live account.
  Provider selection is a factory: creds present → `HttpSmsProvider`, else `LogOnlySmsProvider`.
- **`SmsService.sendSms(phone, body, meta)`** — normalises the phone to E.164 BG (reuse
  the cod-risk normalizer), rejects un-normalisable numbers, calls the provider, and
  writes an `sms_log` row (success or failure). Never throws to the caller on a provider
  error — it records the failure and returns a result object, so a single bad number
  can't abort a batch.

### 2. `sms_log` table (new migration)

One row per attempted send — audit trail, dedup evidence, and cost accounting.

Columns (final names in the plan): `id`, `tenant_id`, `order_id` (nullable — general
purpose), `phone` (normalized E.164), `body`, `segments` (smallint), `provider`
(text: `http` / `log-only`), `provider_message_id` (nullable), `status`
(`sent` / `failed`), `error` (nullable), `kind` (text, e.g. `delivery_window` — future
message types reuse the table), `created_at`.

Indexes: `(tenant_id, created_at)` for the per-tenant cost/audit view;
`(order_id)` for "did this order get an SMS".

> **Migration discipline (project gotcha):** hand-write the SQL migration and its journal
> entry; **never leave an idx gap** in the drizzle journal — a gap silently breaks the
> migrator (caused a real prod outage before). Next sequential number after the current head.

### 3. New `delivery_window_sms_at` column on `orders` (same or adjacent migration)

- `delivery_window_sms_at timestamptz` — the SMS claim/idempotency marker for the window
  reminder. **Deliberately separate** from the email's `delivery_window_notified_at`:
  the email may already have gone out (status `sent`) the evening before, yet the morning
  SMS must still fire exactly once. Reusing the email column would either double-send or
  suppress the SMS.

### 4. Per-tenant SMS settings (`settings.sms`)

- Stored in `tenants.settings.sms` jsonb, defensively parsed (mirror
  `vendor-finance.settings.ts`): `{ dayOfReminder: boolean }`, default `false`.
- Exposed + editable in the operator/super-admin settings UI (same merge-into-`settings`
  path as `routing`/`delivery`, `tenants.service.ts:160`). A simple on/off switch labelled
  e.g. „SMS напомняне в деня на доставка".

### 5. SMS reminder cron (new processor, modelled on digest)

- On worker boot, `registerRepeatable(queue, 'delivery-window-sms', '0 8 * * *')` with
  `tz: 'Europe/Sofia'` (mirror `digest.processor.ts:23`).
- **Fan-out:** the 08:00 job enumerates tenants with `settings.sms.dayOfReminder === true`
  and enqueues one `tenant-sms` job per tenant (mirror the 18:00 tomorrow-digest fan-out),
  so one slow gateway can't block others.
- **Per-tenant job** runs a claim-before-send loop, structurally identical to
  `notifyDeliveryWindows`:
  - Select orders where: `tenant_id` = this tenant, `delivery_type='address'`,
    `status='confirmed'`, `scheduledForDay(today)`, `delivery_window_start` not null,
    `delivery_window_status IN ('approved','sent')`, `customer_phone` present,
    `delivery_window_sms_at IS NULL`.
  - For each: **atomic claim** — `UPDATE ... SET delivery_window_sms_at = now()
    WHERE id = ? AND delivery_window_sms_at IS NULL` returning the row. Lose the race →
    skip (idempotent; no double-SMS on a re-run or concurrent worker).
  - On win: build the message, `SmsService.sendSms(...)`. On provider failure, **release
    the claim** (`delivery_window_sms_at = NULL`) so a later run retries — same
    retry-safety pattern the email path uses (`routing.service.ts:1332`).
  - Return `{ sent, skipped, failed, total }` for logging.
- A manual trigger endpoint (operator-only, like `digest.controller`) to fire the send for
  a given day without waiting for 08:00 — for testing and for re-sends.

## Message content

Bulgarian, tight, no PII beyond the order number:

```
ФермериБГ: доставка днес на поръчка #<n>, между <HH:MM>–<HH:MM> ч.
```

- `<n>` = `orders.orderNumber`; `<HH:MM>` = normalized `delivery_window_start/end`.
- Sender ID `ФермериБГ` (or the tenant's brand later — v2).
- Expect ~2 UCS-2 segments; `sms_log.segments` records the actual count for cost tracking.

## Data flow

```
(evening before) operator generates + approves windows  → status 'approved'/'sent'
                                                          │
(08:00 Europe/Sofia)  repeatable 'delivery-window-sms' fires
        │  enumerate tenants where settings.sms.dayOfReminder = true
        ▼
   per-tenant job:
        select confirmed address orders scheduledForDay(today),
        window approved|sent, phone present, sms_at IS NULL
        │
        for each: atomic claim sms_at → build message → SmsService.sendSms
        │                                   │
        │                                   ├─ HttpSmsProvider (creds) → BG gateway
        │                                   └─ LogOnlySmsProvider (no creds) → log
        ▼
   write sms_log row (sent|failed);  on failure release claim for retry
```

## Error handling & edge cases

- **No phone / un-normalisable phone** → skip, count as skipped, no `sms_log` row (nothing
  attempted) or a `failed` row with reason (decide in plan; lean: skip silently, count).
- **Provider throws** → `failed` row + release claim → retried on next run/manual trigger.
- **Re-run same day** → claimed rows (`sms_at` set) are filtered out → no duplicate SMS.
- **Concurrent workers** → atomic claim ensures exactly one winner per order.
- **Window edited after SMS sent** → out of scope for v1 (email path has the same
  behaviour; a corrected time is an operator judgement call). `sms_at` stays set.
- **Tenant toggle OFF** → tenant never enters the fan-out; zero sends, zero spend.
- **Missing gateway creds in prod** → `LogOnlySmsProvider` logs instead of sending; surfaced
  as a warning so it's not mistaken for real delivery.

## Testing

- `SmsService`: phone normalization (valid/invalid BG numbers), provider success writes a
  `sent` log row, provider throw writes a `failed` row and does not rethrow.
- Provider factory: creds present → Http, absent → LogOnly.
- Cron processor: registers the `0 8 * * *` Europe/Sofia repeatable; fan-out enqueues one
  job only per opted-in tenant.
- Per-tenant send loop (mirror `routing.delivery-windows.spec` style):
  - selects only confirmed address orders, today, approved|sent window, phone present,
    unclaimed;
  - claim is atomic — a second pass sends nothing (idempotent);
  - provider failure releases the claim and increments `failed`;
  - orders without a phone are skipped and counted.
- Settings parse: absent/garbage `settings.sms` → `dayOfReminder: false`.

## Out of scope (v1)

- Per-tenant / per-brand sender ID (platform sender ID only for now).
- Viber / other channels (interface is channel-agnostic; only SMS built).
- Customer-facing opt-out link inside the SMS (transactional; per-tenant toggle governs).
- SMS for Econt/Speedy courier orders (they have carrier SMS).
- Retrying past the same day / scheduled re-send windows.

## Affected code (reference)

- `server/src/modules/routing/routing.service.ts:1264` — `notifyDeliveryWindows` (email
  path this mirrors; do not merge SMS into it — separate cron/claim column).
- `server/src/modules/digest/digest.processor.ts:23` — repeatable-registration pattern.
- `server/src/modules/vendor-finance/vendor-finance.settings.ts` — defensive settings parse
  pattern for `settings.sms`.
- `packages/db/src/schema.ts:392` — `orders` table (new `delivery_window_sms_at` column);
  new `smsLog` table.
- cod-risk phone normalizer — reuse for E.164 BG.
```
