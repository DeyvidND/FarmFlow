# Elder-first UX audit — implementation plan (2026-07-02)

## Context

Persona-driven UX audit of the three surfaces — **chaika storefront**, **farmer
panel** (`client`), **delivery panel** (`delivery-web`) — through the prism of a
"council" of seven users. Primary target: **old farmers and non-digital people**
(60+, poor eyesight, big fingers, no email habit); young/digital users checked as
secondary.

Method: code-based heuristic audit, then **live verification** of the storefront
on a 375px viewport. Live run proved Tailwind class → rendered pixel is 1:1
(code `text-[12.5px]` measured `12.5px`, `h-8 w-8` → 32px, checkbox 16×16,
email `required: true`, dead courier card `display != none`). So panel
measurements cited from classes are trustworthy without re-running the full API
stack.

Downstream dependency checks completed:
- `customerEmail` is **optional everywhere** — DTO `@IsOptional()`, DB nullable,
  confirmation mail skips when absent (`if (!to) return; // guest checkout without
  an email`), Stripe passes `customer_email || undefined`, stats key is
  phone-first coalesce.
- **Econt** and **Speedy** carrier payloads have **no email field at all**
  (`receiverClient = { name, phones }`; `recipient = { phone1, clientName, … }`).
  Only name + phone + destination (+ COD) are required.
- **Phone** stays the real required identity field (carriers, SMS/tracking, COD,
  farmer callback all ride on it).

## Council consensus (highest-agreement findings)

1. Small **secondary** text (11–14px) is the #1 barrier — base body is fine (17px
   storefront), the misses are sub-labels/hints/status text.
2. **Icon-only controls** = a wall for non-digital users (sidebar footer,
   hamburger, small close/delete buttons), made worse by hover-only tooltips on
   touch devices.
3. **Email-required checkout** blocks a whole class of older buyers.

## The single highest-leverage move

Ship an **„Едър изглед" / accessible mode** toggle (one switch → ≥16px secondary
text, ≥44px tap targets, icon labels always visible). Resolves findings 2, 3, 4,
7, 12 at once. Store as `users` pref in the panels, `localStorage` in the
storefront. This is a later phase; P0/P1 below are the immediate wins.

---

## Phase 0 — P0 (blocks task / loses money)

### 0.1 Storefront: make email optional
**Why:** older buyers often have no email → cannot complete checkout. Backend +
both carriers already tolerate absence (verified). Confirmed live: `email
required: true`.

**Changes (frontend only):**
- `fermerski-pazar-chaika/src/pages/checkout.astro:79` — remove `required` from
  `customerEmail`; relabel to „Имейл (по желание — за потвърждение)".
- `fermerski-pazar-chaika/src/scripts/checkout-page.ts:30` — make `validateEmail`
  empty-tolerant (validate format only when non-empty). Keep it in `contactChecks`
  so a *typed* bad email still errors.
- On `/confirmation`, ensure the on-screen success (order №) shows for no-email
  buyers so they still get acknowledgement (already renders — verify).

**Verify:** load `/checkout` at 375px with a seeded `ff_cart`, submit with empty
email → order posts; with a malformed email → still blocked.

**Effort:** S. No backend, no migration.

### 0.2 Farmer panel: label the sidebar footer controls
**Why:** onboarding tells farmers "everything is in Настройки", but Настройки /
Помощ / Изход are **icon-only** at `sidebar.tsx:349-388` with hover-only
`title` → invisible intent on touch. Non-digital farmer cannot reach the exact
place onboarding sends them.

**Changes:**
- `client/src/components/layout/sidebar.tsx:349-389` — replace the 3-icon quick row
  with labeled rows (icon + text „Настройки" / „Помощ" / „Изход"), or add a
  labeled „Настройки" entry into the main nav list. Keep logout distinct/last.

**Verify:** panel at 375px — three controls show words.

**Effort:** S.

---

## Phase 1 — P1 (major friction, wide impact)

### 1.1 Raise the small-text floor (all three apps)
**Why:** 11 distinct sub-13px text nodes on one checkout screen (min 11px);
sidebar section headers `text-[10.5px]`. Base is fine — fix *secondary* text.

**Changes — bump to ≥13–14px (target 15px for hints/status):**
- Storefront: `checkout.astro` — terms label 12.5→14px (`:205`), hints 13→14px
  (`:130,:166`), radio sub 14px OK. Sweep other pages (`product/[slug]`, `cart`)
  for `font-size:13px`/`12.5px` copy.
- Farmer panel: `sidebar.tsx:325,335` group headers 10.5→12px;
  `dashboard-client.tsx:60-62` sub 12.5→13.5px; audit other `text-[11.5px]` /
  `text-[12.5px]` on primary read paths.
- Delivery: `import-client.tsx` + `panel-chrome.tsx` — lift 11.5/12.5px labels on
  read paths to 13px.

**Verify:** re-measure via `preview_inspect` — no read-critical text < 13px.

**Effort:** M (broad sweep). Do the accessible-mode toggle (Phase 3) as the
durable answer; this phase raises the *default* floor.

### 1.2 Tap targets ≥ 44px on touch
**Why:** icon buttons `h-8 w-8` (32px) and `h-9 w-9` (36px), checkbox 16×16 —
below the 44px min. Big buttons (submit 72px, radio cards 228px) already fine.

**Changes:**
- Storefront terms checkbox 16→ visually ≥24px, tap area ≥44px
  (`checkout.astro:206`).
- Panels: close/delete/settings-row icon buttons → `h-11 w-11` on touch
  (onboarding-modal close `:78`, import delete `:597,:681`, modal closes).

**Verify:** `getBoundingClientRect` ≥ 44 on the touched controls at 375px.

**Effort:** S–M.

### 1.3 Storefront: kill/repair the dead courier card
**Why:** `[data-courier-locked]` card is shown (confirmed live) reading „временно
не работи" `checkout.astro:108`. Long-distance buyers see a dead option and
abandon instead of finding Еконт.

**Changes:** hide the locked card entirely when courier is off; OR replace with a
positive alt-route line („За други градове — Еконт до офис") when Еконт is on.
Gate on the same `ONLY_LOCAL_DELIVERY` flag already in `lib/config`.

**Effort:** S.

### 1.4 Storefront: soften the scary submit label
**Why:** button reads „Поръчка със задължение за плащане" (confirmed live) —
EU-mandated wording but reads bureaucratic/alarming to older buyers.

**Changes:** `checkout.astro:209` — big visual label „Поръчай сега" with the legal
phrase as a small sub-line beneath (keeps legal compliance, lowers fear).

**Effort:** S. (Confirm the legal phrase must remain visible — keep it as sub-line.)

### 1.5 Farmer panel: gated/lock meaning without hover
**Why:** locked nav items show 🔒 with hover-only `title` (`sidebar.tsx:260,271`);
touch users see a lock and assume "broken".

**Changes:** render inline text „(нужен абонамент)" on gated items (or a tap-toggle
popover), not a hover title.

**Effort:** S.

---

## Phase 2 — P2 (discoverability / clarity)

- **2.1** Onboarding teaches a *path* not a *place* — `onboarding-modal.tsx:96`
  prose „Настройки → Конфигурации". Add a real button „Отвори настройките".  (S)
- **2.2** Config routes (`/setup /delivery /slots /features /marketing-tracking`)
  are deep-link only, not in the sidebar (`sidebar.tsx:114`). Surface a labeled
  „Конфигурации" group so returning users can re-find them. (M)
- **2.3** Storefront address hint „Избери адрес от предложенията"
  (`checkout.astro:130`) implies must-pick-or-fail. Soften: „или напиши ръчно —
  ще намерим адреса" (backend geocodes typed text). (S)
- **2.4** Delivery nav label „Внос" → „Качи пратки" (`panel-chrome.tsx:11`). (S)
- **2.5** Storefront mobile hamburger is icon-only (`Header.astro:38`) — add the
  word „Меню". (S)

## Phase 3 — P3 (polish / power-users / durable answer)

- **3.1 „Едър изглед" accessible-mode toggle** — the durable fix for 1.1/1.2/0.2/
  2.5. One switch: ≥16px secondary text, ≥44px targets, icon labels always shown.
  Persist: `users` pref (panels, add column + BFF), `localStorage` (storefront).
  Add a visible toggle in panel topbar + storefront header/footer. (L)
- **3.2** One-tap „Objърkан? Обади се" phone link in the panels for elders who
  panic and want a human. (S)
- **3.3** Storefront guest saved-cart / repeat-order for returning buyers. (M)
- **3.4** Delivery `<select>` options „офис/адрес" → capitalize „Офис/Адрес". (XS)
- **3.5** Farmer dashboard bulk actions from the orders feed (power users). (M)

---

## Suggested execution order

1. **Phase 0** (0.1 email-optional, 0.2 sidebar labels) — highest impact, smallest
   change, ship first.
2. **1.3 + 1.4** storefront (dead card, scary label) — cheap conversion wins.
3. **1.5** gated text, **2.1/2.3/2.4/2.5** copy/label fixes — batch of small edits.
4. **1.1 + 1.2** default text/target floors — broader sweep.
5. **Phase 3.1** accessible-mode toggle — the strategic, durable answer.

## Verification strategy

- Storefront: `preview_start chaika`, seed `localStorage.ff_cart`, drive `/checkout`
  and `/shop` at 375px; assert via `preview_inspect`/eval on `required`, computed
  `fontSize`, and `getBoundingClientRect` heights.
- Panels: bring up full stack (`api-dev` :3001 + Postgres + Redis, `web-dev` :3000,
  `delivery-web` :3009) with an authed cookie, or trust class→pixel 1:1 (proven)
  for pure CSS changes.
- No DB migration required for Phase 0–2. Phase 3.1 adds one nullable `users`
  column (hand-written migration per repo convention — drizzle generate is broken
  since 0059).

## Risk notes

- **0.1 email-optional:** no-email COD buyers get no automated confirmation (no SMS
  fallback exists) — mitigated by the on-screen `/confirmation` and the farmer's
  callback flow. Card buyers still get a Stripe receipt.
- **1.4 label:** keep the mandated „…със задължение за плащане" phrase visible as a
  sub-line for legal compliance.
- Text/target sweeps risk layout shifts — verify each screen at 375px after.
