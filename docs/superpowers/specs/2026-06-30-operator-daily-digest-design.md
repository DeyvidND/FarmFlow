# Operator Daily Digest

**Date:** 2026-06-30
**Status:** Approved (design) — ready for plan
**Scope owner:** platform (super-admin) module
**Note:** This merges the originally-separate ideas "#1 signal-driven nudges" and
"#2 operator morning digest" into one feature. The user decided signals should be
reported to the **operator** (who then calls the farm), not auto-emailed to
farmers — which collapses #1 into #2. Feature "#3 newsletter auto-draft" is a
separate spec, written next.

## Problem

The operator checks several super-admin dashboards by hand every morning to run
the platform: which farms need attention (stuck on onboarding, payments not
finished, gone dormant), who signed up, which courier shipments are stuck, how
email revenue is doing. All this data already exists in the panel but must be
pulled up manually across screens. Automate it into **one daily email** to the
operator so the morning check is a single read, and the operator acts (calls the
farm) from there.

## Scope

In:
- One **internal** email to the operator (`SUPER_ADMIN_EMAIL`), once a day at
  **07:00 Europe/Sofia**.
- Five sections built entirely from data we already compute (see Data sources).
- Skip the send entirely on a fully-quiet day (nothing in any section).
- A manual test trigger to preview today's digest on demand.

Out (explicitly not building):
- Any farmer-facing email / nudge / unsubscribe / opt-out (the pivot removed all
  of this — the digest goes only to the operator).
- A dedupe/sent-log table (it is a daily snapshot, not per-item nudges).
- Sentry error counts (needs the Sentry API; YAGNI for v1 — all sections here are
  DB-derived).
- Any new UI screen (the Анализ / ops screens already exist; this just emails them).
- Configurable per-section thresholds beyond what the existing services use.

## Key existing facts (reuse, don't rebuild)

- **Cron pattern:** `registerRepeatable(queue, name, cronPattern)` (BullMQ
  repeatable, `tz: 'Europe/Sofia'`, idempotent, fires once cluster-wide). The
  `digest` module (`server/src/modules/digest/digest.processor.ts`) is the exact
  template: `onModuleInit` registers the schedule; `process` handles the job.
- **Worker gating:** processors are only provided when `RUN_WORKERS` is true
  (see `DemoCleanupProcessor` in `platform.module.ts`).
- **Email:** `EmailModule` is `@Global()` and exports `EmailService`, so
  `EmailService.sendMail({ to, subject, html, text })` is injectable anywhere with
  no module import. BG HTML+text templates are written inline (see `digest.service.ts`).
- **Signals:** `PlatformInsightsService.insights()` (in `insights.service.ts`,
  already in `PlatformModule`) returns `signals: FarmSignals[]` — per non-demo farm
  with `name, slug, phone, email, signals[] (key,label,action,severity), maxSeverity`.
  Covers all 6 signal keys (`empty_shop, no_orders, dormant, dropping,
  stripe_incomplete, econt_incomplete`). 90 s Redis cache — fine for a daily cron.
- **Stuck shipments / COD:** `PlatformService.deliveryOps()` returns
  `{ shipments, cod, stuckDrafts }` where `stuckDrafts` is `{ farmerName,
  tenantName, count, oldestAt }[]` (oldest first, capped 20).
- **Email revenue:** `PlatformService.emailBilling()` returns
  `{ rows, totals: { recipientTotal, revenueStotinki, costStotinki, marginStotinki } }`.
- **Recipient:** `SUPER_ADMIN_EMAIL` is already a validated optional env var
  (`env.validation.ts`). Unset → skip the digest with a logged warning (no var
  to add).
- **Queue constants:** named in `server/src/common/queue/queue.constants.ts`
  (`EMAIL_QUEUE`, `DIGEST_QUEUE`, …). Add one new constant here.

## Architecture

A new `OperatorDigestService` + `OperatorDigestProcessor` **inside `PlatformModule`**
(it already provides `PlatformInsightsService` and `PlatformService`, so no
cross-module export gymnastics). One new BullMQ queue. The cron mirrors `digest`.

```
07:00 Sofia repeatable (OPERATOR_DIGEST_QUEUE, job 'daily')
        │
        ▼
OperatorDigestProcessor.process('daily')
        │
        ▼
OperatorDigestService.runDaily()
   ├─ insightsService.insights()            → signals[]            (section 2)
   ├─ platformService.deliveryOps()         → stuckDrafts          (section 4)
   ├─ platformService.emailBilling()        → totals               (section 5)
   ├─ this.dailyPulse()  (new small query)  → signups + orders/rev (sections 1,3)
   ├─ assembleDigest(input)  [PURE]         → { html, text, isEmpty }
   ├─ if isEmpty → log + return (skip send)
   └─ EmailService.sendMail({ to: SUPER_ADMIN_EMAIL, subject, html, text })
```

`assembleDigest(input, date)` is a **pure function** (no DB / no email) returning
`{ html, text, isEmpty }`, so it is unit-tested directly (mirrors `computeInsights`
and the digest renderers).

## Components

### 1. Queue constant
Add to `queue.constants.ts`: `export const OPERATOR_DIGEST_QUEUE = 'operator-digest';`

### 2. `OperatorDigestService` (new, in `platform/`)
Injects `@Inject(DB_TOKEN) db`, `PlatformInsightsService`, `PlatformService`,
`EmailService`, `ConfigService`.

- `dailyPulse(): Promise<DailyPulse>` — one new query block (Sofia-local "last 24h"):
  - `newSignups`: non-demo tenants with `createdAt >= now()-24h` → `{ name, createdAt }[]`.
  - `orders24h` + `revenue24h`: count + `sum(totalStotinki) filter (status <> 'cancelled')`
    over orders in the last 24h (exclude demo tenants, mirroring insights).
- `runDaily(): Promise<{ sent: boolean; reason?: 'no-recipient' | 'empty' }>`:
  - read `SUPER_ADMIN_EMAIL`; if empty → log warn, return `{ sent:false, reason:'no-recipient' }`.
  - gather the 4 sources concurrently (`Promise.all`).
  - `const { html, text, isEmpty } = assembleDigest(input, bgToday())`.
  - if `isEmpty` → log, return `{ sent:false, reason:'empty' }`.
  - `await email.sendMail({ to, subject: 'Дневен отчет — ФермериБГ', html, text })`;
    return `{ sent:true }`.

### 3. `assembleDigest` (pure, exported from the service file)
Input shape:
```ts
interface OperatorDigestInput {
  pulse: { orders24h: number; revenue24hStotinki: number; newSignups: { name: string; createdAt: Date | null }[] };
  signals: FarmSignals[];                 // from insights()
  stuckDrafts: { farmerName: string; tenantName: string; count: number; oldestAt: Date | null }[];
  emailTotals: { recipientTotal: number; revenueStotinki: number; marginStotinki: number };
}
```
Sections (each rendered only when it has content; section omitted otherwise):
1. **Дневен пулс** — "Поръчки (24ч): N · Приход: X €" (always shown if orders>0).
2. **Ферми за внимание** — group by farm (sorted by `maxSeverity` desc, already
   sorted by `insights()`), each row: farm name, **phone** (`—` if null), and its
   signals as `label` chips with the suggested `action`. This is the "call list".
3. **Нови регистрации (24ч)** — farm name + time, or omitted if none.
4. **Заседнали доставки** — farmerName · tenantName · `count` чернови · oldest age,
   or omitted if none.
5. **Имейл приход (този месец)** — recipients, revenue €, margin €.

`isEmpty` is true when: `signals.length === 0 && stuckDrafts.length === 0 &&
pulse.newSignups.length === 0 && pulse.orders24h === 0`. (Email revenue alone is a
standing total and does not by itself justify a daily send.)

Reuse the digest module's HTML scaffold conventions (max-width 600, inline styles,
`escapeHtml`, BG headings) — copy the small helpers (`eur`, `escapeHtml`) locally
rather than cross-importing from `digest.service.ts` (keep the modules decoupled).

### 4. `OperatorDigestProcessor` (new, in `platform/`)
Mirrors `DigestProcessor`:
- `@Processor(OPERATOR_DIGEST_QUEUE)`, `extends WorkerHost implements OnModuleInit`.
- `onModuleInit` → `registerRepeatable(this.queue, 'daily', '0 7 * * *')`.
- `process(job)` → if `job.name === 'daily'` call `service.runDaily()`.
- Only provided when `RUN_WORKERS` (added conditionally to `PlatformModule.providers`,
  like `DemoCleanupProcessor`).

### 5. Module wiring (`platform.module.ts`)
- Register the new queue: `BullModule.registerQueue({ name: OPERATOR_DIGEST_QUEUE, defaultJobOptions: { attempts: 3, backoff: { type:'exponential', delay:5000 }, removeOnComplete: true, removeOnFail: 100 } })`.
- providers: add `OperatorDigestService` always; add `OperatorDigestProcessor` only
  when `RUN_WORKERS`.

### 6. Manual test endpoint (`platform.controller.ts`)
`POST /platform/digest/operator-test` (under `PlatformAdminGuard`, `@Throttle`):
calls `operatorDigest.runDaily()` and returns `{ sent, reason? }` so the operator can
preview today's digest on demand (sends the real email to `SUPER_ADMIN_EMAIL`).

## Data flow / state

Stateless. No new table, no migration. Each run is an independent snapshot; BullMQ
`removeOnComplete` cleans the job. At-least-once delivery is acceptable (a rare
duplicate operator email is harmless), matching the existing digest's trade-off.

## Error handling

- No `SUPER_ADMIN_EMAIL` → skip + warn (not an error).
- A source method throwing → the job fails and BullMQ retries (3 attempts); the
  pure assembler itself never throws.
- `EmailService.sendMail` already queues with its own retry/backoff.

## Testing

- `assembleDigest` (pure, no mocks needed):
  - all-empty input → `isEmpty: true`.
  - signals present → "Ферми за внимание" lists farm + phone + each signal action.
  - null phone → renders `—`.
  - stuckDrafts present → rows rendered; absent → section omitted.
  - newSignups / orders24h drive `isEmpty` correctly (email revenue alone stays empty).
  - HTML escapes a farm name containing `<`/`&`.
- `OperatorDigestService.runDaily` (mocked insights/platform/email/config):
  - no recipient → `{ sent:false, reason:'no-recipient' }`, email not called.
  - empty snapshot → `{ sent:false, reason:'empty' }`, email not called.
  - populated snapshot → `email.sendMail` called once with `to = SUPER_ADMIN_EMAIL`,
    returns `{ sent:true }`.
- Full server suite stays green.

## Acceptance

1. With `RUN_WORKERS` and `SUPER_ADMIN_EMAIL` set, at 07:00 Sofia the operator
   receives one email with the populated sections (or no email on a quiet day).
2. `POST /platform/digest/operator-test` sends/preview the same email on demand and
   returns the `{ sent, reason? }` outcome.
3. The "Ферми за внимание" section lists every flagged farm with its phone, so the
   operator can call down the list.
4. No farmer receives anything; no new table; full suite green.
