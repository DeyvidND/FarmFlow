# FarmFlow — Admin Flow Usability Audit

**Scope:** the **Farmer Admin** panel (`client/src/app/(admin)/…`, port 3005) — the day-to-day
software a non-technical farm owner uses. The Super-Admin panel (operator) is out of scope.

**Lens:** "a farmer should never get stuck, confused, or surprised." Every finding below is a place
where a non-technical user can misread the screen, lose work, or hit a dead end — with the exact
file/line evidence and a concrete fix.

**Verdict:** the panel is genuinely well built for farmers — it already has plain-language helpers,
optional-step badges, "Обяснения" modals, good empty states, and optimistic updates. The problems
are a handful of **real bugs** (a screen frozen on a demo week, a dead date picker, lost checklist
progress) and a set of **comprehension/safety frictions** (no lock cues, destructive taps without
confirm, machine-style order IDs, duplicated toggles). Fix the three P0 bugs first — they make the
software look broken.

Severity key: **P0** = broken/misleading in production · **P1** = high friction or risk · **P2** =
clarity/polish.

> **Status (branch `feat/media-galleries`): all findings below have been addressed.** The three P0
> bugs are fixed, P1/P2 friction is resolved, and a per-tenant sequential order number was added
> (schema + migration `0024` + backfill). Client and server typecheck clean and the migration is
> applied. Remaining follow-up lives in the **storefront repo** (show the new order number on the
> customer confirmation page) — see the note at the end.

---

## P0 — Bugs that make the panel look broken

### P0-1 · The Слотове screen is frozen on a past demo week (every farm, forever)
- **Where:** `client/src/app/(admin)/slots/page.tsx:9-17` hardcodes `WEEK = ['2026-05-25' … '2026-05-31']`,
  fetches slots only for that fixed window (`:25`), and passes `days={WEEK}` to the client.
  `client/src/components/slots/slots-client.tsx:17` hardcodes `TODAY = '2026-05-30'` and `:73-74`
  prints the literal header **"Седмица 25 – 31 май 2026 · Варна"**.
- **Why it hurts:** today is past that window, so the farmer always sees a stale week, the **"ДНЕС"**
  highlight (`d === TODAY`) never lands on the real current day, and **every farm reads "Варна"**
  regardless of where it is. The whole slot grid is untrustworthy.
- **Fix:** compute the current week server-side (mirror `bgToday()` in `route/page.tsx:13-20`), fetch
  that range, and derive the header label + "today" highlight from the real date. Drop the hardcoded
  city — use the tenant's town.

### P0-2 · The Маршрут date control looks clickable but does nothing
- **Where:** `client/src/components/route/route-client.tsx:191-195` renders a calendar-styled control
  (`CalendarDays` + `dateLabel` + `ChevronDown`) — visually identical to the **working** production
  date picker — but has **no `<input type="date">` and no `onClick`**. Compare the production one
  (`prep-list.tsx:40-55`) which hides a real `<input type="date">` behind the same styling.
- **Why it hurts:** the route page defaults to today (`route/page.tsx:49`), but a farmer who wants
  *tomorrow's* route taps the date and nothing happens. The only way to change it is hand-editing the
  URL `?date=`. A control that looks interactive and isn't is the classic "is it broken?" moment.
- **Fix:** copy the hidden-`<input type="date">` pattern from `prep-list.tsx` and push
  `/route?date=…` (keep the current `end`/`order` params, like `go()` already does).

### P0-3 · Production checklist progress vanishes on refresh
- **Where:** `client/src/components/production/prep-list.tsx:24` keeps tick state in local
  `useState` (`const [done, setDone] = useState({})`); the comment at `:11` is explicit: *"tick state
  is local UI only."*
- **Why it hurts:** the harvest list is used over hours, often on a phone that sleeps. Any refresh,
  navigation, or device switch wipes every checkmark — the farmer loses their place mid-pick. The guide
  even apologises for it ("Ticks are a working aid, not saved state"), which is a sign the behaviour is
  wrong, not that it needs documenting.
- **Fix:** persist ticks per (tenant, date, product) — server-side, or at minimum `localStorage`
  keyed by date so a refresh restores progress.

---

## P1 — High friction & safety

### P1-1 · No lock cue in the sidebar for subscription-gated screens
- **Where:** `client/src/components/layout/sidebar.tsx:32-44` renders all 11 nav items identically.
  The guide promises tabs marked **"🔒 needs active subscription"** (Производство, Маршрут, Слотове
  creation, Статии) are blocked when the farm is disabled — but the sidebar shows **no lock icon and
  no disabled state**. The disabled-state banner only appears *after* you land on the page
  (`dashboard-client.tsx:87-95`).
- **Why it hurts:** a farmer whose subscription lapsed clicks Производство, lands on a blocked/empty
  screen, and has no idea why at the moment of clicking.
- **Fix:** when `subscriptionActive` is false, render a lock glyph + tooltip
  ("Изисква активен абонамент") on the gated items, and dim them.

### P1-2 · "Откажи" cancels an order instantly, with no confirmation
- **Where:** `client/src/components/orders/order-panel.tsx:99-103` — the **Откажи** button fires
  `onAction('cancelled')` on a single tap. Cancelling is destructive and customer-facing, yet
  deleting a *product* (a less serious act) **does** ask first (`products-client.tsx:72`
  `window.confirm`). Inconsistent and risky.
- **Secondary:** the same panel lets a farmer mark a still-**pending** order **"доставена"**
  (`:94`), silently skipping the confirm step; once an order is delivered/cancelled there are no
  actions left — **no undo**.
- **Fix:** add a confirm step for cancel (with the customer name), and show an "Отмени" undo toast
  after status changes.

### P1-3 · Orders are identified by a random hex hash
- **Where:** `orders-client.tsx:120` and `order-panel.tsx:37` show `#${id.slice(0,8)}` — e.g.
  `#a3f9c1b2`.
- **Why it hurts:** when a customer calls about "my order", the farmer has nothing human to match it
  to. Eight random hex characters are impossible to read aloud or remember.
- **Fix:** add a per-farm sequential order number (e.g. **#0042**) and show that everywhere a farmer
  or customer sees an order.

### P1-4 · The same "Доставка" flag is toggled from two different screens
- **Where:** the **master toggle** on the Delivery page (`delivery-client.tsx:110`, saves
  `deliveryEnabled`) and the **"Доставка" toggle** on the Slots page
  (`slots-client.tsx:85-88`, calls `setDeliveryEnabled`) flip the **same** underlying flag.
- **Why it hurts:** toggling it in one screen leaves the other showing the old value until a reload,
  and the farmer can't tell which switch "really" controls the shop.
- **Fix:** keep one authoritative control. On Slots, either mirror the value read-only with a link to
  Delivery, or make both reflect a shared store so they never disagree.

### P1-5 · "Край на маршрута" is set in two places
- **Where:** Settings persists it (`settings/page.tsx:184-203`, `routing.endMode`), while the Route
  page has its own end-mode toggle driven by the URL (`route-client.tsx:174-190`).
- **Why it hurts:** two sources of truth for one preference. Changing it on the Route screen is a
  per-view override that doesn't update the saved default — the farmer can't tell what "sticks".
- **Fix:** make the Route toggle a transient override of the saved default and label it as such, or
  offer "запази като по подразбиране" so there's one obvious home for the setting.

---

## P2 — Clarity & polish

### P2-1 · Native `window.confirm` for product delete breaks the design + misstates the risk
- **Where:** `products-client.tsx:72` `window.confirm('Изтриване на „X"?')`. It's the only native OS
  dialog in an otherwise polished sonner/modal UI, and the wording implies permanent loss — but delete
  is a **soft-delete** (the product can be re-activated; the guide says so). Fix: use the app's modal
  and say it can be brought back.

### P2-2 · "Наличност (бр.) empty = unlimited" is a hidden convention
- **Where:** guide B5; create dialog field. An empty stock field meaning *unlimited* is unintuitive —
  many farmers will read empty as "0 / out of stock". Fix: an inline hint
  ("остави празно = без лимит") right on the field.

### P2-3 · "Cover = photo №1" leaks an index concept
- **Where:** guide B5 ("photo 0 is the cover"); `products-client.tsx:58-60`. Reordering photos by drag
  *silently* changes the storefront cover. Fix: an explicit **"Направи корица"** action and a visible
  **"Корица"** badge on the current cover, instead of relying on position.

### P2-4 · "Потвърди всички чакащи" bulk-confirms with no pre-confirmation
- **Where:** `dashboard-client.tsx:44-66` — confirms every pending order in one click; the count only
  appears in the *after* toast. Lower risk than cancel, but still a bulk action. Fix: a one-line
  "Потвърди N поръчки?" step.

### P2-5 · Flat 11-item sidebar, no grouping
- **Where:** `sidebar.tsx:32-44`. Delivery-related screens (**Слотове, Доставка, Маршрут**) are
  scattered through the list, and "daily work" vs "setup" aren't visually separated. Fix: light
  grouping — e.g. *Ежедневие* (Табло, Поръчки, Производство, Маршрут) · *Каталог* (Продукти, Фермери,
  Подкатегории) · *Доставка* (Слотове, Доставка) · *Съдържание* (Статии, Имейл клиенти).

### P2-6 · Two documentation surfaces drift apart
- **Where:** the in-app `/help` page (`help/page.tsx`) and `docs/admin-panel-guide.md` duplicate the
  same content but are maintained separately; the in-app version omits the first-login/password
  section. Fix: single-source the copy (or cross-link), so they can't diverge.

### P2-7 · "Старт" opens several browser tabs for long routes
- **Where:** `route-client.tsx:133` `urls.forEach((u) => window.open(...))` — a route over 9 waypoints
  opens multiple Google Maps tabs. On a phone these may be popup-blocked or just confusing despite the
  explanatory toast. Fix: open the first leg and offer "следваща отсечка" buttons, or a single chained
  link where possible.

---

## What's already good (keep it)

- **Forced password change** is enforced edge-side and can't be bypassed
  (`middleware.ts:81-93`) — a farmer can't wander the panel on a temporary password.
- **Delivery onboarding** is excellent: "Три прости стъпки", "по желание" badges, an "Обяснения"
  help modal, and advanced options collapsed by default (`delivery-client.tsx:121-139`,
  `econt-section.tsx`). This is the model the rest of the panel should copy.
- **Plain-language hints + an expandable explainer** on the Route screen specifically aimed at
  "farmers who aren't used to the tech" (`route-client.tsx:206-238`).
- **Optimistic updates with rollback** on every toggle (products, slots, farmers), so the UI feels
  instant but self-corrects on error.
- **Good empty states** across products, farmers, production, and newsletters — each tells the farmer
  what to do next, not just "no data".
- **Stale/expired session cleanup** (`(admin)/layout.tsx`, `middleware.ts`) prevents the
  empty-broken-panel trap.

---

## Suggested order of work

1. **P0-1, P0-2, P0-3** — the three bugs; they read as "the app is broken".
2. **P1-1, P1-2** — lock cues + cancel confirmation; cheap, high trust gain.
3. **P1-3** — human order numbers; touches data model, plan it deliberately.
4. **P1-4, P1-5** — de-duplicate the toggles/settings.
5. **P2-*** — polish pass once the above land.

---

## Follow-up (separate storefront repo)

The per-tenant **order number** (P1-3) now flows through the API — it's on `GET /orders`,
the order panel, and the public order summary (`PublicOrderSummary.orderNumber`). The customer-facing
**confirmation page lives in the separate storefront repo** (`fermerski-pazar-chaika`), so surfacing
`#42` there instead of the UUID is a one-line change to make in that project.

Optional: re-running the seed (`pnpm --filter @farmflow/db seed`) renumbers the demo orders
chronologically; the migration already backfilled existing rows, so this is only for a clean demo.
