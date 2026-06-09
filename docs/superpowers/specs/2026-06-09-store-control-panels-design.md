# Store control panels — design (2026-06-09)

Branch: `feat/cod-payment-method`. Supersedes the single nested «Доставка и плащане» card page (commits 6025566/b7f5523) with a cleaner split.

## Problem

The previous step folded ALL delivery + payment configuration (Econt connection, sender, package, office map, shipments table, pricing) inline into cards on `/delivery`. Result: deeply nested, hard to scan. The detailed config and the high-level on/off switches got merged into one mega-page.

## Principle

**Panels own the on/off switches. Pages own the configuration.** Turning a feature on in a panel "unlocks" it — its nav item / storefront section activates — and the detailed settings live on that feature's own (old) page.

## Part 1 — Restore the old pages (undo the nesting)

- Restore the pre-panel `/delivery` page from git (`methods-section`, `pricing-section`, `payment-section`, `econt-section`, the old `delivery-client`, old `page.tsx`). `/payments` and `/slots` are untouched.
- **Remove the on/off switches from the restored `/delivery`**: the master delivery toggle, per-method enable toggles, the COD toggle, and the Econt off-mode. Those move to Panel 1. `/delivery` now shows configuration only, for the methods that are enabled in the panel. (Econt manual/auto sub-mode + credentials stay as config on `/delivery`.)
- Delete the nested `delivery-panel.tsx` and `econt-config.tsx`.

## Part 2 — Panel 1 «Доставка и плащане» (new page `/setup`)

Lean cards: icon + one-line plain-Bulgarian explanation + on/off toggle + a «Настрой →» link to the detailed page. No heavy inline config.

| Card | Flag | Link |
|---|---|---|
| Наложен платеж | `cod.enabled` | — |
| Карта (онлайн) | Stripe status (read-only, not a toggle) | «Настрой в Плащания →» `/payments` |
| Вземане от място | `methods.pickup.enabled` | «Настрой →» `/delivery` |
| Лична доставка + слотове | `deliveryEnabled` + `methods.ownSlots.enabled` | «Настрой →» `/slots` |
| Куриер до адрес | `econt.mode` off↔on (manual/auto chosen on `/delivery`) | «Настрой →» `/delivery` |

Saved via the existing `saveDelivery({ deliveryEnabled, delivery })` + tenant update — config shape unchanged, so storefront contract + backend stay intact.

## Part 3 — Panel 2 «Функции на магазина» (new page `/features`)

Lean toggle cards (same card primitive as Panel 1):

| Card | Flag | Notes |
|---|---|---|
| Фермери | `multiFarmer` | exists (tenant column) |
| Подкатегории | `multiSubcat` | exists (tenant column) |
| Статии | `articlesEnabled` | **NEW** flag |
| Отзиви | `reviewsEnabled` | **NEW** flag |

### New flags (`articlesEnabled`, `reviewsEnabled`)
- **Storage:** new tenant columns (mirrors `multiFarmer`/`multiSubcat`). Drizzle schema + migration.
- **Default:** `true` — preserves current always-on behavior for existing farms; a farmer turns a section off if unwanted.
- **Server:** add to `UpdateTenantDto` (+ platform DTO/service), `TenantProfile` (admin `/tenants/me`), and `TenantMeta` public profile (+ Redis cache); bust the tenant cache on save (existing path).
- **Storefront gating (this repo):** hide the articles section + the reviews section/form when the respective flag is off.
- **Admin nav gating:** hide the `/articles` nav link when `articlesEnabled` is off (reviews has no admin nav item).

## Nav & routes

New collapsible nav group **«Магазин»** near the top of the sidebar, holding the two panels:
- `/setup` → «Доставка и плащане» (Panel 1)
- `/features` → «Функции на магазина» (Panel 2)

Detailed pages stay in their current groups (`/delivery` under Доставка, `/payments` under Продажби, catalog/marketing unchanged).

## Out of scope (follow-up)

- **chaika storefront** (separate repo `fermerski-pazar-chaika`): gating its articles/reviews sections by the new flags is a separate task.

## Phasing

A. Server: new flags — Drizzle schema + migration + DTOs + service + TenantMeta + cache. Build `packages/db` (dist).
B. Client: restore old `/delivery` from git; strip on/off switches → config-only. Delete nested panel files.
C. Client: Panel 1 `/setup` (toggle cards + links).
D. Client: Panel 2 `/features` (4 toggle cards).
E. Nav: new «Магазин» group; gate `/articles` link by `articlesEnabled`.
F. Storefront (main): gate articles + reviews sections by the new flags.
G. Build (db + server + client + storefront) + browser-verify on ferma-petrovi.

## Verification

- tsc + lint + build for each workspace touched.
- Migration applies; `/tenants/me` + public profile carry the new flags.
- Browser: panels toggle the flags; `/delivery` shows config-only; turning Статии/Отзиви off hides the storefront sections; nav «Магазин» group renders.
