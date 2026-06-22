# ФермериБГ — Build Prompts (DB → Backend → Frontend)

Each feature is built in three ordered passes. Finish a feature end-to-end before
moving to the next. Run each prompt as a separate Claude Code task.

Tech stack: Postgres 16 (dockerized) + NestJS + Drizzle + Redis + Next.js 14 (App Router) + shadcn/ui + Cloudflare R2.
All money stored as integer **stotinki**. All UI text Bulgarian.

---

## CURRENT SETUP — read before running any prompt

The repo is **already scaffolded** as a pnpm + turbo monorepo. The prompts below
*implement existing stubs* — they do not create the project from scratch.

### Monorepo layout (actual dir names — keep them)
- `packages/db` — `@fermeribg/db`. Drizzle schema (`src/schema.ts`), `createDb(connectionString)` factory (`src/index.ts`), seed (`src/seed.ts`), drizzle-kit config. Migrations in `drizzle/`.
- `packages/types` — `@fermeribg/types`. Shared inferred TS types (currently empty barrel).
- `server` — `@fermeribg/api`. NestJS app. Entry: `pnpm --filter @fermeribg/api dev` (alias of `start:dev`).
- `client` — Next.js 14 admin app (App Router, TS, Tailwind).

> The prompts use **server/** and **client/** — NOT `apps/api` / `apps/web`.

### Root scripts
```
pnpm db:generate   # drizzle-kit generate (migration)
pnpm db:migrate    # drizzle-kit migrate (apply)
pnpm db:seed       # tsx packages/db/src/seed.ts
pnpm dev           # turbo run dev (all)
pnpm build         # turbo run build (db → types → api/web in dep order)
```

### Backend state (server/src)
Full module skeleton exists; **every service currently throws `NotImplementedException`**.
Implementing a feature = filling in its stubbed service/controller, not creating files.
- `common/` — `drizzle/` (module + `DB_TOKEN` from `drizzle.constants.ts`), `redis/` (ioredis + `REDIS_TOKEN`), `guards/` (`jwt-auth.guard.ts`, `tenant.guard.ts`), `decorators/` (`current-user`, `current-tenant`), `filters/global-exception.filter.ts`.
- `config/env.validation.ts` — **Joi** schema (DATABASE_URL, REDIS_URL, JWT_SECRET required; STRIPE/R2/GOOGLE_MAPS optional; PORT default 3000; CORS_ORIGIN default localhost:3000).
- `modules/` — `auth`, `tenants`, `products`, `slots`, `orders`, `routing`, `stripe`, `catalog-cache`, `storage` (R2 provider already written in `storage/providers/r2.provider.ts`).
- `main.ts` — global ValidationPipe, exception filter, CORS, Swagger at `/docs`. `app.controller.ts` — `GET /health`.

### DB schema baseline (packages/db/src/schema.ts) — already migrated
Tables: `tenants`, `users`, `products`, `delivery_slots`, `orders`, `order_items`.
Enums: `user_role` (admin/driver/customer), `order_status` (pending/confirmed/preparing/out_for_delivery/delivered/cancelled).
- UUID PKs via `uuid_generate_v4()` — first migration prepends `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`.
- Money is integer stotinki (`price_stotinki`, `total_stotinki`).
- Feature DB passes below **extend** this baseline (add columns/enums); they do not redefine it.
- The app uses only 4 order statuses: **pending / confirmed / delivered / cancelled**. The extra enum values stay but are unused.
- The farm owner logs in as a `users` row with role `admin` (the design has a single owner user).

### Frontend state (client/src)
Next.js App Router scaffold with route groups already present, currently rendering
mock data from `client/src/lib/mock-data.ts`:
- `app/(admin)/` — `dashboard`, `orders`, `products`, `slots`, `production`, `route` + `layout.tsx`.
- `app/(auth)/` — `login`, `register`.
- `components/` — stubs per page (layout/sidebar, layout/topbar, dashboard/*, orders/*, products/*, slots/*, production/*, route/*).
- `stores/ui-store.ts` (zustand). `lib/utils.ts`, `lib/types.ts`.
- `app/globals.css` is **empty** and `app/layout.tsx` is bare — theme + fonts NOT yet applied.

---

## DESIGN SOURCE — the frontend must be built FROM the design

A pixel-perfect HTML/JS prototype lives in **`docs/farmflow/project/`**. This is the
ground truth for every screen. Each frontend prompt must **recreate the matching design
file exactly** — layout, spacing, colors, typography, copy, responsive behavior.

Design files (React-in-browser prototype via Babel; read the source, do not screenshot):
- `index.html` — design tokens (`:root` CSS vars), fonts, global animations, **all responsive breakpoints**.
- `app.jsx` — app shell, page routing, toast system.
- `components.jsx` — `Sidebar`, `TopBar`, `StatusBadge`, `ProductThumb`, `Toggle`, `Btn`, `Card`, `Logo`, `NotifRow`.
- `pages.jsx` — Dashboard, Orders (+ `OrderPanel` slide-out, `InfoRow`).
- `pages2.jsx` — Products, Slots, Route (+ `MapPlaceholder`).
- `production.jsx` — Production prep list.
- `auth.jsx` — `AuthShell`, Login, Register.
- `icons.jsx` — 24×24 stroke icons (map to **lucide-react**).
- `data.js` — Bulgarian demo data shape + `money()` formatter + `statusMeta`.

### Frontend implementation rules (apply to every 1.3 / 2.3 / … prompt)
1. **shadcn/ui is the component foundation** (New York style, CSS variables). Use shadcn
   primitives — Button, Input, Card, Dialog, Sheet, Switch, Tabs, Sonner (toast),
   Select, Popover/Calendar — and **theme them via CSS vars to match the design tokens
   exactly**. Build the design's bespoke pieces (StatusBadge, ProductThumb, slot pills,
   route map, stat cards) as custom components on top of shadcn primitives.
2. **Pixel-perfect to the design file.** Match the prototype's colors, radii, shadows,
   font sizes/weights, paddings, grid templates, hover/animation, and Bulgarian copy.
3. **Fonts (two):** `Commissioner` (UI body/labels, weights 400–800) and `Bitter`
   (display — `h1/h2/h3` and tabular figures, weights 500–800). Load both via `next/font`.
   Tabular numerals (`font-feature-settings: "tnum"`) on money/figure displays.
4. **Money:** stored as integer stotinki; display as `"6,50 лв"` (2 decimals, comma
   separator, ` лв` suffix) — port `data.js` `money()` into `lib/utils.ts`.
5. **Status:** 4 statuses with Bulgarian labels + design colors —
   pending=`Чакаща` (amber), confirmed=`Потвърдена` (green), delivered=`Доставена` (gray),
   cancelled=`Отказана` (dashed/strikethrough muted).
6. **Responsive** exactly per `index.html` media queries: 1024px (sidebar→off-canvas
   drawer + hamburger, stats 2-col, slots horizontal-scroll, products 2-col), 900px
   (dashboard 1-col, production 1-col, route map-on-top), 680px (orders table→cards,
   order panel full-width), 640px (compact paddings, hide tenant block, stats/products 1-col).
7. Each page replaces its mock-data stub with live API data once its backend verifies.

### Design tokens (from `docs/farmflow/project/index.html` `:root` — map all to shadcn CSS vars in `globals.css`)
```
--bg:#F3EEE2  --surface:#FFFFFF  --surface-2:#FBF8F1
--green-950:#16301C --green-900:#1F3D26 --green-800:#244A2C --green-700:#2C5530
--green-600:#387040 --green-500:#4C8A54 --green-100:#E2EBDD --green-50:#EEF3E9
--amber:#E8A33D --amber-600:#D08B26 --amber-soft:#F8E8C9 --amber-softer:#FBF1DC
--ink:#26241D --ink-2:#585242 --muted:#8B8573 --muted-2:#A8A290
--border:#E6DECE --border-2:#EFE9DC  --gray-badge-bg:#ECE8DD --gray-badge-ink:#75705F
--radius:12px (cards)  --radius-sm:8px (buttons)  --radius-lg:18px
--sidebar-w:220px  --topbar-h:68px
shadow-sm/md/lg + brand green #2C5530, amber #E8A33D, red #BF4434 per palette.
```

---

# FEATURE 0 — Foundation  *(mostly already scaffolded — verify + finish theme)*

### 0.1 — DB  *(done — verify)*
```
Verify the existing packages/db foundation works end-to-end.
- docker compose up -d boots postgres:16 + redis:7-alpine (compose file at repo root).
- pnpm db:migrate applies drizzle/0000 (uuid-ossp extension + baseline tables).
- pnpm db:seed inserts demo tenant "Ферма Петрови".
- Confirm createDb() in packages/db/src/index.ts connects.
Verify: docker compose up boots both services, drizzle-kit migrates clean, seed runs.
```

### 0.2 — Backend  *(scaffolded — verify boot)*
```
Verify the NestJS app in server/ boots clean with no business logic yet.
- @nestjs/config Joi env validation, global DrizzleModule + RedisModule, global
  ValidationPipe + exception filter, CORS for localhost:3000, GET /health, Swagger /docs.
Verify: pnpm --filter @fermeribg/api dev boots clean; /health returns ok; /docs serves Swagger.
```

### 0.3 — Frontend  *(scaffold exists — apply theme + shell from design)*
```
Theme the Next.js app in client/ and build the app shell EXACTLY from the design.
- Initialize shadcn/ui (New York, CSS variables). Populate the empty client/src/app/globals.css
  with the ФермериБГ earthy palette mapped to shadcn HSL CSS vars, using the tokens in
  docs/farmflow/project/index.html :root (bg #F3EEE2, surface #FFFFFF, brand green #2C5530,
  amber #E8A33D, red #BF4434, ink/muted/border scale, radii 12/8/18). Add the design's
  keyframes (ff-fade-up, ff-fade, ff-slide-in, ff-pop, ff-pulse) and scrollbar styling.
- Load Commissioner (400–800) + Bitter (500–800) via next/font in app/layout.tsx; Bitter for
  headings/figures, Commissioner for UI. Set <html lang="bg">.
- Build the (admin) layout shell to match components.jsx Sidebar + TopBar pixel-perfect:
  responsive sidebar (fixed 220px desktop; off-canvas drawer < 1024px with hamburger + backdrop),
  brand Logo (green rounded leaf mark) + "ФермериБГ" / "Управление на фермата", nav items
  Табло/Поръчки/Производство/Продукти/Слотове/Маршрут (lucide icons, active = green-50 bg +
  left green border, pending-count badge on Поръчки), season card + "Изход" at bottom.
  TopBar: page title (Bitter), tenant name + Bulgarian date (capitalized), notifications bell
  with dot, avatar "ПЦ". Wire drawer open/close via stores/ui-store.ts (zustand).
- Port money() + statusMeta into lib/utils.ts; build a StatusBadge component from the design.
- Page titles map (app.jsx PAGE_TITLES) drives the topbar title per route.
Verify: pnpm --filter client dev runs, theme + both fonts applied, sidebar collapses to a
drawer below 1024px, shell matches the design.
```

---

# FEATURE 1 — Auth & Tenants

### 1.1 — DB
```
Extend the existing tenants + users tables (do not recreate).
- ALTER tenants: add phone text, email text, subscription_status enum(active/inactive) default
  'active', subscription_since timestamp. Keep existing slug/name/settings/stripe_account_id.
- users already has role enum(admin/driver/customer); the farm owner uses role 'admin'.
- Generate the migration (pnpm db:generate) and apply it. Update seed.ts so "Ферма Петрови"
  has phone/email and one owner user (role admin, argon2 hash) — email ivan@ferma-petrovi.bg
  to match the design's prefilled login.
```

### 1.2 — Backend
```
Implement the stubbed auth + tenants modules (currently NotImplementedException).
- POST /auth/register: creates tenant + owner user (role admin, hash with argon2), returns JWT.
- POST /auth/login: validates credentials, returns JWT. Payload { userId, tenantId, role }.
- Wire the existing JwtAuthGuard (passport-jwt) + TenantGuard (scopes every request to its
  tenantId) and the @CurrentTenant() / @CurrentUser() decorators.
- tenants module: GET /tenants/me, PATCH /tenants/me. Serialization NEVER exposes password_hash.
Verify: register → login → GET /tenants/me with the token works; cross-tenant data is unreachable.
```

### 1.3 — Frontend  *(build from auth.jsx)*
```
Build the (auth) login + register screens in client/, pixel-perfect from docs/farmflow/project/auth.jsx.
- AuthShell: off-white bg with faint green radial texture top, centered 420px card (radius 16,
  shadow-md, 30px pad), Logo(52) + "ФермериБГ" (Bitter) + "Управление на фермата", footer "ФермериБГ © 2026".
- /login: title "Влез в профила си", sub copy, fields Имейл + Парола (with "Забравена парола?"),
  primary full-width "Влез", "Нямаш акаунт? Регистрирай се". Use shadcn Input/Button themed to design.
- /register: "Създай акаунт", fields Име на фермата, Имейл, Телефон, Парола + Потвърди парола (2-col grid),
  "Създай акаунт", terms line, "Вече имаш акаунт? Влез".
- Wire to /auth/login + /auth/register. Store JWT (httpOnly cookie via a Next route handler).
  Protect (admin) routes (redirect to /login if no session). "Изход" clears session → /login.
  Topbar tenant name comes from /tenants/me.
Verify: register → dashboard → logout → login cycle works; admin routes gated; screens match auth.jsx.
```

---

# FEATURE 2 — Products & Catalog

### 2.1 — DB
```
Extend the existing products table to carry the design's fields.
- ALTER products: add category text, weight text (e.g. "500 г"), tint text (hex accent).
  Make stock_quantity nullable (NULL = unlimited). Keep price_stotinki, unit (text: kg/бр/литър/пакет),
  is_active, image_url, description.
- Generate + apply migration. Extend seed with the 9 demo products from data.js
  (Ягоди, Боровинки, Малини, Къпини, Череши, Сироп от ягоди, Домашно сладко малина, Мед липов,
  Арония) with their prices (stotinki), weights, stock, tint, category (Плодове/Преработени).
```

### 2.2 — Backend
```
Implement the stubbed products module + wire the existing R2 StorageService.
- Admin (JwtAuthGuard + TenantGuard): GET /products, POST /products, PATCH /products/:id,
  DELETE /products/:id (soft delete via is_active).
- Image upload: POST /products/:id/image (multipart, FileInterceptor) — validate jpeg/png/webp,
  max 5MB, store via StorageService under tenants/{tenantId}/products/{uuid}.ext, save image_url,
  delete old object on replace/delete. (r2.provider.ts already exists.)
- Public: GET /public/:slug/products — slug→tenantId, active products, cached in Redis
  (key catalog:{tenantId}, TTL 300s) via the catalog-cache module. Invalidate on any product write.
Verify: CRUD works, image uploads to R2, public endpoint serves from cache and invalidates on edit.
```

### 2.3 — Frontend  *(build from pages2.jsx ProductsPage + components.jsx ProductThumb/Toggle)*
```
Build the Продукти page pixel-perfect from docs/farmflow/project/pages2.jsx (ProductsPage).
- Header: "N активни · M общо" (muted) + primary "Добави продукт" (plus icon).
- Responsive card grid: repeat(auto-fill, minmax(232px,1fr)) → 2-col ≤1024 → 1-col ≤640.
  Card (pad 14, dims to 0.62 opacity when inactive): ProductThumb (green/neutral berry-motif
  placeholder, ~132px, "снимка" chip), name (Bitter-ish 800), "weight · category" muted,
  small Toggle (shadcn Switch themed green), price (22px), stock dot+label
  (Изчерпан / Ниска наличност · N / В наличност · N colored muted/amber/green), "Редактирай" button.
- Inline edit (or shadcn Dialog on mobile): Цена (лв) + Наличност (бр.) inputs, Запази / Отказ.
  Toggling active + saving call the API; optimistic UI + Sonner toast.
- Image upload posts to /products/:id/image.
Verify: create, edit, toggle, image upload, delete reflect live; layout matches the design.
```

---

# FEATURE 3 — Delivery Slots

### 3.1 — DB
```
delivery_slots already exists (date, time_from, time_to, max_orders, current_orders, is_active).
- No structural change required. (booked count is computed dynamically, not from current_orders.)
- Extend seed with a full week of slots for "Ферма Петрови" matching data.js (Пон–Нед, varying
  capacity 4–5, today = Събота 30.05). Generate/apply a migration only if you adjust columns.
```

### 3.2 — Backend
```
Implement the stubbed slots module.
- Admin: GET /slots?from=&to= (each slot returns a computed booked = count of non-cancelled
  orders on that slot, ONE join query, no N+1), POST /slots (single OR bulk for a date range +
  weekday pattern), DELETE /slots/:id.
- Public: GET /public/:slug/slots?date= — only slots with remaining capacity (max_orders - booked > 0).
Verify: create, bulk-create, and available-only public filter work; capacity math correct.
```

### 3.3 — Frontend  *(build from pages2.jsx SlotsPage)*
```
Build the Слотове page pixel-perfect from docs/farmflow/project/pages2.jsx (SlotsPage).
- Header: "Седмица 25 – 31 май 2026 · Варна" + legend (свободно green / почти пълно amber / пълно gray).
- 7-day grid (Пон–Нед), each day a card; TODAY (Събота) highlighted (2px green border, green-50
  header, "ДНЕС" tag). Below 1024px: horizontal scroll, day min-width 160px, scroll-snap.
- Each day lists slot pills "10:00 – 11:00" with a thin capacity bar + "booked/cap", colored by
  fill ratio (≥full gray, ≥80% amber, else green). "+ Слот" dashed button per day; pills deletable.
- "+ Слот" opens a small form (start, end, capacity) — shadcn Popover/Dialog themed to design.
Verify: slots render with correct colors/capacity from the API; add + delete work live.
```

---

## INTEGRATION MODEL (clarified 2026-05-31) — read before Features 2/4/7
This repo is the **farm admin panel + API only**. There is **no customer-facing storefront in this
repo**. Each farm runs its own external storefront (third-party site).
- **Catalog is the integration surface.** External storefronts read the farm's products/slots live
  from the public endpoints (`GET /public/:slug/products`, `GET /public/:slug/slots`). These are
  **open reads, secured by CORS only — no API key.** (Redis-cached, already built in Feature 2.2.)
- **Orders are collected, not authored here.** The storefront sends placed orders to
  `POST /public/:slug/orders`; this backend records them and they show up in the admin Поръчки view.
- **Payments: each farm has its OWN Stripe.** Payment happens on the farm's side (the farm's Stripe
  account — `tenants.stripe_account_id` already exists for Stripe Connect). This backend does not run
  a checkout UI; it reconciles paid orders (Stripe webhook → mark confirmed/paid) and collects them.
- **Do NOT build a `(store)` checkout/cart frontend.** Feature 4.3 is admin-only.
- Note: `tenants.subscription_status` (Feature 7) is the farm's **SaaS subscription to ФермериБГ** —
  separate from the farm's own Stripe used for its customers.

---

# FEATURE 4 — Orders (collected from external storefronts)

### 4.1 — DB
```
Extend orders + order_items for guest checkout + delivery type (do not recreate).
- ALTER orders: make customer_id nullable (guest checkout, no account); add customer_name text,
  customer_phone text, customer_email text, delivery_type enum(address/econt), econt_office text
  nullable. Keep slot_id, status, total_stotinki, delivery_address, notes, created_at.
  (App uses statuses pending/confirmed/delivered/cancelled.)
- ALTER order_items: add product_name text (snapshot at order time). Keep quantity, price_stotinki.
- Generate + apply migration. Extend seed with the 13 demo orders from data.js across all
  statuses (with items, delivery type Адрес/Еконт, slots, notes, totals in stotinki).
```

### 4.2 — Backend
```
Implement the stubbed orders module. Orders are COLLECTED from external storefronts (see
INTEGRATION MODEL) — this backend does not run a customer checkout.
- Admin: GET /orders (paginated; filter by date + status + delivery_type; search by customer/order id),
  GET /orders/:id, PATCH /orders/:id/status (confirm/deliver/cancel — cancelling frees slot capacity).
- Public intake: POST /public/:slug/orders — the storefront posts a placed order. Inside a DB
  transaction, validate the chosen slot still has capacity (prevents double-booking), snapshot
  product_name + price into order_items, compute total, create order status=pending. Open + CORS only.
- Stripe (per-farm): the farm's own Stripe handles payment. Reconcile via POST /stripe/webhook —
  on payment success mark the matching order confirmed/paid. Use the farm's connected account
  (tenants.stripe_account_id) / per-tenant Stripe config. Idempotent on Stripe event id.
- Bulk: PATCH /orders/confirm-pending — confirm all pending orders for a date.
Verify: over-capacity slot rejected; status transitions work; bulk confirm works; concurrent
double-booking impossible; a webhook payment event flips the order to confirmed.
```

### 4.3 — Frontend  *(ADMIN ONLY — build from pages.jsx OrdersPage + OrderPanel)*
```
No customer storefront in this repo — do NOT build a (store) route group. Admin Поръчки only,
pixel-perfect from docs/farmflow/project/pages.jsx:
- Toolbar: search (Търси клиент или № поръчка…) + date pick + status filter pills
  (Всички/Чакащи/Потвърдени/Доставени/Отказани, active = green) — use shadcn Tabs/Input.
- Desktop: table (Час, Клиент, Продукти, Доставка, Статус, Сума) with the design's grid template;
  ≤680px swap to stacked order cards. Delivery shows pin/box icon (Адрес green / Еконт amber).
- StatusBadge colors per design. Row click opens a right slide-out (shadcn Sheet, full-width
  ≤680px) = OrderPanel: customer header, status + time, contact InfoRows (phone, address/econt
  office, slot), amber customer-note block, items list, total (Bitter), and action buttons
  Потвърди / Маркирай доставена / Откажи calling PATCH /orders/:id/status.
- Orders arrive from the external storefront; the admin view is read + status management. A new
  order posted to /public/:slug/orders must appear here (refresh/poll is fine for MVP).
Verify: a public order (POST /public/:slug/orders) appears in admin Поръчки; status changes work;
cancelling frees slot capacity; admin UI matches the design.
```

---

# FEATURE 5 — Production (daily prep list)

### 5.1 — DB
```
No schema changes — Production aggregates existing confirmed orders. Skip.
```

### 5.2 — Backend
```
Add GET /production?date= to the orders module.
- Aggregate all confirmed orders for the date into per-product totals
  { product_name, total_qty, order_count }, sorted by qty desc. Single grouped query, no N+1.
Verify: aggregated quantities match the confirmed orders for the date.
```

### 5.3 — Frontend  *(build from production.jsx)*
```
Build the Производство page "За приготвяне днес" pixel-perfect from docs/farmflow/project/production.jsx.
- Summary: "N потвърдени поръчки · M продукта за приготвяне" + date pick.
- Grid 1fr / 300px (1-col ≤900px). Prep list card: header "За приготвяне днес" + "done/total готови".
  Each row: large checkbox (green when done), product name (18px, strikethrough+muted when done),
  "от N поръчки" muted, big green qty number (34px, tabular) + "бр". Sorted most-to-prepare first.
- Side panel (below list on mobile): "Напредък" card (green top border, done/total big figure +
  progress bar; all-done shows "Всичко е приготвено — готов за доставка! 🌿") + a "Преди бране" tip card.
- Checkbox state is local UI only. Data from GET /production.
Verify: quantities match confirmed orders; ticking updates progress; matches the design.
```

---

# FEATURE 6 — Delivery Route

### 6.1 — DB
```
Add the farm origin to tenants for routing.
- ALTER tenants: add farm_address text, farm_lat numeric nullable, farm_lng numeric nullable.
- Generate + apply migration. Update seed with a Varna farm address + coordinates.
```

### 6.2 — Backend
```
Implement the stubbed routing module.
- GET /orders/route?date= : fetch confirmed orders for the date with delivery_type=address, call
  the Google Maps Routes/Directions API (origin = farm address, stops = waypoints, optimize:true),
  return ordered stops + total distance + estimated duration. No persistence.
- Env GOOGLE_MAPS_API_KEY (already optional in env.validation). If the key is missing, return the
  unoptimized order gracefully.
- NOTE: GET /orders/route must resolve before OrdersModule's /orders/:id route (order matters).
Verify: returns an ordered stop list with distance/duration for a date's address orders.
```

### 6.3 — Frontend  *(build from pages2.jsx RoutePage + MapPlaceholder)*
```
Build the Маршрут page pixel-perfect from docs/farmflow/project/pages2.jsx (RoutePage).
- Header: summary "N спирки · X км · ~Y мин" + date pick.
- Desktop grid 380px / 1fr (stack with map-on-top ≤900px). Left: "Маршрут за доставка" card with
  Google Maps + Старт buttons, then numbered stop list (number bead + connector line, customer,
  pin+address, summary · slot, per-stop "open in Google Maps" + call icon buttons). Active stop
  highlights green-50.
- Right: a real Google Maps embed iframe of the route (the prototype shows a MapPlaceholder; replace
  with the live embed) with numbered pins; clicking a pin/stop syncs the active selection.
- Primary "Отвори в Google Maps" builds a maps dir URL (origin=farm, waypoints=stops in order,
  destination=last), URL-encoding Cyrillic, opens new tab (deep-links on mobile). Handle the ~9
  waypoint limit gracefully.
Verify: route renders from the API; export opens Google Maps with the full ordered route; matches design.
```

---

# FEATURE 7 — Dashboard & Subscription gating

### 7.1 — DB
```
No new tables. subscription_status already added to tenants in 1.1. Skip.
```

### 7.2 — Backend
```
Add GET /dashboard?date= returning today's summary: order count (+ delta vs yesterday), revenue
(sum of non-cancelled total_stotinki), pending count, next slot + its capacity. One efficient query set.
Add subscription enforcement: a guard/interceptor that, when tenant.subscription_status = inactive,
restricts order/history queries to the last 7 days (older orders filtered server-side). Active
tenants see everything.
Verify: dashboard numbers correct; an inactive tenant sees only 7 days of orders.
```

### 7.3 — Frontend  *(build from pages.jsx DashboardPage)*
```
Build the Табло dashboard pixel-perfect from docs/farmflow/project/pages.jsx (DashboardPage).
- 4 stat cards with 3px green top border (Поръчки днес, Оборот днес, Чакат потвърждение, Следващ слот):
  icon chip, big figure (32px tabular), label, sub line. Responsive 4 → 2×2 (≤1024) → 1 (≤640).
- Grid 1.6fr / 1fr (1-col ≤900): left "Поръчки за днес" feed card (time, customer, items summary,
  StatusBadge, total; "Всички ›" → Поръчки; row click opens the order detail Sheet). Right column:
  "Бързи действия" card — amber "Потвърди всички чакащи (N)" → bulk confirm; "Виж маршрута за днес"
  → navigate to Маршрут — plus a "Капацитет днес" card (today's slot mini bars).
- If subscription inactive: non-blocking amber warning banner; older-than-7-days data simply absent.
- Data from GET /dashboard + /orders. money()/StatusBadge from lib/utils.
Verify: stats match the API; quick actions work; feed opens order details; matches design.
```

---

# FEATURE 8 — Статии (per-farm content / news feed)  *(locked 2026-05-31)*

Model: the farmer authors статии in the panel; published ones are served to that farm's external
boilerplate storefront via the public API (same integration surface as products/slots — open read,
CORS only, no key). The panel has a **Преглед** tab that renders with the SAME component the
storefront uses, so preview == live (WYSIWYG). Media = R2 uploads + pasted YouTube/Instagram URLs
(parsed to ids/shortcodes server-side, keyless — the storefront builds the iframe). Email is
deferred; the schema is laid down now so Phase 2 needs no migration. Body is **simple markdown/text**
(NOT a block editor) — scope decision locked.

### 8.1 — DB
```
New tables in schema.ts (drizzle-kit generate → migration 0008; add all to the `schema` export, then
rebuild db + types dist: pnpm --filter @fermeribg/db generate && build, pnpm --filter @fermeribg/types build).
- enum article_status: draft | published (default draft).
- enum article_media_type: image | video | youtube | instagram.
- articles: id, tenant_id→tenants, slug, title, excerpt, body (text/markdown),
  cover_image_url (R2, nullable), status article_status default draft, published_at timestamp null,
  sent_at timestamp null (email-ready hook, unused now), created_at, updated_at.
  unique(tenant_id, slug); index(tenant_id, status, published_at).
- article_media (ordered blocks): id, article_id→articles, tenant_id (denormalized for scoping),
  type article_media_type, url (R2 url for uploads; source URL for embeds),
  embed_id (parsed YouTube video id / Instagram shortcode, nullable), caption nullable, position int.
- newsletter_subscribers (created now, EMPTY, no send logic — pure email-ready scaffold):
  id, tenant_id→tenants, email, created_at, unsubscribed_at timestamp null.
- Add Article / NewArticle / ArticleMedia / NewArticleMedia (+ PublicArticle = article + ordered media,
  tenant_id stripped) to @fermeribg/types.
- Seed 2–3 demo статии for "Ферма Петрови": cover + 1 uploaded photo + 1 YouTube embed, ≥1 published.
```

### 8.2 — Backend  *(new articles module; reuse @Global StorageService + a new articles-cache service)*
```
Admin (JwtAuthGuard, tenant-scoped; cross-tenant access → 404, same as products):
- GET /articles — own, ALL statuses, newest first, +ordered media.
- GET /articles/:id — own, +media.
- POST /articles — create draft.                         · ActiveSubscriptionGuard
- PATCH /articles/:id — edit / publish (publish = set status=published + published_at=now()). · ActiveSubscriptionGuard
- DELETE /articles/:id — delete row + R2 cleanup of all its media (best-effort, like products).
- POST /articles/:id/cover  + POST /articles/:id/media — multipart → R2 via StorageService under
  tenants/{tenantId}/articles/{uuid}.ext; extend the mime/size allow-list for video (mp4/webm, larger cap)
  alongside the existing jpeg/png/webp. Media upload inserts an article_media row (type image|video).
- POST /articles/:id/media/embed — paste a YouTube/Instagram URL; regex-parse provider + id/shortcode
  (keyless) → store type youtube|instagram, url=source, embed_id=parsed. Reject unparseable URLs (400).
- DELETE /articles/:id/media/:mediaId   · PATCH /articles/:id/media/reorder (array of {id, position}).
Public (open, CORS *, Redis-cached key articles:{tenantId} TTL 300s, invalidate on ANY article/media write):
- GET /public/:slug/articles — slug→tenantId, PUBLISHED only, newest first, +ordered media.
- GET /public/:slug/articles/:articleSlug — single published article + media.
Enforcement (consistent with route/production/slots): inactive farm can't create/publish (403
"Абонаментът е неактивен" via ActiveSubscriptionGuard); reading own drafts still works; the public
feed keeps serving while inactive. Mutations are auto-audited by the existing AuditInterceptor.
Verify: CRUD tenant-scoped (cross-tenant 404); publish flips status + published_at; public returns
published + ordered media only; cache hit + invalidate on write; embed URL parse (yt id, ig shortcode);
upload → R2 url + media row; inactive publish → 403; public still works while inactive.
```

### 8.3 — Frontend  *(new Статии nav item; reuse product upload + ToggleSwitch + sonner/optimistic patterns)*
```
- Sidebar: add NAV entry { href:'/articles', label:'Статии', Icon: Newspaper } (lucide); add
  '/articles': 'Статии' to Topbar PAGE_TITLES.
- /articles (SSR list, like products/page.tsx): cover thumb, title, status badge (Чернова / Публикувана),
  published date, media count + "Нова статия". Mutations via /bff (multipart already supported by the
  bff proxy). Optimistic UI + Sonner, ApiError message extraction (api-client pattern).
- /articles/[id] (editor): title, excerpt, body (textarea/markdown), cover upload, media manager
  (add upload / add embed-by-URL, caption, drag-reorder, delete), status toggle (ToggleSwitch), Save.
- ArticleRenderer (shared component): renders media by position — image→<img>, video→<video>,
  youtube→<iframe src=/embed/{embed_id}>, instagram→embed blockquote. Used by the panel **Преглед**
  tab now AND copy-pasteable into the boilerplate storefront → identical output.
Verify: tsc + next build clean; list/editor/upload/embed/publish work; Преглед renders every media type.
```

### 8.4 — Storefront contract  *(documentation for the external boilerplate — no code in this repo)*
```
Document the public response shape + render rules so the boilerplate storefront fetches
GET /public/:slug/articles and renders via a copy of the shared ArticleRenderer (preview == live):
- type → markup: youtube → <iframe https://www.youtube.com/embed/{embed_id}>; instagram → <iframe
  https://www.instagram.com/p/{embed_id}/embed> (keyless, no embed.js); image → R2 <img>;
  video → R2 <video controls>. All wrapped in a 16:9 frame except image (<img> natural).
- media is pre-ordered by position; cover_image_url is the hero. published_at drives feed ordering.
Open read, CORS only, no API key — same integration surface as Features 2/3/4.
```

### Phase 2 — Email blasts  *(NOT now; schema already laid down in 8.1)*
```
Deferred: POST /public/:slug/newsletter/subscribe (storefront form), POST /articles/:id/send →
email provider (Resend/SES) → set articles.sent_at, unsubscribe token. newsletter_subscribers +
sent_at already exist, so Phase 2 needs no migration.
```

---

## APPENDIX — Google Maps removal  *(small standalone task; do independently of Feature 8)*
```
Drop Google entirely from the Route feature; keep it fully functional with zero Google dependency.
- Backend routing.service.ts: delete the optimize() method + the GOOGLE_MAPS_API_KEY branch in
  getRoute(); always return stops in arrival order with optimized:false, totalDistance/Duration null.
- Frontend route-client.tsx: remove MAPS_KEY + embedUrl(); KEEP dirUrl()/stopUrl() (Google Maps
  deep-links need no key). route-map.tsx: remove the embedUrl <iframe> branch + the embedUrl prop;
  keep the demo placeholder map.
- Config: remove GOOGLE_MAPS_API_KEY from env.validation.ts + .env.example, and
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY usage (only referenced in route-client.tsx).
Verify: Route page renders stops + demo map; "Google Maps"/"Старт" deep-links + per-stop links work;
no GOOGLE_MAPS_API_KEY referenced anywhere; tsc/build clean.
```

---

## Order of execution
0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Each feature's DB pass first, then backend, then frontend, then
verify before moving on. Do not start a feature's frontend before its backend verifies. Every
frontend pass is judged against its design file in `docs/farmflow/project/`. (The Google Maps
removal appendix is independent of the feature order.)
