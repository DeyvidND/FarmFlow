# Admin UX fixes — 5-part round (2026-06-19)

Five farmer-facing UX improvements in the FarmFlow admin panel, spanning the
admin client (this repo), the API (`settings.landing` schema), and the chaika
storefront (`fermerski-pazar-chaika`, separate repo, auto-deploys).

No DB migration: `settings.landing` is a jsonb leaf, schema-flexible.

---

## #1 — Stripe explanation: clearer two-part framing

**Problem:** Farmers are confused that they "must connect to Stripe" — they don't
understand Stripe is an account *they create* that unlocks card payments.

**Change:** `ConnectCta` in `client/src/components/payments/payments-client.tsx`
(the not-connected explainer on the Плащания → Карта tab) is reworded into two
explicit parts:

1. **What Stripe is** — Stripe е безплатна услуга, в която си правиш сметка
   (акаунт). Тя ти позволява да приемаш плащане с карта в магазина.
2. **What happens** — свързваш магазина към сметката еднократно; клиентите
   плащат онлайн, парите идват по твоята банкова сметка. 0% комисиона, ~5 минути.

Keep the existing steps list + "Какво ти трябва" panel (Лична карта / IBAN / ~5
мин). Also tighten `CARD_COPY` in `client/src/components/panels/setup-panel.tsx`
to lead with the same "направи си сметка в Stripe → приемаш карти" framing.

Copy-only. No logic, no API change.

---

## #2 — Sidebar reflects the current page

**Problem:** Config screens (`/setup`, `/delivery`, `/slots`, `/features`,
`/marketing-tracking`) are reached via deep links (e.g. setup-panel's "Управлявай
слотовете" → `/slots`) but are **not** sidebar items. On those pages nothing in
the sidebar is highlighted, so the user can't tell where they are or get back.

**Change** (`client/src/components/layout/sidebar.tsx`):

- Add `isConfigRoute(pathname)` — true for the standalone config routes above
  (exact match or `startsWith(route + '/')`).
- The **Настройки** footer link highlights as active when
  `pathname.startsWith('/settings')` **or** `isConfigRoute(pathname)`. (Config
  screens live under Настройки → Конфигурации, so Настройки is the right anchor.)
- **Auto-scroll active item into view:** on `pathname` change, query the `<aside>`
  for `[data-on="true"]` and call `scrollIntoView({ block: 'nearest' })`. Covers
  long Каталог/Маркетинг lists where the active item can be scrolled off.

No behavior change to which routes exist; purely sidebar feedback.

---

## #3 — Hide Маршрут + Часове за доставка when personal delivery is off

**Problem:** A farm that only does pickup / Еконт courier never uses personal
delivery routes or time-slots, but Маршрут (sidebar) and Часове за доставка
(Конфигурации) are always shown.

**Gate on `deliveryEnabled`** (the "Лична доставка + слотове" toggle in Методи и
цени; already on the tenant profile as `me.deliveryEnabled`):

- `client/src/app/(admin)/layout.tsx` passes `deliveryEnabled={me.deliveryEnabled
  ?? false}` → `AdminShell` → `Sidebar`.
- `Sidebar` drops the `/route` (Маршрут) nav item when `!deliveryEnabled`.
- `ConfigurationsCard` gains a `deliveryEnabled` prop (from the settings page
  loader) and drops the `slots` (Часове за доставка) tile when `!deliveryEnabled`.

Both reappear immediately once personal delivery is toggled on (the toggle lives
in Методи и цени, which stays visible regardless, so there's no dead-end).

---

## #4 — Landing block descriptions explain what each block does

**Problem:** On Настройки → Начална страница the block descriptions just repeat
the block name ("Блок „Запознай се с фермерите“.") and don't say what the block
actually shows.

**Change** (`client/src/components/settings/landing-card.tsx`, the `ROWS` descs +
the Отзиви desc): rewrite to plain, outcome-oriented Bulgarian. Draft:

- **Категории** — „Плочки с разделите в магазина (напр. Зеленчуци, Млечни).
  Клиентът цъка и стига право до тях.“
- **Фермери** — „Показва производителите, чиято стока продаваш — снимка и кратко
  описание. Клиентът вижда кой стои зад продуктите.“
- **Най-актуални** — „Лента с продукти на видно място горе на началната
  страница — за да грабнат окото веднага.“
- **Отзиви** — keep current (already explanatory).

Copy-only.

---

## #5 — Pick specific items per block (all 3 blocks), Auto/Manual toggle

**Problem:** Categories / Фермери / Най-актуални blocks only let the farmer pick
*how many* (Брой), not *which ones*. A farmer who wants to feature three specific
producers or hand-pick the headline products can't.

**Decision (from brainstorm):** all three dynamic blocks get a manual-pick option;
each block has an **Автоматично / Избери ръчно** mode toggle. Reviews already work
this way (a pure picker) and stay unchanged.

### Data model

Extend `LandingBlock` (jsonb, no migration):

```ts
interface LandingBlock {
  show: boolean;
  mode: 'auto' | 'manual';   // NEW — default 'auto'
  count: number;             // used when mode === 'auto'
  ids: string[];             // used when mode === 'manual' (ordered, deduped, capped 12)
}
```

`ReviewsBlock` (`{ show, ids }`) is unchanged.

**Backward compatibility:** old saved configs have no `mode`/`ids` → resolve to
`mode: 'auto'`, `ids: []` → render exactly as today.

### Server — `server/src/modules/tenants/landing.ts` + `dto/landing.dto.ts`

- `resolveBlock` resolves `mode` (`'manual'` only if literally `'manual'`, else
  `'auto'`) and an ordered/deduped/capped (12) `ids: string[]`. `count` clamp
  unchanged (cats min 0, farmers/latest min 1).
- `DEFAULT_LANDING` blocks gain `mode: 'auto'`, `ids: []`.
- DTO `LandingBlockDto`: add optional `mode` (`@IsIn(['auto','manual'])`) and
  optional `ids` (`@IsArray @ArrayMaxSize(12) @IsUUID('all', { each: true })`).
  Service `resolveLanding` stays authoritative (re-clamps).
- Update `landing.spec.ts` accordingly + add mode/ids round-trip + legacy-config
  cases.

### Admin — `client/src/components/settings/landing-card.tsx`

- `LandingConfig` type (in `api-client.ts`) extended to match.
- For each of the three blocks, render a small segmented control
  **Автоматично | Избери ръчно** under the toggle.
  - **Автоматично:** the existing Брой dropdown.
  - **Избери ръчно:** a checklist (reuse the existing reviews-checklist markup —
    extract a small shared `<PickList>` if it reduces duplication) showing the
    block's items: subcategories / farmers / products. Cap 12, "Избрани: N/12",
    picked order preserved (append on check).
- Lazy-load the option lists once when first needed: `listSubcategories()`,
  `listFarmers()`, `listProductOptions()` (the last already returns `{id,name}`).
  Empty list → "Няма … за избор" hint (mirrors reviews empty state).
- `mode === 'manual'` with zero picks: treat as "show nothing" on the storefront
  (the block is effectively empty) — acceptable; the admin shows the 0/12 count
  so it's visible. (Alternative considered: fall back to auto — rejected, hides
  the farmer's intent.)

### chaika — `src/pages/index.astro` (+ `src/lib/types.ts`, `src/lib/config.ts`)

- `types.ts` landing block type + `config.ts` `DEFAULT_LANDING` gain `mode`/`ids`.
- Selection logic per block:
  - **farmers:** `mode === 'manual'` → `L.farmers.ids.map(id => farmers.find(...)).filter(Boolean)`; else `farmers.slice(0, count)`.
  - **latest:** `mode === 'manual'` → pick products by id (preserve order, drop missing); else `featured(products, count)`.
  - **categories:** `mode === 'manual'` → filter `categoriesFrom(...)` to the picked subcat ids in order; else current count behavior.
- All source lists (`farmers`, `products`, `subcats`) are already in `boot`, so no
  new API endpoint — chaika just filters what it already loads.

---

## Out of scope / non-goals

- No DB migration (jsonb leaf).
- No changes to the legacy `storefront/` Next app (not the live storefront).
- Reviews picker logic unchanged.
- No reordering UI beyond pick-order (drag-reorder of picks is a possible later
  nicety, not in this round).

## Deploy notes

- chaika: auto-deploys on push to its main (GH Actions + Dokploy webhook).
- FarmFlow: manual Dokploy redeploy (no migration, no new deps, no new env).
