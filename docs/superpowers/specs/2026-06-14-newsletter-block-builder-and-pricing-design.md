# Newsletter: block-builder editor + per-recipient pricing + cost transparency

**Date:** 2026-06-14
**Status:** Approved design, pre-implementation
**Branch:** TBD (new feature branch off `main`)

## Problem

The farmer newsletter feature today has two weaknesses:

1. **Pricing margin is unfair on small lists.** Billing is a **flat €2 per broadcast** regardless of size
   (`EMAIL_PUSH_PRICE_STOTINKI=200`, `billPush` in `server/src/modules/billing/billing.service.ts`). A farm
   sending to 50 people pays €2 — €0.04/email, ~100× the underlying Resend cost (~$0.0004/email on the
   Resend Pro $20/50,000 plan). The owner wants a fair per-recipient price.
2. **The editor is bare.** `client/src/components/newsletter/newsletter-client.tsx` is a plain subject input
   plus a `<textarea>`; the send renders `escapeHtml`+`nl2br` into a minimal green template
   (`renderBroadcastHtml`). No images, no styling, nothing that makes a farmer enjoy sending mail. The owner
   wants a real block-based email builder with images, like the polished mail Resend itself sends.

Separately, the owner wants the panel to **explain the cost** to the farmer before they send ("you have 200
subscribers — this send will cost you €X") and wants a **super-admin view of his own margin** (revenue vs
Resend cost).

## Goals

- Replace flat €2/broadcast with **true 50%-markup-over-cost per recipient** (Resend cost × 1.5 ≈
  €0.000555/recipient), accumulated into the monthly Stripe invoice.
- A **custom block-based email builder** (own blocks + pure server-side email-safe HTML renderer), with inline
  images stored in R2, auto-branded from the farm's existing `settings.brand` (logo + theme colour).
- **Drafts**: editor content persists; farmer can save and come back. A list of past + draft campaigns.
- **Farmer cost transparency**: live cost preview in the composer and in the send-confirm dialog, plus a
  small "this month so far" figure.
- **Super-admin margin view**: per-farm and platform-wide — emails sent, revenue, Resend cost, margin.

## Non-goals

- No per-farm sending domains (unchanged — one shared `farmsteadflow.com`).
- No scheduled/automated sends, A/B testing, segmentation, or open/click tracking.
- No third-party builder dependency (GrapesJS / Unlayer / react-email) — rejected in design (foreign look,
  heavy deps, branding/theming friction). We own the blocks and the renderer.
- No change to the €30/mo base subscription — only the per-email line changes.

---

## 1. Pricing

### Rate and math

Money stays integer EUR cents (stotinki) end-to-end, but the per-recipient rate is sub-cent, so the **rate**
is stored in **micro-euros** (1e-6 €) to keep the multiply integer, then the per-send total is rounded to
whole cents.

New config (env + `env.validation.ts`), with defaults:

| Const | Value | Meaning |
|---|---|---|
| `EMAIL_COST_PER_RECIPIENT_MICRO` | `370` | ≈ Resend Pro $0.0004/email in € — the cost basis |
| `EMAIL_PRICE_PER_RECIPIENT_MICRO` | `555` | cost × 1.5 = **true 50% markup**; €0.000555 charged per recipient |
| `EMAIL_PUSH_MAX_RECIPIENTS` | `5000` | unchanged — reject a single send over this |

Price is derived as **cost × 1.5** (owner's choice: real 50% profit over Resend's cost). The cost basis is
the explicit input; the price const is set to `round(370 × 1.5) = 555`. Margin is therefore €0.000185/email
(= 50% of cost, 33% of the charged price). Removed: `EMAIL_PUSH_PRICE_STOTINKI` (the flat €2). Update
`.env.example` and `docs/EMAIL-SETUP.md`.

Per-send charge:

```
priceStotinki = Math.round(recipientCount * EMAIL_PRICE_PER_RECIPIENT_MICRO / 10_000)
```

(`micro / 10_000` converts micro-euro → stotinki: 555 micro = 0.0555 stotinki/recipient.)
Examples: 200 → round(11.1) = 11 ст = **€0.11**; 50 → 3 ст = €0.03; 1 000 → round(55.5) = 56 ст = €0.56.

A shared pure helper `priceForRecipients(n)` lives in a small `billing.pricing.ts` (no I/O, unit-tested) and
is used by **both** the cost preview endpoint and `billPush`, so the quoted price and the billed price can
never drift.

### Billing change

`BillingService.billPush` (and the `emailPushes` insert in `NewsletterService`) compute the amount with
`priceForRecipients(recipientCount)` instead of the flat const. Premium farms remain free (price 0, no
invoice item). Invoice-item description unchanged in shape: `Бюлетин: <subject> (<n> получателя)`.

`BillingSummary.emailPriceStotinki` (flat per-push) is replaced by `emailPricePerRecipientMicro` so the
farmer Payments card can show the per-recipient price (displayed as **"€0.55 на 1000 имейла"** — cleaner than
the sub-cent figure) instead of "€2 на бюлетин".

---

## 2. Data model

New migration (next number, **0042**).

### `newsletter_campaigns` — editor content + draft/sent state

```
id              uuid pk default uuid_generate_v4()
tenant_id       uuid not null references tenants(id)
subject         text not null default ''
blocks          jsonb not null default '[]'        -- ordered Block[] (see §3)
status          text not null default 'draft'      -- 'draft' | 'sent'
recipient_count integer                            -- null until sent
price_stotinki  integer                            -- null until sent
sent_at         timestamptz
created_at      timestamptz default now()
updated_at      timestamptz default now()
index newsletter_campaigns_tenant_updated_idx on (tenant_id, updated_at desc)
```

### `email_pushes` — unchanged role (immutable billing/usage ledger)

Add nullable `campaign_id uuid references newsletter_campaigns(id)` to link a send back to its campaign. All
existing columns stay. The ledger remains the source of truth for billing and the super-admin margin
aggregate (so historical pricing is preserved on each row's `price_stotinki`).

`newsletter_subscribers` — unchanged.

---

## 3. Block model

`packages/types` exports the block union (shared by client editor, server renderer, DTO validation).

```ts
type Block =
  | { type: 'hero';    image: string; alt?: string; href?: string }          // full-width image
  | { type: 'heading'; text: string; level?: 1 | 2 }
  | { type: 'text';    html: string }                                        // sanitized Quill output
  | { type: 'image';   image: string; alt?: string; href?: string; caption?: string }
  | { type: 'button';  label: string; href: string }                        // colour from brand theme
  | { type: 'columns'; left: ColumnContent; right: ColumnContent }          // 2-up; stacks on mobile
  | { type: 'divider' }
  | { type: 'spacer';  size?: 'sm' | 'md' | 'lg' };

type ColumnContent =
  | { kind: 'text';  html: string }
  | { kind: 'image'; image: string; alt?: string };
```

- Each block gets a client-only `id` (for React keys / dnd) that is **not** persisted in a way the renderer
  depends on.
- `image` fields hold **absolute https R2/CDN URLs** (email clients can't load relative/private images).
- `text`/column `html` is Quill output, **server-sanitized** with the existing `sanitize-html` allowlist
  (reuse from `articles.util.ts`) on save AND defensively on render.

The footer (farm contacts + unsubscribe link) is **not** a block — it is appended automatically by the
renderer so it can never be deleted and the unsub link is always present (CAN-SPAM / Resend requirement).

---

## 4. Server email renderer

`server/src/modules/newsletter/email-render.ts` — a **pure function**
`renderEmail(blocks: Block[], opts: RenderOpts): string`.

`RenderOpts`: `{ subject, brand: { logoUrl?: string; themeColor: string; farmName: string }, contact?, unsubscribeUrl: string }`.

Email-safe HTML rules (this is the careful part — email clients are ancient):

- Outer `<table role="presentation">` centred, **max-width 600px**, white card on a light background.
- **All styling inline** (`style="..."`); no `<style>` block, no classes (clients strip them). One small
  `@media` block for mobile column-stacking is the only stylesheet, and it degrades gracefully if ignored.
- Header: farm logo (`brand.logoUrl`, from `settings.brand.favicon.url`) if present, else the farm name as
  text. Accent line in `brand.themeColor` (fallback `#2d6a4f`).
- `button` → bulletproof table-cell button (background `themeColor`, padding, rounded via inline style).
- `columns` → two `<td>`s at 50% on desktop; the `@media (max-width:600px)` rule makes them stack 100%.
- `image`/`hero` → `width:100%; height:auto; display:block`, `alt` always set.
- Footer: "Получавате този имейл, защото сте се абонирали…" + `<a href="{unsubscribeUrl}">Отпишете се</a>` +
  farm contacts when available.
- `text` html is sanitized then inlined inside a styled wrapper (font, line-height, colour).

The **same function** renders the live preview (via a preview endpoint) and the actual send → guaranteed
WYSIWYG. `renderBroadcastHtml` (old plain renderer) is deleted once nothing references it.

Per-send efficiency: render the body once per broadcast; only the per-recipient unsubscribe URL differs, so
build the body with a `{{UNSUB}}` placeholder and string-replace per recipient (avoids re-rendering the full
HTML 5 000×).

---

## 5. API

All farmer routes tenant-scoped under the existing newsletter controller (JWT + TenantRolesGuard), mirroring
articles.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/newsletter/campaigns` | list (draft + sent), newest-first, paginated (keyset, reuse helpers) |
| `POST` | `/newsletter/campaigns` | create draft `{ subject, blocks }` |
| `GET`  | `/newsletter/campaigns/:id` | load one (for editing) |
| `PATCH`| `/newsletter/campaigns/:id` | save draft `{ subject, blocks }` (sanitize text/columns html) |
| `DELETE`| `/newsletter/campaigns/:id` | delete a draft (R2 sweep of its uploaded images by prefix) |
| `POST` | `/newsletter/campaigns/:id/images` | upload inline image → R2, returns absolute url (reuse storage) |
| `POST` | `/newsletter/campaigns/:id/preview` | render → returns `{ html }` for the preview pane |
| `POST` | `/newsletter/campaigns/:id/send` | render + send to active subscribers, meter + bill, mark `sent` |
| `GET`  | `/newsletter/quote` | `{ activeCount, perRecipientStotinki, sendCostStotinki, monthToDateCount, monthToDateStotinki }` for the cost preview |

`send` reuses the current `broadcast()` flow: billability gate, max-recipients cap, suppression filter,
per-recipient send with unsub token, then insert `email_pushes` (now with `campaign_id` + per-recipient
price) and `billPush`. On success the campaign flips to `status='sent'`, `sent_at`, `recipient_count`,
`price_stotinki`. A sent campaign is read-only (re-send = "duplicate to a new draft").

Validation: a `BlocksDto` (class-validator discriminated array) replaces the free-text `BroadcastDto.body`;
`subject` keeps `Length(1,200)`. New blocks added later must be added to the DTO union (documented gotcha,
like `slot-rule.dto.ts`).

R2 image keys follow the existing human-readable scheme: `tenants/{slug}/newsletter/{campaignId}/{file}` so
`deleteByPrefix` cleans up on campaign delete.

---

## 6. Frontend — block-builder editor

Rewrite `client/src/components/newsletter/`:

- **Campaigns list page** (`/newsletters`): "Ново съобщение" button + table of drafts/sent (subject, status,
  date, recipients, cost). Keep the subscribers table (move under a tab or below).
- **Editor page** (`/newsletters/[id]`): three regions —
  1. **Subject** input.
  2. **Block canvas**: ordered blocks, each with hover controls (move up/down via existing dnd/arrow pattern
     from catalog reorder, duplicate, delete) and an inline editor matching the block type. "+ Добави блок"
     menu lists the block types with icons. `text`/column blocks embed the existing Quill wrapper
     (`react-quill-new`, `next/dynamic ssr:false` + forwardedRef trick — already solved for articles).
     Image/hero blocks use the upload route with a drag-drop dropzone.
  3. **Live preview** (right pane / toggle on mobile): renders via the `/preview` endpoint (debounced) inside
     an `<iframe>` so email inline styles can't leak into the admin and vice-versa.
- **Auto-save** the draft (debounced PATCH) so work is never lost; explicit "Запази" too.
- **Send**: opens the confirm dialog (see §7).

Brand auto-pull: the editor shows the farm logo + theme colour in the preview by reading the existing
brand/contact data the panel already loads; no new farmer input.

---

## 7. Cost transparency — farmer

Driven by `GET /newsletter/quote`:

- **In the composer** (always visible, e.g. a small bar): "Имаш **{activeCount}** активни абоната.
  Това изпращане ще струва **€{sendCost}** (€0.55 на 1000 имейла)." Plus, when `monthToDateCount>0`: "Този
  месец: {monthToDateCount} имейла ≈ €{monthToDateStotinki}."
- **In the send-confirm dialog**: restate recipients + total cost prominently before the irreversible send,
  e.g. "Изпрати до **200** абоната — ще ти струва **€0.11**." Premium farms see "безплатно" instead.
- Numbers come from the shared `priceForRecipients` helper so preview == billed.

`monthToDate` = sum over `email_pushes` for the tenant in the current Stripe/calendar cycle
(`Europe/Sofia`), reusing the existing month-bounds approach.

---

## 8. Super-admin margin view — "колко взимам аз"

New aggregate in `PlatformInsightsService` (it already owns Sofia-tz buckets + `groupBy(sql\`1\`)`), surfaced
as a block on the existing super-admin **Анализ / `/insights`** screen.

Per the selected range, from `email_pushes`:

- emails sent (`sum(recipient_count)`), revenue (`sum(price_stotinki)` — historical, per-row),
- Resend cost (`sum(recipient_count) * EMAIL_COST_PER_RECIPIENT_MICRO / 10_000`, rounded),
- **margin** = revenue − cost, and margin % (≈50% by design at the 555/370 rates).
- A short per-farm table (top senders) + a platform total.

This is read-only and derived entirely from existing ledger data (no new tracking). It literally answers
"how much do I make on email".

---

## 9. Testing

- `billing.pricing.spec.ts` — `priceForRecipients` rounding (0, 1, 50, 200, 1000, cap), micro→stotinki.
- `newsletter.service.spec.ts` — extend: per-recipient price on `email_pushes`, premium → free, max cap,
  suppression filter still applied, campaign flips to `sent`.
- `email-render.spec.ts` — each block type renders; sanitization strips disallowed tags; unsub footer always
  present; no `<script>`/`<style class>`; absolute image urls preserved.
- `insights.service.spec.ts` — extend: email margin aggregate (revenue/cost/margin) over a range.
- Keep the full suite green; run jest / next build / server **sequentially** on this machine (known FS
  flake when parallel).

## 10. Rollout

- Env: add the two `*_MICRO` consts, remove `EMAIL_PUSH_PRICE_STOTINKI`; update `.env.example` +
  `docs/EMAIL-SETUP.md` (the "€2-per-push" language → "€0.002 per recipient"). Resend Pro $20 upgrade is an
  operational step for the owner when volume crosses the free 3k/mo cap; no code dependency.
- Migration 0042 auto-applies on API boot (production pattern).
- Docs: update `docs/admin-panel-guide.md` + in-app help (`help-content.ts`) for the new editor + pricing.
- Live E2E after build: create a campaign with several block types, preview, send to a test list, verify mail
  renders in a real client, verify the invoice item amount == quoted, verify the super-admin margin block.

## Open questions / risks

- **Logo size**: `settings.brand.favicon.url` is a small website icon; it may look low-res as an email header
  logo. Acceptable for v1 (fallback = farm-name text); a dedicated "email logo" media slot can come later.
- **Stripe tiny invoice items**: a €0.10 item is fine (it rolls into the monthly invoice), but very small
  farms will see many small line items — acceptable; could batch monthly later if noisy.
- **`columns` on old email clients**: relies on a single `@media` rule for stacking; verified-by-eye in
  Gmail/Outlook/Apple Mail during live E2E.
