# FarmFlow Storefront — Build Prompts (third-party farm websites)

Turns the static HTML skeletons in `docs/FarmFlow Templates/` into a **real, backend-wired
storefront** — the customer-facing "third-party website" each farm runs. Same 3-pass discipline
as `docs/farmflow-prompts.md`: **DB → Backend → Frontend**, one feature end-to-end before the next,
each prompt = one Claude Code task.

Tech: NestJS + Drizzle + Redis + Postgres (already built) · Next.js 14 (App Router) + the template's
design tokens · Stripe Connect (per-farm) · all money = integer **stotinki** · all UI copy **Bulgarian**.

---

## 0. What this is — read before any prompt

The admin panel + API (`server`, `client`, `admin`, `packages/*`) is **done** (Features 0–7 + articles +
newsletter + platform super-admin, per memory). This doc builds the **storefront** that sits on top of the
**public API** and replaces every hardcoded demo array in the templates with live data.

### Integration model (do not violate)
- The storefront is a **catalog + order intake** client. It reads the catalog and **posts orders**; it does
  **not** touch any tenant-auth (Bearer) route.
- Payment runs on **the farm's own Stripe** via **Stripe Connect** (`tenants.stripe_account_id`). FarmFlow's
  backend creates the payment on the connected account and reconciles via `POST /stripe/webhook`.
- `tenants.subscription_status` = the farm's SaaS sub to FarmFlow — unrelated to the customer's payment.
  Public routes stay live even when a farm is `inactive` (storefront keeps taking orders).

### The only backend surface the storefront uses (public, CORS `*`, no API key)
| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/public/:slug/products` | — | `PublicProduct[]` (no `tenantId`/`stockQuantity`), Redis-cached 300s |
| GET | `/public/:slug/slots` | `?date=YYYY-MM-DD` | available slots only (`remaining>0`); `[]` if `delivery_enabled=false` |
| POST | `/public/:slug/orders` | `CreateOrderDto` | created order; **409** on slot over-capacity (row-locked) |
| GET | `/public/:slug/articles` | — | `PublicArticle[]` |
| GET | `/public/:slug/articles/:articleSlug` | — | one `PublicArticle` |

`CreateOrderDto` = `{ items:[{productId,quantity}] (min 1), customerName?, customerPhone?, customerEmail?,
slotId?(uuid), deliveryType?('address'|'econt'), deliveryAddress?, econtOffice?, notes? }`. Order intake snapshots
name+price server-side, row-locks the slot, computes total, status `pending`.

### Backend gaps this doc must close (everything else already exists)
1. **Stripe payment + catalog sync** — `/stripe/webhook` is a `NotImplementedException` stub; there is **no**
   create-payment endpoint and **no** product→Stripe price sync. (Feature S6.)
2. **Public single product by slug** — public products is list-only; product detail needs a lookup, and
   `products` has no `slug` column yet. (Feature S2 DB.)
3. **Bundles** — no bundle model; templates show curated bundles with a contents list. (Feature S3 — decision below.)
4. **Newsletter + contact intake** — `newsletter_subscribers` table exists but no **public POST**; contact form
   has no sink. (Feature S9.)
5. **Reviews** — `reviews.html` exists; no reviews table/endpoint. (Feature S10.)

### Open decisions — resolve before S2/S3/S6 (defaults in **bold**)
- **Where the storefront lives:** **a new `storefront/` Next.js app in the monorepo**, multi-tenant by slug
  (`/?slug=` or `STOREFRONT_SLUG` env per deploy), themeable — vs. a separate repo. Default keeps one codebase,
  deployed per farm.
- **Bundles model:** **products with `category='bundle'` + a `bundle_items jsonb`** (contents list) — vs. a
  dedicated `bundles` table. Default reuses the catalog + Stripe sync for free.
- **Stripe flow:** **Stripe Checkout Session on the connected account, `line_items` from synced `stripe_price_id`**
  (the "Stripe catalog") — vs. Payment Element + PaymentIntent embedded in `checkout.html`. Default = redirect to
  Stripe-hosted page (less PCI surface, matches "страйп каталога").
- **Product URL key:** **add `products.slug`** (unique per tenant) and route `/product/[slug]` — vs. UUID in URL.
- **Content pages (about/contact/faq):** **static MVP from the template copy, with the contact form wired**
  — vs. tenant-editable CMS (defer).

---

## Conventions (every prompt)
- **3 passes:** DB (migration, ADD-only — never redefine baseline) → Backend (fill stubs / add modules,
  tenant-scoped writes, public reads) → Frontend (rebuild the matching `*.html` template **pixel-perfect** in
  Next, then wire to the public API). Finish one feature fully before the next.
- **Design source of truth = the template files** in this folder (`assets/theme.css`, `main.css`,
  `home-themes.css`, `app.js`). Keep the 3 themes (`priroda`/`svezho`/`klasik` via `data-theme`), the promo bar,
  the drawer, the toast, the qty steppers, the FAQ accordion, the category chips. Port `app.js` logic into React
  (hooks/components), don't ship the IIFE.
- **Money:** integer stotinki in transit; display `FFmoney` = `"6,50 лв"` (comma + ` лв`). The API already
  returns stotinki — divide by 100 only for display.
- **Copy:** Bulgarian, `<html lang="bg">`. Reuse the exact strings in the templates.
- **Cart:** stays client-side (localStorage `ff_cart`), but typed and React-state-backed. Items reference real
  `productId` so checkout can post them.
- **Verify** each feature: real API call (curl the public endpoint), `next build`, and a rendered page. Mind the
  env gotchas in memory (preview runs `next start` → rebuild to see changes; re-seed rotates ids).

---

## Feature S0 — Storefront app scaffold

**DB:** none.

**Backend:** none.

**Frontend prompt:**
> Stand up a new `storefront/` Next.js 14 app (App Router, TS, Tailwind) in the pnpm/turbo workspace, mirroring
> how `client/` was scaffolded. Add `storefront` to `pnpm-workspace.yaml` and turbo. Package name `@farmflow/storefront`.
> Port the template's design system: copy `assets/theme.css` + `main.css` + `home-themes.css` into `globals.css`
> (or `app/styles/*`), load the same Google fonts (Lora, Commissioner, Onest, Cormorant Garamond, Mulish) via
> `next/font`, and set `data-theme` on `<html>` from a cookie/localStorage with the same inline no-flash script.
> Create `lib/api.ts` with a typed public-API client: `getProducts(slug)`, `getSlots(slug, date?)`,
> `createOrder(slug, dto)`, `getArticles(slug)`, `getArticle(slug, articleSlug)` — base URL from
> `NEXT_PUBLIC_API_URL` (default `http://localhost:3001`), no auth header. Tenant slug resolution: `STOREFRONT_SLUG`
> env (single-farm deploy) with `?slug=` override for local testing. Stub a root layout that renders nothing yet.
> **Done when:** `pnpm --filter @farmflow/storefront build` passes and `lib/api.ts` can `getProducts` against the
> seeded demo farm (`ferma-petrovi`).

**Acceptance:** app builds; `curl /public/ferma-petrovi/products` shape matches the `PublicProduct` type imported
from `@farmflow/types`.

---

## Feature S1 — Shell: header / promo / footer / drawer / theme bar / toast

**Frontend prompt:**
> Rebuild the shared chrome from `assets/app.js` as React. Components: `<SiteHeader active=>` (brand + `NAV`
> links + search/cart/hamburger, cart-count badge from cart store), dismissible `<PromoBar>` (localStorage
> `ff_promo_closed`), `<MobileDrawer>`, `<SiteFooter>` (shop/info/contact columns from the template), `<ThemeBar>`
> (3 themes, persists `ff_theme`), and a `toast()` helper replacing `flyToast`. Pull farm name / phone / email /
> socials from `GET /public/:slug` *if* a public tenant endpoint exists — otherwise from `STOREFRONT_*` env for now
> (flag: a `GET /public/:slug` profile endpoint would remove the hardcoded `FARM/PHONE/EMAIL`; add it in S9 if
> wanted). Keep the "Опционални модули" toggle behavior only if you keep optional-module sections; otherwise drop it.
> **Done when:** every page renders header+footer, theme switching works across reloads, cart badge reflects the
> cart store, drawer opens on mobile.

**Acceptance:** visual parity with the template header/footer in all 3 themes; no console errors.

---

## Feature S2 — Catalog: products list + product detail (live)

**DB prompt:**
> Add `products.slug` (text) — unique per tenant (`unique(tenant_id, slug)`), backfilled from a slugified name on
> migration; keep it nullable-safe but populate the seed. ADD-only migration. Rebuild `@farmflow/db` + `@farmflow/types` dist.

**Backend prompt:**
> Extend the public products surface: keep `GET /public/:slug/products` (now includes `slug` + `category` in
> `PublicProduct`) and add `GET /public/:slug/products/:productSlug` → single active product or 404. Reuse the
> Redis catalog cache. Confirm `category` values map to the storefront chips (`fruit`/`syrup`/`jam`/`bundle`);
> if the admin uses Bulgarian categories (Плодове/Преработени), add a `category` enum/normalizer so the storefront
> can filter. Tenant-scoped, public read, no auth.

**Frontend prompt (rewrite `products.html` + `product.html`):**
> Rebuild the catalog grid and product detail pages from the templates, but source data from
> `getProducts(slug)` / `getProduct(slug, productSlug)`. Replace the hardcoded `PRODUCTS`/`related` arrays.
> Keep the category chips (`data-tabs` behavior → React state filter by `category`), the card layout, qty stepper,
> and `data-add-cart` → cart store with the real `productId`, `name`, `price` (stotinki→display), `weight`,
> `image`. Product detail: gallery, price, "Берем в деня на доставката" note, stepper + add-to-cart, info card,
> related = same category minus current. Image fallback to the `.ph` placeholder when `imageUrl` is null.
> **Done when:** grid + detail render seeded products live; chips filter; add-to-cart populates the cart.

**Acceptance:** product count/prices match `curl /public/ferma-petrovi/products`; `/product/<slug>` 404s on unknown slug.

---

## Feature S3 — Bundles (curated)

**DB prompt (per default decision — adjust if you pick a `bundles` table):**
> Add `products.bundle_items jsonb` (nullable) holding `[{name, weight}]` and `products.compare_at_price_stotinki`
> (nullable) for the struck-through "old" price. Bundles = products with `category='bundle'`. ADD-only migration;
> seed the 3 template bundles (Летен микс / Семеен пакет / Подаръчна кутия) with their contents + old prices and a
> `best` flag (store as `tint` or a `featured` boolean — add `products.featured boolean default false`).

**Backend prompt:**
> No new endpoint — bundles ship through `GET /public/:slug/products` (category `bundle`). Ensure `PublicProduct`
> now carries `bundleItems`, `compareAtPriceStotinki`, `featured`. Cache unchanged.

**Frontend prompt (rewrite `bundles.html`):**
> Rebuild the bundles page from the template, sourcing `getProducts(slug)` filtered to `category='bundle'`.
> Render the contents `<ul>` from `bundleItems`, the old/new price pair, the "★ Най-популярен" ribbon from
> `featured`, and "Добави пакета" → cart with the bundle as a single line. Keep the "персонален пакет" CTA → contact.
> **Done when:** the 3 seeded bundles render live with contents + discount pricing.

**Acceptance:** bundle line adds to cart as one item; subtotal correct.

---

## Feature S4 — Cart (typed, persistent)

**Frontend prompt (rewrite `cart.html`):**
> Port `FFCart` (localStorage `ff_cart`) into a typed cart store (zustand or context) with `add/setQty/remove/
> subtotal/count`, items keyed by `productId`. Rebuild the cart page: empty state (+ "зареди примерна количка"
> demo button is optional, drop for prod), line items with qty steppers + remove, summary with subtotal, shipping
> rule (free ≥ 40 лв else 4,90 лв — **read the threshold/fee from tenant settings if available, else constant**),
> "Берем в деня на доставката" note, "Към касата" → `/checkout`. Validate quantities against `stockQuantity` only
> if the public payload later exposes remaining stock (it currently hides it — keep client-trusting, the backend
> re-checks on intake).
> **Done when:** cart survives reload, steppers/remove update totals, free-shipping hint shows the remaining amount.

**Acceptance:** subtotal + shipping math matches the template; cart count badge stays in sync.

---

## Feature S5 — Slot system (the delivery slot picker) ⭐

**DB:** none (delivery_slots + booking already built; `delivery_enabled`, capacity, row-lock all exist).

**Backend prompt:**
> Verify `GET /public/:slug/slots?date=` returns only slots with `remaining>0` and `[]` when `delivery_enabled=false`
> (already implemented — just confirm the shape the storefront needs: `{id, date, startTime, endTime, remaining}`,
> times as `HH:MM`). If the storefront needs a range (date pills across N days), confirm a single call per date is
> fine or add `?from=&to=`. No write here — the slot is **claimed at order intake** via `slotId` (row-locked,
> 409 on overflow).

**Frontend prompt (rewrite the slot block in `checkout.html`):**
> Replace the hardcoded `allSlots`/`booked` demo with live data. Date pills = next N days; on pick, fetch
> `getSlots(slug, date)` and render available slots as buttons, **booked/full slots simply don't come back** (no
> client-side "disabled" hack needed). Selecting a slot stores its `slotId` for the order. If `delivery_enabled` is
> false (empty slots for all dates), hide the whole slot module and the address/slot requirement. Show the chosen
> "Избра: <date>, <HH:MM–HH:MM>" confirmation. Trim `HH:MM:SS`→`HH:MM` (pg time quirk).
> **Done when:** slot grid reflects real availability; selecting carries a real `slotId` into checkout state.

**Acceptance:** booking an order against a chosen slot reduces that slot's availability on the next fetch; a full
slot disappears; concurrent over-capacity yields the backend 409 surfaced as a friendly BG message.

---

## Feature S6 — Checkout + Stripe (catalog sync + payment + webhook) ⭐⭐

This is the headline feature: the fake card form in `checkout.html` becomes a real payment on the farm's
**connected** Stripe account, driven by a synced **Stripe product catalog**.

**DB prompt:**
> Migration (ADD-only): `products.stripe_price_id text` + `products.stripe_product_id text` (per connected account),
> `orders.stripe_payment_intent_id text`, `orders.stripe_checkout_session_id text`, `orders.paid_at timestamptz`,
> and an `order_status` value `paid` if not present (keep existing pending/confirmed/...). Rebuild db+types dist.

**Backend prompt (implement the Stripe module — currently a stub):**
> Implement `StripeService` against the Stripe SDK using **Stripe Connect** (`stripeAccount: tenant.stripeAccountId`
> on every call).
> 1. **Catalog sync:** on product create/update (admin side) and via a one-shot `syncCatalog(tenantId)`, upsert each
>    active product as a Stripe **Product + Price** on the farm's connected account; store `stripe_product_id` /
>    `stripe_price_id`. Price = stotinki, currency `bgn`. This is the "страйп каталог". Idempotent (update price by
>    archiving + recreating when the amount changes, since Stripe prices are immutable).
> 2. **Create checkout:** `POST /public/:slug/checkout` — body = the same cart + customer + slot + delivery fields as
>    `CreateOrderDto`. Server: run the existing order-intake transaction (snapshot, **row-lock the slot**, compute
>    total, status `pending`) → create a **Stripe Checkout Session** on the connected account with `line_items` from
>    the synced `stripe_price_id`s (+ a shipping line), `metadata.orderId`, success_url `/confirmation?order=...`,
>    cancel_url `/checkout`. Return `{ orderId, checkoutUrl }`. (Fallback: if a product has no `stripe_price_id`,
>    use inline `price_data` from the snapshot so checkout never blocks.)
> 3. **Webhook:** implement `POST /stripe/webhook` (raw body + signature verify; connected-account events). On
>    `checkout.session.completed` / `payment_intent.succeeded` → look up order by `metadata.orderId`, set
>    `stripe_payment_intent_id`, `paid_at`, status → `confirmed` (or `paid`), so it surfaces confirmed in admin
>    Поръчки and the slot stays booked. On expiry/failure → leave pending or cancel (which frees the slot).
> Config: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (already optional in env validation). Guard: public checkout
> stays open even when the farm's SaaS sub is inactive. Keep `POST /public/:slug/orders` for cash/no-Stripe farms.
> **Done when:** a test-mode connected account produces a real Checkout redirect and the webhook flips the order to
> confirmed + paid.

**Frontend prompt (rewrite `checkout.html`):**
> Rebuild the checkout from the template: 3-step header, contact card, delivery-method radios (address/econт →
> swap the address field label/placeholder), the **live slot module from S5**, and the order summary (lines +
> shipping + total from the cart). **Remove the fake card inputs.** "Завърши поръчката" → `POST createCheckout`
> with the cart `items` (productId+qty), customer fields, `deliveryType`, `deliveryAddress`/`econtOffice`,
> `slotId`, `notes` → `window.location = checkoutUrl` (Stripe-hosted). Handle 409 (slot taken) and validation
> errors with BG toasts via `extractApiMessage`. For cash-only farms (no Stripe configured), fall back to
> `POST /public/:slug/orders` and go straight to `/confirmation`.
> **Done when:** completing checkout redirects to Stripe, pays in test mode, and lands on `/confirmation` with the
> order confirmed in admin.

**Acceptance:** end-to-end test-mode purchase: Checkout Session created on the connected account, webhook marks the
order `paid/confirmed`, slot stays booked, admin Поръчки shows it; an unpaid/cancelled session leaves it `pending`.

---

## Feature S7 — Confirmation (real order)

**Frontend prompt (rewrite `confirmation.html`):**
> Read `?order=<id>` (and/or Stripe `session_id`) → fetch a public order summary. **Decision:** add a minimal
> `GET /public/:slug/orders/:id` returning a safe summary (items, totals, delivery, slot, status) keyed by an
> unguessable id/token — or pass the summary via success-page state. Render the template's success card with the
> real recap, delivery method + slot, "Платено" total, and the next-steps trio. Clear the cart on success.
> **Done when:** confirmation shows the actual purchased order, not the demo recap.

**Acceptance:** numbers match the created order; refreshing the page still shows it (server-fetched, not just cart).

---

## Feature S8 — Blog / articles (live)

**Backend:** already done — `GET /public/:slug/articles` + `/:articleSlug` exist.

**Frontend prompt (rewrite `blog.html` + `article.html` + home blog teaser):**
> Replace the hardcoded `posts` arrays with `getArticles(slug)` / `getArticle(slug, articleSlug)`. Blog index =
> card grid (cover, category tag, date, read-time); article page renders `PublicArticle` body + media (the article
> module supports media/embeds). Home "От влога" teaser = first 3 articles. Keep covers' `.ph` fallback.
> **Done when:** blog + article render live content; unknown article slug 404s.

**Acceptance:** article list/detail match `curl /public/ferma-petrovi/articles`.

---

## Feature S9 — Content pages + newsletter + contact intake

**DB prompt:**
> If you want contact submissions stored: add a `contact_messages` table (tenant_id, name, email, phone, message,
> created_at). Newsletter already has `newsletter_subscribers`.

**Backend prompt:**
> Add public POSTs (CORS `*`, rate-limited): `POST /public/:slug/newsletter` `{email}` → upsert subscriber (the
> table exists; wire the endpoint), and `POST /public/:slug/contact` `{name,email,phone?,message}` → insert
> contact_message (and/or fire an email). Both return 204/200; idempotent on duplicate email for newsletter.
> Optionally add `GET /public/:slug` → `PublicTenant` profile (name, phone, email, address, socials, shipping
> settings) so S1 can drop hardcoded farm constants.

**Frontend prompt (rewrite `about.html`, `contact.html`, `faq.html`):**
> Rebuild from templates. `about` = static copy (MVP). `contact` form → `POST /public/:slug/contact` with toast +
> reset. `faq` = accordion (port the `bindAccordion` behavior). Wire every newsletter form (home + footer) →
> `POST /public/:slug/newsletter`. Pull farm contact details from `GET /public/:slug` if you added it.
> **Done when:** contact + newsletter submit hit the API and show BG success toasts.

**Acceptance:** a submitted email appears in `newsletter_subscribers`; a contact message persists/sends.

---

## Feature S10 — Reviews

**DB prompt:**
> Add `reviews` table: id, tenant_id→tenants, product_id?(nullable→site-wide), author_name, rating(1–5),
> body, status enum(`pending`/`published`/`hidden`) default `pending`, created_at. ADD-only migration; seed a few
> published reviews matching `reviews.html`.

**Backend prompt:**
> `GET /public/:slug/reviews` → published only (+ avg rating + count). `POST /public/:slug/reviews` → insert
> `pending` (moderation), rate-limited. Admin moderation endpoints (tenant-scoped, behind JwtAuthGuard):
> list/approve/hide. Optionally surface a product's reviews on the product page.
> **Done when:** published reviews read publicly; submitted reviews land as `pending`.

**Frontend prompt (rewrite `reviews.html`):**
> Rebuild from the template sourcing `getReviews(slug)`: star summary, review cards, and a "напиши отзив" form →
> `POST` with a "ще се появи след одобрение" note. Star rendering reuses the `I.star` icon.
> **Done when:** reviews render live; submission shows the moderation note.

**Acceptance:** avg/count match seeded published rows; new review is not visible until approved in admin.

---

## Feature S11 — SEO, metadata, 404, polish

**Frontend prompt:**
> Per-page `<title>`/meta from tenant + content (e.g. `Малини · <Farm>`), OpenGraph, `lang="bg"`, sitemap/robots.
> Rebuild `404.html` as Next `not-found.tsx`. Image optimization for product/article media (R2 URLs). Loading +
> error states for every fetch. Accessibility pass (focus, aria from the templates). Final `next build` clean +
> Lighthouse sanity.
> **Done when:** every route has proper metadata, the 404 renders the themed page, no build warnings.

---

## Suggested order
S0 → S1 → S2 → S4 → S5 → **S6** → S7 (the purchase path is the spine) → S3 → S8 → S9 → S10 → S11.

## Per-feature definition of done
1. DB migration applied + db/types dist rebuilt (if a DB pass). 2. Backend: tenant-scoped writes, public reads,
verified via `curl` against the seeded farm. 3. Frontend: pixel-perfect from the template, wired to the public
API, `next build` clean, rendered. 4. Re-seed → re-verify (ids rotate). 5. The headline trio — **slot system (S5),
Stripe catalog+payment (S6), confirmation (S7)** — tested end-to-end in Stripe test mode.
