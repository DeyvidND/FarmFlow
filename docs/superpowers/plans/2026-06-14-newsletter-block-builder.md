# Newsletter block-builder + per-recipient pricing + cost transparency — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat €2/broadcast newsletter with a block-based email builder (own blocks + pure server renderer), per-recipient pricing (Resend cost × 1.5 = 555 micro-€), a farmer cost-preview, and a super-admin margin view.

**Architecture:** Structured `Block[]` JSON persisted on a new `newsletter_campaigns` table; a pure server `renderEmail()` produces email-safe HTML used by BOTH the preview endpoint and the send (true WYSIWYG). Billing meters per recipient via a shared pure `priceForRecipients()` helper. Super-admin margin extends the existing `/platform/email-billing` aggregate.

**Tech Stack:** NestJS + Drizzle (Postgres) backend, Next.js (farmer `client/`, super-admin `admin/`), `react-quill-new` for rich-text blocks, `sanitize-html`, Cloudflare R2 for images, Stripe invoice items, Jest.

**Spec:** `docs/superpowers/specs/2026-06-14-newsletter-block-builder-and-pricing-design.md`

**Execution note:** Per owner preference this branch is implemented inline by Opus (plan+execute, no subagent delegation). Run jest / next build / nest build **sequentially** on this machine (known FS flake under parallel load). Tests use pnpm.

---

## File structure

**Backend (`server/`)**
- `src/modules/billing/billing.pricing.ts` — *create*: pure `priceForRecipients`, `emailCostStotinki`.
- `src/modules/billing/billing.pricing.spec.ts` — *create*.
- `src/modules/billing/billing.service.ts` — *modify*: use helper; swap `emailPriceStotinki`→`emailPricePerRecipientMicro` in `BillingSummary`; `billPush` per-recipient.
- `src/modules/newsletter/email-render.ts` — *create*: pure `renderEmail(blocks, opts)`.
- `src/modules/newsletter/email-render.spec.ts` — *create*.
- `src/modules/newsletter/newsletter.service.ts` — *modify*: campaign CRUD, `quote`, `sendCampaign`, inline image, preview; delete old `renderBroadcastHtml`/`broadcast`.
- `src/modules/newsletter/newsletter.service.spec.ts` — *modify*.
- `src/modules/newsletter/newsletter.controller.ts` — *modify*: campaign + quote + image + preview + send routes; keep `/subscribers` + `/unsubscribe`.
- `src/modules/newsletter/dto/campaign.dto.ts` — *create*: `BlocksDto` union + `UpsertCampaignDto`.
- `src/modules/newsletter/dto/upload-newsletter-media.dto.ts` — *create*: mime/size consts.
- `src/modules/newsletter/newsletter.module.ts` — *modify*: import `StorageModule`.
- `src/modules/platform/platform.service.ts` — *modify*: `emailBilling()` adds recipientTotal/cost/margin + platform total.
- `src/config/env.validation.ts` — *modify*: add the two `*_MICRO`, drop `EMAIL_PUSH_PRICE_STOTINKI`.

**Shared types (`packages/`)**
- `db/src/schema.ts` — *modify*: `newsletterCampaigns` table, `emailPushes.campaignId`.
- `db/drizzle/0042_*.sql` + `meta` — *create*: migration.
- `types/src/index.ts` — *modify*: export `Block`, `NewsletterBlock` union + `Campaign` DTO types.

**Farmer app (`client/`)**
- `src/lib/api-client.ts` — *modify*: campaign + quote + image fns.
- `src/app/(admin)/newsletters/page.tsx` — *modify*: load campaigns + subscribers.
- `src/app/(admin)/newsletters/[id]/page.tsx` — *create*: editor route.
- `src/components/newsletter/newsletter-client.tsx` — *modify/rewrite*: campaigns list + subscribers tab.
- `src/components/newsletter/campaign-editor.tsx` — *create*: subject + canvas + preview + cost bar + send.
- `src/components/newsletter/blocks/` — *create*: per-block editors + add-block menu.
- `src/components/payments/subscription-card.tsx` — *modify*: per-recipient price copy.

**Super-admin app (`admin/`)**
- `src/components/email-billing-client.tsx` — *modify*: cost + margin columns + totals.
- `src/bff/...` or api layer — *modify if needed* to pass through new fields.

**Docs**
- `.env.example`, `docs/EMAIL-SETUP.md`, `docs/admin-panel-guide.md`, `client` `help-content.ts`.

---

## Task 1: Pricing helper + config

**Files:**
- Create: `server/src/modules/billing/billing.pricing.ts`
- Create: `server/src/modules/billing/billing.pricing.spec.ts`
- Modify: `server/src/config/env.validation.ts:84-85`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/modules/billing/billing.pricing.spec.ts
import { priceForRecipients, emailCostStotinki } from './billing.pricing';

describe('newsletter pricing', () => {
  // 555 micro-€/recipient = 0.0555 stotinki; rounded to whole stotinki per send.
  it('prices a send at round(n * 555 / 10000) stotinki', () => {
    expect(priceForRecipients(0, 555)).toBe(0);
    expect(priceForRecipients(50, 555)).toBe(3);     // 2.775 → 3
    expect(priceForRecipients(200, 555)).toBe(11);   // 11.1 → 11
    expect(priceForRecipients(1000, 555)).toBe(56);  // 55.5 → 56
  });

  it('computes the Resend cost basis the same way', () => {
    expect(emailCostStotinki(1000, 370)).toBe(37);   // 37.0
    expect(emailCostStotinki(200, 370)).toBe(7);     // 7.4 → 7
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd server; pnpm jest billing.pricing -- --runInBand`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/modules/billing/billing.pricing.ts

/**
 * Newsletter per-recipient pricing. The rate is in MICRO-euros (1e-6 €) so the
 * sub-cent per-recipient figure stays integer; the per-send total is rounded to
 * whole stotinki (EUR cents). One helper for the quote AND the charge → the
 * quoted price can never drift from the billed price.
 *
 *   micro / 10_000 = stotinki   (1 stotinka = 1e-2 €, 1 micro = 1e-6 €)
 */
export function priceForRecipients(recipients: number, perRecipientMicro: number): number {
  if (recipients <= 0) return 0;
  return Math.round((recipients * perRecipientMicro) / 10_000);
}

/** Underlying Resend cost for `recipients`, in stotinki (margin view only). */
export function emailCostStotinki(recipients: number, costPerRecipientMicro: number): number {
  if (recipients <= 0) return 0;
  return Math.round((recipients * costPerRecipientMicro) / 10_000);
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd server; pnpm jest billing.pricing -- --runInBand` → PASS

- [ ] **Step 5: Update env validation**

In `server/src/config/env.validation.ts`, replace line 85 (`EMAIL_PUSH_PRICE_STOTINKI`) block:

```ts
  // Newsletter "push" abuse cap (recipients in one send).
  EMAIL_PUSH_MAX_RECIPIENTS: Joi.number().default(5000),
  // Per-recipient price in MICRO-euro (1e-6 €). 555 = €0.000555 = Resend cost × 1.5.
  EMAIL_PRICE_PER_RECIPIENT_MICRO: Joi.number().default(555),
  // Resend cost basis per recipient in MICRO-euro (~$0.0004 on the Pro $20/50k plan).
  // Used ONLY for the super-admin margin view — never charges anything.
  EMAIL_COST_PER_RECIPIENT_MICRO: Joi.number().default(370),
```

- [ ] **Step 6: Update `.env.example` + `docs/EMAIL-SETUP.md`**

In `.env.example` replace `EMAIL_PUSH_PRICE_STOTINKI=200` with:
```
EMAIL_PRICE_PER_RECIPIENT_MICRO=555   # €0.000555/recipient (Resend cost ×1.5)
EMAIL_COST_PER_RECIPIENT_MICRO=370    # Resend cost basis (margin view only)
```
In `docs/EMAIL-SETUP.md` change the `EMAIL_PUSH_PRICE_STOTINKI=200 # €2 per push` line + the "€2-per-push" prose to "€0.000555 per recipient (Resend cost ×1.5)".

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/billing/billing.pricing.ts server/src/modules/billing/billing.pricing.spec.ts server/src/config/env.validation.ts .env.example docs/EMAIL-SETUP.md
git commit -m "feat(billing): per-recipient newsletter pricing helper + config"
```

---

## Task 2: DB migration — campaigns table + email_pushes.campaign_id

**Files:**
- Modify: `packages/db/src/schema.ts` (after `emailPushes`, ~line 466)
- Create: `packages/db/drizzle/0042_*.sql` (+ snapshot via drizzle-kit)

- [ ] **Step 1: Add schema**

In `packages/db/src/schema.ts`, add a `newsletterCampaigns` table and a `campaignId` column on `emailPushes`:

```ts
export const newsletterCampaigns = pgTable('newsletter_campaigns', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  subject: text('subject').notNull().default(''),
  blocks: jsonb('blocks').notNull().default(sql`'[]'::jsonb`),
  status: text('status').notNull().default('draft'), // 'draft' | 'sent'
  recipientCount: integer('recipient_count'),
  priceStotinki: integer('price_stotinki'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => ({
  tenantUpdatedIdx: index('newsletter_campaigns_tenant_updated_idx').on(t.tenantId, t.updatedAt),
}));
```

Add to the `emailPushes` column list:
```ts
  campaignId: uuid('campaign_id').references(() => newsletterCampaigns.id),
```
(Place the `emailPushes` definition AFTER `newsletterCampaigns`, or use a forward ref — Drizzle resolves `references(() => …)` lazily, so order is fine either way; keep `newsletterCampaigns` above `emailPushes` for readability.)

Ensure `jsonb` is imported from `drizzle-orm/pg-core` (it's already used elsewhere — verify the import line includes `jsonb`).

- [ ] **Step 2: Generate migration**

Run: `cd packages/db; pnpm drizzle-kit generate`
Expected: new `0042_*.sql` + `meta/0042_snapshot.json`. Open the `.sql` and confirm it `CREATE TABLE newsletter_campaigns` + `ALTER TABLE email_pushes ADD COLUMN campaign_id` + the index. No destructive drops.

- [ ] **Step 3: Build db package**

Run: `cd packages/db; pnpm build`
Expected: dist updated (server consumes `@farmflow/db` from dist).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0042_* packages/db/drizzle/meta
git commit -m "feat(db): newsletter_campaigns table + email_pushes.campaign_id (migration 0042)"
```

---

## Task 3: Shared block types + newsletter sanitizer

**Files:**
- Modify: `packages/types/src/index.ts`
- Create: `server/src/modules/newsletter/newsletter.util.ts`
- Create: `server/src/modules/newsletter/newsletter.util.spec.ts`

- [ ] **Step 1: Add block + campaign types** to `packages/types/src/index.ts`:

```ts
// ── Newsletter block-builder ───────────────────────────────────────────────
export type NewsletterColumn =
  | { kind: 'text'; html: string }
  | { kind: 'image'; image: string; alt?: string };

export type NewsletterBlock =
  | { type: 'hero'; image: string; alt?: string; href?: string }
  | { type: 'heading'; text: string; level?: 1 | 2 }
  | { type: 'text'; html: string }
  | { type: 'image'; image: string; alt?: string; href?: string; caption?: string }
  | { type: 'button'; label: string; href: string }
  | { type: 'columns'; left: NewsletterColumn; right: NewsletterColumn }
  | { type: 'divider' }
  | { type: 'spacer'; size?: 'sm' | 'md' | 'lg' };

export interface NewsletterCampaign {
  id: string;
  subject: string;
  blocks: NewsletterBlock[];
  status: 'draft' | 'sent';
  recipientCount: number | null;
  priceStotinki: number | null;
  sentAt: string | null;
  updatedAt: string | null;
}

export interface NewsletterQuote {
  activeCount: number;
  perRecipientMicro: number;
  sendCostStotinki: number;
  monthToDateCount: number;
  monthToDateStotinki: number;
  premium: boolean;
}
```

Build types: `cd packages/types; pnpm build`.

- [ ] **Step 2: Write the failing sanitizer test**

```ts
// server/src/modules/newsletter/newsletter.util.spec.ts
import { sanitizeNewsletterHtml } from './newsletter.util';

describe('sanitizeNewsletterHtml', () => {
  it('keeps allowed rich text, strips scripts', () => {
    expect(sanitizeNewsletterHtml('<p>hi <strong>x</strong></p><script>alert(1)</script>'))
      .toBe('<p>hi <strong>x</strong></p>');
  });
  it('drops non-https img', () => {
    expect(sanitizeNewsletterHtml('<img src="http://x/a.png">')).toBe('');
  });
  it('returns empty for blank editor output', () => {
    expect(sanitizeNewsletterHtml('<p><br></p>')).toBe('');
  });
});
```

- [ ] **Step 3: Run, verify fail.** `cd server; pnpm jest newsletter.util -- --runInBand`

- [ ] **Step 4: Implement** — reuse the article allowlist (same Quill toolbar):

```ts
// server/src/modules/newsletter/newsletter.util.ts
import { sanitizeArticleHtml } from '../articles/articles.util';

/** Newsletter text-block HTML uses the same Quill toolbar + allowlist as articles. */
export function sanitizeNewsletterHtml(html: string): string {
  return sanitizeArticleHtml(html);
}
```

- [ ] **Step 5: Run, verify pass.** Then commit:

```bash
git add packages/types/src/index.ts server/src/modules/newsletter/newsletter.util.ts server/src/modules/newsletter/newsletter.util.spec.ts
git commit -m "feat(newsletter): shared block types + html sanitizer"
```

---

## Task 4: Pure email renderer

**Files:**
- Create: `server/src/modules/newsletter/email-render.ts`
- Create: `server/src/modules/newsletter/email-render.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/modules/newsletter/email-render.spec.ts
import { renderEmail, type RenderOpts } from './email-render';
import type { NewsletterBlock } from '@farmflow/types';

const opts: RenderOpts = {
  subject: 'Новини',
  brand: { logoUrl: 'https://cdn.x/logo.png', themeColor: '#2d6a4f', farmName: 'Ферма Х' },
  unsubscribeUrl: 'https://api.x/unsubscribe?token=abc',
};

describe('renderEmail', () => {
  it('renders each block type and always includes the unsubscribe footer', () => {
    const blocks: NewsletterBlock[] = [
      { type: 'hero', image: 'https://cdn.x/h.jpg', alt: 'hero' },
      { type: 'heading', text: 'Здравей', level: 1 },
      { type: 'text', html: '<p>Текст</p>' },
      { type: 'button', label: 'Виж', href: 'https://shop.x' },
      { type: 'divider' },
    ];
    const html = renderEmail(blocks, opts);
    expect(html).toContain('https://cdn.x/h.jpg');
    expect(html).toContain('Здравей');
    expect(html).toContain('https://shop.x');
    expect(html).toContain('https://api.x/unsubscribe?token=abc');
    expect(html).toContain('Отпиши'); // footer copy
  });

  it('produces no <script> and strips disallowed tags in text blocks', () => {
    const html = renderEmail([{ type: 'text', html: '<p>ok</p><script>bad()</script>' }], opts);
    expect(html).not.toContain('<script>');
    expect(html).toContain('ok');
  });

  it('applies the brand theme colour to buttons', () => {
    const html = renderEmail([{ type: 'button', label: 'X', href: 'https://x' }], opts);
    expect(html).toContain('#2d6a4f');
  });

  it('uses farm-name text header when no logo', () => {
    const html = renderEmail([], { ...opts, brand: { ...opts.brand, logoUrl: undefined } });
    expect(html).toContain('Ферма Х');
  });
});
```

- [ ] **Step 2: Run, verify fail.** `cd server; pnpm jest email-render -- --runInBand`

- [ ] **Step 3: Implement** the renderer. Email-safe: outer presentation table, 600px, **all inline styles**, one `@media` for column stacking, bulletproof button, non-deletable footer with `{unsubscribeUrl}`. Sanitize text/column html via `sanitizeNewsletterHtml`. HTML-escape `heading.text`, `button.label`, `image.alt`, `caption`. Fallback theme `#2d6a4f`.

```ts
// server/src/modules/newsletter/email-render.ts
import type { NewsletterBlock, NewsletterColumn } from '@farmflow/types';
import { sanitizeNewsletterHtml } from './newsletter.util';

export interface RenderOpts {
  subject: string;
  brand: { logoUrl?: string; themeColor: string; farmName: string };
  contact?: { line?: string } | null;
  unsubscribeUrl: string;
}

const esc = (s: string): string =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SPACER = { sm: 12, md: 24, lg: 40 } as const;

function block(b: NewsletterBlock, theme: string): string {
  switch (b.type) {
    case 'hero':
      return img(b.image, b.alt, b.href, '100%');
    case 'heading': {
      const size = b.level === 2 ? 20 : 26;
      return `<tr><td style="padding:8px 24px;font-family:Arial,sans-serif;font-size:${size}px;font-weight:700;color:#1a1a1a;line-height:1.3">${esc(b.text)}</td></tr>`;
    }
    case 'text':
      return `<tr><td style="padding:8px 24px;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#333">${sanitizeNewsletterHtml(b.html)}</td></tr>`;
    case 'image':
      return img(b.image, b.alt, b.href, '100%', b.caption);
    case 'button':
      return `<tr><td style="padding:16px 24px" align="left"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:8px;background:${theme}"><a href="${esc(b.href)}" target="_blank" style="display:inline-block;padding:12px 28px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#fff;text-decoration:none">${esc(b.label)}</a></td></tr></table></td></tr>`;
    case 'columns':
      return `<tr><td style="padding:8px 24px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>`
        + `<td class="ff-col" width="50%" valign="top" style="padding-right:8px">${col(b.left)}</td>`
        + `<td class="ff-col" width="50%" valign="top" style="padding-left:8px">${col(b.right)}</td>`
        + `</tr></table></td></tr>`;
    case 'divider':
      return `<tr><td style="padding:8px 24px"><div style="border-top:1px solid #e5e5e5"></div></td></tr>`;
    case 'spacer':
      return `<tr><td style="height:${SPACER[b.size ?? 'md']}px;line-height:0">&nbsp;</td></tr>`;
  }
}

function col(c: NewsletterColumn): string {
  return c.kind === 'text'
    ? `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333">${sanitizeNewsletterHtml(c.html)}</div>`
    : (/^https:\/\//i.test(c.image) ? `<img src="${esc(c.image)}" alt="${esc(c.alt ?? '')}" style="width:100%;height:auto;display:block;border:0" />` : '');
}

function img(src: string, alt = '', href?: string, width = '100%', caption?: string): string {
  if (!/^https:\/\//i.test(src)) return '';
  const tag = `<img src="${esc(src)}" alt="${esc(alt)}" width="600" style="width:${width};max-width:100%;height:auto;display:block;border:0" />`;
  const wrapped = href ? `<a href="${esc(href)}" target="_blank">${tag}</a>` : tag;
  const cap = caption ? `<div style="padding:6px 0 0;font-family:Arial,sans-serif;font-size:12px;color:#888">${esc(caption)}</div>` : '';
  return `<tr><td style="padding:8px 24px">${wrapped}${cap}</td></tr>`;
}

export function renderEmail(blocks: NewsletterBlock[], opts: RenderOpts): string {
  const theme = opts.brand.themeColor || '#2d6a4f';
  const header = opts.brand.logoUrl
    ? `<img src="${esc(opts.brand.logoUrl)}" alt="${esc(opts.brand.farmName)}" height="40" style="height:40px;width:auto;display:block;border:0" />`
    : `<span style="font-family:Arial,sans-serif;font-size:20px;font-weight:800;color:${theme}">${esc(opts.brand.farmName)}</span>`;
  const body = blocks.map((b) => block(b, theme)).join('');
  const contactLine = opts.contact?.line ? `<p style="margin:0 0 8px">${esc(opts.contact.line)}</p>` : '';

  return `<!DOCTYPE html>
<html lang="bg"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.subject)}</title>
<style>@media (max-width:600px){.ff-col{display:block!important;width:100%!important;padding:8px 0!important}}</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f2">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:600px;max-width:100%;background:#fff;border-radius:12px;overflow:hidden">
  <tr><td style="padding:20px 24px;border-bottom:3px solid ${theme}">${header}</td></tr>
  ${body}
  <tr><td style="padding:24px;border-top:1px solid #eee;font-family:Arial,sans-serif;font-size:12px;color:#999;line-height:1.5">
    ${contactLine}
    <p style="margin:0 0 8px">Получавате този имейл, защото сте се абонирали за новини от фермата.</p>
    <p style="margin:0"><a href="${esc(opts.unsubscribeUrl)}" style="color:#999">Отпиши се от абонамента</a></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
```

- [ ] **Step 4: Run, verify pass.** `cd server; pnpm jest email-render -- --runInBand`

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/newsletter/email-render.ts server/src/modules/newsletter/email-render.spec.ts
git commit -m "feat(newsletter): pure email-safe block renderer"
```

---

## Task 5: Billing — per-recipient charge

**Files:**
- Modify: `server/src/modules/billing/billing.service.ts`
- Modify: `server/src/modules/billing/billing.service.spec.ts` (if present; else add a focused spec)

- [ ] **Step 1: Update `BillingSummary`** — replace `emailPriceStotinki` with `emailPricePerRecipientMicro`:

```ts
  basePriceStotinki: number;
  emailPricePerRecipientMicro: number; // per-recipient newsletter price (micro-€)
```

- [ ] **Step 2: Update constructor + summary** — replace `this.emailPrice` reads:

```ts
  private readonly emailPerRecipientMicro: number;
  // …in constructor:
  this.emailPerRecipientMicro = config.get<number>('EMAIL_PRICE_PER_RECIPIENT_MICRO', 555);
```
In `summary()` base object set `emailPricePerRecipientMicro: this.emailPerRecipientMicro` (drop the old `emailPriceStotinki`).

- [ ] **Step 3: Update `billPush`** to charge per recipient via the helper:

```ts
import { priceForRecipients } from './billing.pricing';
// …inside billPush, replace `amount: this.emailPrice` with:
const amount = priceForRecipients(push.recipientCount, this.emailPerRecipientMicro);
if (amount <= 0) return; // nothing to bill (e.g. 0 recipients)
// …then invoiceItems.create({ ..., amount, ... })
```
The `emailPushes` row's `priceStotinki` is now set by the newsletter service (Task 6) to the same `priceForRecipients(...)` value, so `billPush` and the ledger agree.

- [ ] **Step 4: Spec** — add/extend a billing test asserting `billPush` uses `recipientCount × rate` (mock the Stripe `invoiceItems.create` and assert the `amount`). Premium → no invoice item.

- [ ] **Step 5: Run** `cd server; pnpm jest billing.service -- --runInBand` → PASS. Commit:

```bash
git add server/src/modules/billing/billing.service.ts server/src/modules/billing/billing.service.spec.ts
git commit -m "feat(billing): charge newsletters per recipient (555 micro)"
```

---

## Task 6: Newsletter service — campaigns, quote, send, images, preview

**Files:**
- Modify: `server/src/modules/newsletter/newsletter.service.ts`
- Modify: `server/src/modules/newsletter/newsletter.service.spec.ts`
- Create: `server/src/modules/newsletter/dto/campaign.dto.ts`
- Create: `server/src/modules/newsletter/dto/upload-newsletter-media.dto.ts`

- [ ] **Step 1: DTOs.**

```ts
// dto/upload-newsletter-media.dto.ts
import { ApiProperty } from '@nestjs/swagger';
export const NEWSLETTER_IMG_MIME_REGEX = /^(image\/(jpeg|png|webp))$/;
export const NEWSLETTER_IMG_MAX_BYTES = 8 * 1024 * 1024;
export class UploadNewsletterMediaDto {
  @ApiProperty({ type: 'string', format: 'binary' }) file: unknown;
}
```

```ts
// dto/campaign.dto.ts
import { IsString, Length, IsArray, ValidateNested, IsIn, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import type { NewsletterBlock } from '@farmflow/types';

// Pragmatic validation: subject is strict; blocks validated as an array whose
// items each have a known `type`. Deep per-block validation happens at render via
// the sanitizer + the typed union (server controls the editor). Cap array size.
class BlockShape { @IsString() @IsIn(['hero','heading','text','image','button','columns','divider','spacer']) type: string; }

export class UpsertCampaignDto {
  @IsString() @Length(0, 200) subject: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => BlockShape)
  blocks: NewsletterBlock[];
}
```
> Gotcha (like `slot-rule.dto.ts`): blocks are stored as JSON; the whitelist only checks `type`. The render path sanitizes all html and ignores unknown fields, so a malformed block degrades safely.

- [ ] **Step 2: Failing service tests** (extend `newsletter.service.spec.ts`): `createCampaign` → draft row; `sendCampaign` → meters `recipientCount`, sets `priceStotinki = priceForRecipients(n,555)`, flips `status='sent'`, calls `billing.billPush`; premium → price 0; over-cap → 400; suppression filtered; `quote` returns activeCount + sendCostStotinki + monthToDate.

- [ ] **Step 3: Implement service methods.** Inject `StorageService` + `TenantsService` (or read brand inline). Key methods:

```ts
// listCampaigns(tenantId, {cursor,limit}) — keyset on (updatedAt,id) desc, reuse helpers
// getCampaign(id, tenantId) — scope-checked 404
// createCampaign(tenantId, dto) — insert {subject, blocks: sanitized}
// updateCampaign(id, tenantId, dto) — guard status!=='sent'; sanitize text/column html; set updatedAt
// deleteCampaign(id, tenantId) — guard; storage.deleteByPrefix(`tenants/${slug}/newsletter/${id}/`)
// addInlineImage(id, tenantId, file) — optimizeImage → upload key `tenants/${slug}/newsletter/${id}/${uuid}.${ext}` → {url}
// preview(id, tenantId) — render with a dummy unsubscribeUrl → {html}
// quote(tenantId) — {activeCount, perRecipientMicro, sendCostStotinki=priceForRecipients(activeCount), monthToDateCount, monthToDateStotinki, premium}
// sendCampaign(id, tenantId) — see below
```

`sendCampaign` reuses the current `broadcast()` body but driven by a campaign:
1. `isBillable` gate (same 400 copy).
2. Load campaign (must be `draft`), build `RenderOpts` from `settings.brand` (logo=`brand.favicon.url`, themeColor, farmName=tenant.name) + contact line.
3. Fetch active subscribers capped at `maxRecipients+1`; over → 400.
4. Suppression filter (unchanged).
5. Render body ONCE with a `{{UNSUB}}` placeholder; per recipient: `html = body.replace('{{UNSUB}}', unsubUrl)` (cheap), `sendMail({stream:'bulk', skipSuppressionCheck:true})`.
6. `priceStotinki = priceForRecipients(recipients.length, perRecipientMicro)`; insert `emailPushes {tenantId, campaignId:id, subject, recipientCount, priceStotinki}`; `billing.billPush(push.id)`.
7. Update campaign `{status:'sent', sentAt, recipientCount, priceStotinki}`.
8. Return `{sent, recipients}`.

Delete the old `broadcast()` + `renderBroadcastHtml()` + the `nl2br`/`escapeHtml` helpers (now unused). Keep `getSubscribers`, `unsubscribe`, `unsubSecret`.

`monthToDate`: sum `recipientCount`/`priceStotinki` from `emailPushes` where `tenantId` and `createdAt >=` start-of-month (Europe/Sofia — reuse `bgDayBounds`/month logic from `bg-time`).

The `{{UNSUB}}` placeholder must be injected by `renderEmail` — pass `unsubscribeUrl: '{{UNSUB}}'` for the send path; for `preview` pass a real sample URL. (Placeholder is URL-position only; it sits inside `href="{{UNSUB}}"`.)

- [ ] **Step 4: Run** `cd server; pnpm jest newsletter -- --runInBand` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/newsletter/
git commit -m "feat(newsletter): campaign CRUD + quote + per-recipient send"
```

---

## Task 7: Controller + module wiring

**Files:**
- Modify: `server/src/modules/newsletter/newsletter.controller.ts`
- Modify: `server/src/modules/newsletter/newsletter.module.ts`

- [ ] **Step 1: Module** — add `StorageModule` to imports:

```ts
import { StorageModule } from '../storage/storage.module';
// imports: [AuthModule, BillingModule, StorageModule],
```

- [ ] **Step 2: Controller routes** (all under existing controller; farmer routes guarded `JwtAuthGuard` + `ActiveSubscriptionGuard` where they mutate/send; mirror articles for the image upload validators):

```ts
@Get('newsletter/campaigns')        // list (PaginationQueryDto)
@Post('newsletter/campaigns')       // create (UpsertCampaignDto) + ActiveSubscriptionGuard
@Get('newsletter/campaigns/:id')    // getCampaign
@Patch('newsletter/campaigns/:id')  // update (UpsertCampaignDto) + ActiveSubscriptionGuard
@Delete('newsletter/campaigns/:id') // delete
@Post('newsletter/campaigns/:id/images')  // FileInterceptor + ParseFilePipe(NEWSLETTER_IMG_*) → addInlineImage
@Post('newsletter/campaigns/:id/preview') // preview → {html}
@Post('newsletter/campaigns/:id/send')    // sendCampaign + ActiveSubscriptionGuard
@Get('newsletter/quote')            // quote
```
Keep `/subscribers` and `/unsubscribe` exactly as-is. Remove the old `@Post('broadcast')`.

- [ ] **Step 3: Build** `cd server; pnpm build` → no TS errors. Commit:

```bash
git add server/src/modules/newsletter/newsletter.controller.ts server/src/modules/newsletter/newsletter.module.ts
git commit -m "feat(newsletter): campaign + quote + image + send routes"
```

---

## Task 8: Super-admin margin view (backend)

**Files:**
- Modify: `server/src/modules/platform/platform.service.ts:48` (type) + `:202-218` (`emailBilling`)
- Modify: `server/src/modules/platform/platform.service.spec.ts`

- [ ] **Step 1: Extend `PlatformEmailBillingRow`** (line 48 area) with:

```ts
  recipientTotal: number;
  costStotinki: number;
  marginStotinki: number;
```
And add a wrapper return type with a platform total:
```ts
export interface PlatformEmailBilling {
  rows: PlatformEmailBillingRow[];
  totals: { recipientTotal: number; revenueStotinki: number; costStotinki: number; marginStotinki: number };
}
```

- [ ] **Step 2: Update `emailBilling()`** to also `sum(recipient_count)`, then compute cost+margin per row and totals using `emailCostStotinki` (import from billing.pricing) with `EMAIL_COST_PER_RECIPIENT_MICRO` (inject `ConfigService` if not already). Return `{ rows, totals }`.

```ts
recipientTotal: sql<number>`coalesce(sum(${emailPushes.recipientCount}),0)::int`,
// after fetch: row.costStotinki = emailCostStotinki(row.recipientTotal, costMicro);
//             row.marginStotinki = row.totalStotinki - row.costStotinki;
```

- [ ] **Step 3: Spec** — assert revenue/cost/margin for a known set of pushes. Run `pnpm jest platform.service -- --runInBand` → PASS.

- [ ] **Step 4: Build + commit**

```bash
git add server/src/modules/platform/platform.service.ts server/src/modules/platform/platform.service.spec.ts
git commit -m "feat(platform): email-billing margin (revenue/cost/margin)"
```

---

## Task 9: Farmer api-client functions

**Files:**
- Modify: `client/src/lib/api-client.ts`

- [ ] **Step 1: Replace `sendBroadcast`** and add campaign fns (mirror `uploadArticleInlineImage` for the multipart upload). Use the `NewsletterCampaign`/`NewsletterQuote`/`NewsletterBlock` types from `@farmflow/types` (or local mirror if `client` doesn't consume that package — check existing imports; articles types are local, so add local mirrors here):

```ts
export interface NewsletterBlock { /* mirror of @farmflow/types union */ }
export interface NewsletterCampaign { id: string; subject: string; blocks: NewsletterBlock[]; status: 'draft'|'sent'; recipientCount: number|null; priceStotinki: number|null; sentAt: string|null; updatedAt: string|null; }
export interface NewsletterQuote { activeCount: number; perRecipientMicro: number; sendCostStotinki: number; monthToDateCount: number; monthToDateStotinki: number; premium: boolean; }

export const listCampaigns = (cursor?: string) =>
  apiFetch<Paginated<NewsletterCampaign>>(`newsletter/campaigns${cursor ? `?cursor=${cursor}` : ''}`);
export const getCampaign = (id: string) => apiFetch<NewsletterCampaign>(`newsletter/campaigns/${id}`);
export const createCampaign = (data: { subject: string; blocks: NewsletterBlock[] }) =>
  apiFetch<NewsletterCampaign>('newsletter/campaigns', { method: 'POST', ...json(data) });
export const updateCampaign = (id: string, data: { subject: string; blocks: NewsletterBlock[] }) =>
  apiFetch<NewsletterCampaign>(`newsletter/campaigns/${id}`, { method: 'PATCH', ...json(data) });
export const deleteCampaign = (id: string) =>
  apiFetch<void>(`newsletter/campaigns/${id}`, { method: 'DELETE' });
export const previewCampaign = (id: string) =>
  apiFetch<{ html: string }>(`newsletter/campaigns/${id}/preview`, { method: 'POST' });
export const sendCampaign = (id: string) =>
  apiFetch<{ sent: number; recipients: number }>(`newsletter/campaigns/${id}/send`, { method: 'POST' }, 'Неуспешно изпращане');
export const getQuote = () => apiFetch<NewsletterQuote>('newsletter/quote');
export function uploadCampaignInlineImage(id: string, file: File) { /* mirror uploadArticleInlineImage, path newsletter/campaigns/${id}/images */ }
```

- [ ] **Step 2: Build** `cd client; pnpm build` (or `pnpm tsc --noEmit`). Commit:

```bash
git add client/src/lib/api-client.ts
git commit -m "feat(newsletter): farmer api-client campaign functions"
```

---

## Task 10: Farmer block-builder UI

**Files:**
- Modify: `client/src/app/(admin)/newsletters/page.tsx`
- Create: `client/src/app/(admin)/newsletters/[id]/page.tsx`
- Rewrite: `client/src/components/newsletter/newsletter-client.tsx`
- Create: `client/src/components/newsletter/campaign-editor.tsx`
- Create: `client/src/components/newsletter/blocks/*` (block editors + add menu)
- Create: `client/src/components/newsletter/quill-block.tsx` (reuse article quill wrapper)

This task is UI; build incrementally and verify via `preview_*` after wiring. Sub-steps:

- [ ] **Step 1: Campaigns list.** `newsletters/page.tsx` loads campaigns (server fetch like subscribers) + subscriber counts; `newsletter-client.tsx` becomes two tabs: **Бюлетини** (campaigns table: тема, статус, дата, получатели, цена; "Ново съобщение" → POST create → router.push to `[id]`) and **Абонати** (existing subscribers table).

- [ ] **Step 2: Editor shell.** `[id]/page.tsx` loads the campaign server-side, renders `<CampaignEditor campaign=… />`. Editor holds `subject` + `blocks` state, debounced auto-save (`updateCampaign`), explicit "Запази", and a cost bar driven by `getQuote()`.

- [ ] **Step 3: Block canvas.** Render `blocks` with per-block controls (move up/down — reuse the catalog reorder arrow pattern; duplicate; delete) + an inline editor per `type`. "+ Добави блок" dropdown lists the 8 types with lucide icons. Each block gets a client `id` (crypto.randomUUID) for React keys; strip `id` before save.

- [ ] **Step 4: Block editors** (`blocks/`):
  - `text` / column-text → `quill-block.tsx` (dynamic import of the SAME `articles/quill-wrapper` via `next/dynamic ssr:false`; image handler → `uploadCampaignInlineImage`).
  - `heading` → input + level toggle. `button` → label + href inputs. `hero`/`image` → drag-drop dropzone → `uploadCampaignInlineImage` → store url; `image` adds alt/caption/href. `columns` → two sub-editors (text|image). `divider`/`spacer` → size select.

- [ ] **Step 5: Live preview.** Right pane (toggle on mobile): debounced `previewCampaign(id)` after auto-save, render returned `html` inside an `<iframe srcDoc={html}>` (isolates email styles).

- [ ] **Step 6: Cost bar + send.** Bar: "Имаш **{activeCount}** активни абоната. Това изпращане ще струва **€{send}** (€0.55 на 1000 имейла)." + month-to-date when >0; premium → "безплатно". "Изпрати" opens confirm dialog restating recipients + €cost → `sendCampaign(id)` → toast + back to list.

- [ ] **Step 7: Verify** with `preview_*`: create campaign, add hero+heading+text+button, confirm iframe preview renders, cost bar shows a number. Fix issues from source. Commit:

```bash
git add client/src/app/(admin)/newsletters client/src/components/newsletter
git commit -m "feat(newsletter): block-builder editor + cost preview UI"
```

---

## Task 11: Farmer Payments card copy

**Files:**
- Modify: `client/src/components/payments/subscription-card.tsx:93-95`

- [ ] **Step 1:** Replace the per-push line. `summary.emailPriceStotinki` no longer exists; use `summary.emailPricePerRecipientMicro` and show "€0.55 на 1000 имейла" (compute `(micro/1000*1000)`… simply: `€${(micro/10).toFixed(2)} на 1000`? — micro 555 → €0.555/1000 ≈ €0.55). Hardcode the display string from the field: `(perRecipientMicro/1000).toFixed(2)` gives €0.56/1000 — round to 2dp). Update the BillingSummary type import accordingly.

```tsx
<div className="mt-0.5 text-[12.5px] text-ff-muted">
  + €{(summary.emailPricePerRecipientMicro / 1000).toFixed(2)} на 1000 изпратени имейла
</div>
```

- [ ] **Step 2:** `cd client; pnpm tsc --noEmit` → green. Commit:

```bash
git add client/src/components/payments/subscription-card.tsx
git commit -m "feat(billing): farmer card shows per-recipient email price"
```

---

## Task 12: Super-admin margin UI

**Files:**
- Modify: `admin/src/components/email-billing-client.tsx`
- Modify: any `admin` bff/api passthrough for `/platform/email-billing` (check `admin/src/bff`/api-client for the existing shape — it now returns `{rows, totals}` instead of an array).

- [ ] **Step 1:** Update the fetch/type to `{ rows, totals }`. Add columns: получатели (recipientTotal), приход (totalStotinki), cost (costStotinki), **марж** (marginStotinki + %). Add a totals row/summary card: "Общо: X имейла · приход €Y · cost €Z · **марж €W (≈50%)**". This is "колко взимам аз".

- [ ] **Step 2:** `cd admin; pnpm tsc --noEmit` (or build) → green. Verify via preview if running. Commit:

```bash
git add admin/src/components/email-billing-client.tsx admin/src/bff admin/src/lib 2>/dev/null
git commit -m "feat(admin): email-billing margin columns + totals"
```

---

## Task 13: Docs + help

**Files:**
- Modify: `docs/admin-panel-guide.md` (newsletter section → block editor + per-recipient pricing)
- Modify: `client` `help-content.ts` (find via grep) — newsletter screen explanation + pricing

- [ ] **Step 1:** Rewrite the newsletter portions to describe the block editor, the per-recipient price ("€0.55 на 1000 имейла"), and the cost-before-send. Commit:

```bash
git add docs/admin-panel-guide.md client/src/**/help-content.ts
git commit -m "docs(newsletter): block editor + per-recipient pricing"
```

---

## Task 14: Full verification

- [ ] **Step 1:** Backend: `cd server; pnpm jest -- --runInBand` → all green.
- [ ] **Step 2:** `cd server; pnpm build` → green.
- [ ] **Step 3:** `cd client; pnpm build` → green. `cd admin; pnpm build` → green. (Run sequentially.)
- [ ] **Step 4: Live E2E** (start API with built db/types dist + `node dist/main.js`; farmer panel): create a campaign with hero/heading/text/image/button/columns, save, preview renders in iframe, send to a small seeded subscriber list; verify (a) mail lands and renders in a real client, (b) the Stripe invoice item amount == quoted `sendCostStotinki`, (c) `email_pushes` row has correct `recipient_count`+`price_stotinki`+`campaign_id`, (d) super-admin email-billing shows revenue/cost/margin and the ~50% total.
- [ ] **Step 5:** Update the relevant memory file after merge.

---

## Self-review notes

- **Spec coverage:** pricing (T1,T5), data model (T2), blocks (T3), renderer (T4), service/API (T6,T7), farmer transparency (T6 quote + T10 UI), super-admin margin (T8,T12), Payments card (T11), docs (T1,T13). All spec sections mapped.
- **Type consistency:** `priceForRecipients(recipients, perRecipientMicro)` used identically in T1/T5/T6; `emailCostStotinki` in T1/T8; `NewsletterBlock`/`NewsletterCampaign`/`NewsletterQuote` defined in T3 and consumed in T6/T9/T10; `emailPricePerRecipientMicro` replaces `emailPriceStotinki` in T5/T11.
- **Known gotchas baked in:** new block fields must be added to `campaign.dto.ts` whitelist; Quill needs `next/dynamic ssr:false`; run tests/builds sequentially; campaigns store JSON (shallow DTO validation + render-time sanitize); `email_pushes` stays the immutable billing ledger (historical price preserved per row).
