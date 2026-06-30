# AI Newsletter Auto-Draft

**Date:** 2026-06-30
**Status:** Approved (design) — ready for plan
**Scope owner:** `newsletter` module
**Note:** This is feature "#3" of the three retention/automation ideas. #1+#2 shipped
as the operator daily digest. This one is independent.

## Problem

Farmers rarely write newsletters, so the email channel (a real revenue stream:
~555 micro-€ per recipient, billed) and the customer touch-point both go unused.
Automate the hardest part — composing a "what's fresh this week" newsletter — into
a weekly **draft** the farmer reviews and sends with one click. The platform never
sends on the farmer's behalf (sending costs money and needs the farmer's voice),
so this only ever creates a draft + notifies the farmer.

## Scope

In:
- A weekly cron (**Thursday 08:00 Europe/Sofia**) that, for each opted-in tenant,
  builds a newsletter **draft** from fresh catalog content and notifies the farmer.
- AI-written copy (subject + intro + per-product one-liners) with a deterministic
  fallback when AI is unavailable or fails.
- A per-tenant opt-in toggle (`settings.autoNewsletter`, default **off**) — backend
  endpoint only; the farmer-facing checkbox UI is a follow-up, not in this plan.
- Dedup so unreviewed auto-drafts don't pile up.
- A manual "generate my draft now" trigger for testing.

Out (explicitly not building):
- **Auto-send.** The farmer always reviews + sends via the existing composer
  (`sendCampaign` — billing, suppression, one-click unsubscribe already handled).
- Any change to subscriber management, pricing, or the send pipeline.
- A new email template engine — drafts use the existing `NewsletterBlock[]` model
  and the existing `renderEmail` for preview/send.
- Scheduling/customizing the cadence per tenant (one fixed weekly slot).

## Key existing facts (reuse, don't rebuild)

- **Draft insertion point:** `NewsletterService.createCampaign(tenantId, { subject,
  blocks })` inserts a `draft` row in `newsletter_campaigns` (jsonb `blocks`,
  `status`, `recipientCount`, `priceStotinki`, `sentAt`, `updatedAt`). The farmer's
  existing composer lists drafts, edits blocks, previews (`renderEmail`), and sends
  (`sendCampaign`) — all untouched.
- **Block palette** (`packages/types` `NewsletterBlock`): `heading`, `text` (html),
  `image` (`image`, `alt?`, `href?`, `caption?`), `button` (`label`, `href`),
  `columns`, `divider`, `spacer`. No product block — a product showcase is composed
  from `image` + `text` (+ a final `button`).
- **Cron pattern:** `registerRepeatable(queue, name, cronPattern)` (BullMQ, tz Sofia,
  idempotent) + a `WorkerHost` processor — see `digest.processor.ts` /
  `operator-digest.processor.ts`. Worker-gated via `RUN_WORKERS`.
- **OpenAI** is wired server-side (`OPENAI_API_KEY`, default `gpt-4o-mini`); the
  pattern (bounded timeout, `response_format: json_object`, degrade) is in
  `import.ai.ts` and `product-extract.service.ts`.
- **EmailService** is `@Global()` (`sendMail({to,subject,html,text})`).
- **Best-sellers:** order-item counts (the `recommendations` module computes these;
  the draft service will run an equivalent direct query for the fallback).
- **DB_TOKEN** (drizzle) is globally injectable (used by insights/operator-digest
  without importing a module).
- **Latest migration is `0072`** → this feature adds `0073` (hand-written,
  **idempotent** — `ADD COLUMN IF NOT EXISTS`).

## Architecture

New `NewsletterDraftService` + `NewsletterDraftProcessor` inside `NewsletterModule`.
A new BullMQ queue. The processor fans out one job per eligible tenant; each job
builds and saves one draft, independently retryable.

```
Thu 08:00 Sofia (NEWSLETTER_DRAFT_QUEUE, job 'weekly')
        │
        ▼  eligibleTenantIds()  → tenants with settings.autoNewsletter=true,
        │                          not demo, ≥1 active subscriber
        ├─ enqueue 'tenant' job per id
        ▼
NewsletterDraftProcessor.process('tenant', {tenantId})
        ▼
NewsletterDraftService.generateForTenant(tenantId)
   ├─ if an unsent auto-generated draft already exists → skip ('exists')
   ├─ gatherFreshProducts(tenantId)  → mix (see below); if empty → skip ('no-content')
   ├─ writeCopy(farmName, products)  → AI {subject, intro, blurbs} | deterministic fallback
   ├─ assembleBlocks(copy, products, shopUrl)  [PURE] → NewsletterBlock[]
   ├─ createCampaign(tenantId, {subject, blocks})  + mark auto_generated=true
   └─ notifyFarmer(tenantEmail, campaignId)  → "Готов бюлетин за преглед" + panel link
```

## Components

### 1. Migration `0073_newsletter_auto_generated.sql`
```sql
ALTER TABLE newsletter_campaigns ADD COLUMN IF NOT EXISTS auto_generated boolean NOT NULL DEFAULT false;
```
Add the column to the drizzle schema (`packages/db`) so it can be set/queried.

### 2. Product gathering — `gatherFreshProducts(tenantId): Promise<DraftProduct[]>`
`DraftProduct = { id; name; priceStotinki; imageUrl: string | null }`. Direct drizzle
queries (no request-scoped service deps), capped at **6**, deduped by id, priority:
1. **New**: active, `deleted_at is null`, `created_at >= now()-interval '7 days'`, newest first.
2. **Available now**: active products with a current availability window (join the
   availability table the way the storefront does), not already included.
3. **Best-sellers fallback** (only if still empty): top products by order-item count,
   active. Ensures a farm with a static catalog still gets a draft.
Returns `[]` → the tenant is skipped (no empty newsletter).

### 3. AI copy — `writeCopy(farmName, products): Promise<DraftCopy>`
`DraftCopy = { subject: string; intro: string; blurbs: Record<string, string> }`
(blurbs keyed by product name). OpenAI `gpt-4o-mini`, `response_format: json_object`,
BG system prompt: warm seasonal-market tone, a short subject, a 1–2 sentence intro,
and one ≤12-word blurb per product. Bounded timeout + 1 retry. **Deterministic
fallback** (no throw — a missing newsletter is worse than a plain one): subject
`Свежи продукти от {farmName}`, generic intro, empty blurbs. If `OPENAI_API_KEY`
unset → go straight to fallback.

### 4. Block assembly — `assembleBlocks(copy, products, shopUrl): NewsletterBlock[]` (PURE)
- `heading` (level 1) = `copy.subject`
- `text` = `copy.intro` (escaped/sanitized via existing `sanitizeNewsletterHtml`)
- per product: `image` (`image: imageUrl`, `href: shopUrl`, `alt: name`) when an
  image exists, then `text` = `<b>name</b> — price €<br>blurb`; `divider` between products.
- final `button` (`label: 'Виж всички продукти'`, `href: shopUrl`).
Pure + unit-tested. `shopUrl` = the tenant storefront URL (`settings.siteUrl` if set,
else a configured `PUBLIC_STOREFRONT_BASE` + slug; if neither, omit product/button
hrefs but still produce the draft).

### 5. `NewsletterDraftService`
Injects `DB_TOKEN`, `EmailService`, `ConfigService`, `NewsletterService` (for
`createCampaign`). Methods: `eligibleTenantIds()`, `gatherFreshProducts()`,
`writeCopy()`, `generateForTenant()` (returns `{ created: true; campaignId } |
{ created: false; reason: 'exists' | 'no-content' }`), `notifyFarmer()`. After
`createCampaign`, set `auto_generated=true` on the new row (createCampaign returns
the id). Dedup query: exists a `newsletter_campaigns` row for the tenant with
`status='draft' AND auto_generated=true`.

### 6. `NewsletterDraftProcessor`
`@Processor(NEWSLETTER_DRAFT_QUEUE)`, `onModuleInit` → `registerRepeatable(queue,
'weekly', '0 8 * * 4')`; `process` handles `'weekly'` (fan-out) and `'tenant'`
(one draft). Worker-gated in the module providers.

### 7. Opt-in toggle (backend only this plan)
- Backend: `PATCH /newsletter/auto-settings { enabled: boolean }` (tenant-scoped,
  `JwtAuthGuard`) → writes `settings.autoNewsletter` via the jsonb-merge pattern used
  for other `settings.*` flags (`jsonb_set(coalesce(settings,'{}'), array['autoNewsletter'], …)`).
  The current value is surfaced in the existing `GET /newsletter/quote` response
  (add an `autoNewsletter: boolean` field) so a UI can bind later.
- **Frontend checkbox is a follow-up, NOT in this plan.** The operator enables a farm
  via the PATCH endpoint in the meantime. Descoped to ship the automation engine first
  and keep this plan backend-only + fully testable.

### 8. Manual test endpoint
`POST /newsletter/auto-draft-test` (tenant-scoped) → `generateForTenant(currentTenant)`
ignoring the toggle/cadence (still skips on no-content / existing draft). Returns the
`generateForTenant` result so the farmer/operator can try it immediately.

### 9. Module wiring
Register `NEWSLETTER_DRAFT_QUEUE` (`queue.constants.ts`) + `BullModule.registerQueue`
in `NewsletterModule`; providers add `NewsletterDraftService` always and
`NewsletterDraftProcessor` only under `RUN_WORKERS`.

## Data flow / state

One new boolean column (`auto_generated`) — no other schema change. Drafts live in
the existing `newsletter_campaigns` table and flow through the existing composer.
`settings.autoNewsletter` is a jsonb flag (no migration). At-least-once job delivery
is fine: the dedup check makes a retry idempotent (a second run finds the draft it
just made and skips).

## Error handling

- AI failure / no key → deterministic fallback copy (never blocks the draft).
- `gatherFreshProducts` empty → skip tenant (`no-content`), no draft, no email.
- Farmer-notify email failure → logged, draft still created (the farmer will see it
  in the composer regardless).
- A per-tenant job throwing → BullMQ retries that tenant only (fan-out isolation).

## Testing

- `assembleBlocks` (pure): products → heading+intro+image/text+divider+button;
  missing image omits the image block; empty blurb still renders name+price; shopUrl
  absent omits hrefs.
- `writeCopy` (OpenAI mocked): parses JSON to `{subject,intro,blurbs}`; malformed/no-key
  → deterministic fallback (subject contains farm name, blurbs empty).
- `generateForTenant` (mocked deps): existing auto-draft → `{created:false,
  reason:'exists'}`, no createCampaign; zero products → `{created:false,
  reason:'no-content'}`; happy path → createCampaign called, `auto_generated` set,
  farmer notified, returns `{created:true, campaignId}`.
- `eligibleTenantIds` (mocked db): includes only toggle-on, non-demo, ≥1-subscriber.
- Full server suite green.

## Acceptance

1. A tenant with the toggle on, active subscribers, and ≥1 fresh product gets, each
   Thursday 08:00, a draft in its composer + an email „Готов бюлетин за преглед".
2. The draft renders (existing preview) with a heading, intro, the featured products,
   and a „Виж всички продукти" button; the farmer can edit and send it normally.
3. A tenant with nothing fresh, the toggle off, no subscribers, or an existing unsent
   auto-draft gets nothing.
4. `POST /newsletter/auto-draft-test` produces the same draft on demand.
5. Sending still goes through the existing billed path; the platform never auto-sends.
6. Full suite green.
