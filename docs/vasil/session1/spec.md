# Session 1 — Маршрути & Слотове — Spec

Operator: Vasil. Branch: `feat/vasil-routes-slots`. Migration lane: **0093–0096** (latest on main = 0092).

Apps: NestJS API `server/`, Next.js admin `client/` (`@fermeribg/web`, port 3000, the real admin UI under `client/src/app/(admin)/`), Drizzle DB `packages/db`. Storefront = **chaika** (separate repo — DOCUMENT ONLY, never edit).

## Ground truth from scouting

- **Routes are ephemeral**: `GET /orders/route?date&couriers&end&ends` computes routes on demand from the `orders` table (confirmed, address delivery, scheduled that day). There is **no** persistent route/route-stop/courier table. `RouteStop` is a runtime interface `{ id, customer, phone, email, address, note, lat, lng, summary }` — no orderNumber, no value fields.
- **Courier split** = automatic `sweepSplit()` over N couriers (`settings.routing.courierCount`, clamp 1–10). Couriers are anonymous indices, not named people.
- **Manual reorder** = client-only, stored in `localStorage` key `ff:order:${date}:${courierIdx}`; reconciled against server stops on fetch. **Straight-lines bug**: `route-client.tsx` `displayRoutes` memo (~line 351) sets `polyline: isManualOrder || finishedIds.size>0 ? null : r.polyline`. When overridden, the server's road-following polyline is discarded → map draws naive straight pin-to-pin segments.
- **End point infra already exists**: `RouteEndMode = 'home'|'last'|'custom'`; `settings.routing.{endMode,endAddress,endLat,endLng}`; per-courier modes via `?ends=` csv; `endPoint()`/`endForMode()` feed the optimizer. BUT `'home'` currently loops back to the **farm origin** (market), not a courier's real home; there is **no per-courier home coordinate** and **no config UI**.
- **Orders**: `orders.totalStotinki` = grand total **with** delivery. **No** separate delivery-fee column. Goods subtotal = Σ `orderItems.priceStotinki × quantity`. Delivery fee = `total − subtotal` (clamp ≥ 0). Order carries `customerEmail`, `customerPhone`. Frontend order type **already** has `items[]` (productName, quantity, priceStotinki) + `totalStotinki`.
- **Email**: nodemailer SMTP 587 via BullMQ `EMAIL_QUEUE`; customer templates in `server/src/modules/order-email/order-confirmation.service.ts` (`sendReceived/sendForOrder/sendMoved`). Repeatable/worker pattern: `@Processor(QUEUE, {concurrency})` extends `WorkerHost`.
- **Viber**: nothing automated exists. Cold-messaging a customer by phone requires Viber **Business Messages** through a BSP (Infobip/CM.com/etc.), ~**175 €/mo** minimum for Bulgaria. Free Viber Bot API only reaches users who already subscribed to the bot. → **Ship email now; Viber = documented follow-up.**
- **Migrations**: runtime `drizzle-orm` `migrate()` reads `packages/db/drizzle/*.sql` + `meta/_journal.json` only (no per-migration snapshot needed — meta dir is sparse). New migration = `.sql` file (idempotent `IF NOT EXISTS`) + sequential `_journal.json` entry `{idx, version:"7", when:<unix_ms>, tag, breakpoints:true}`. **Never leave an idx gap.** Applied in prod via `deploy.yml` migrate image before app boot.

## Task specs

### #4 — Order/product value + value-with-delivery (Поръчки + Маршрут)
Show, in both the Orders screen and the Route screen: goods value (products subtotal), the product line items with their prices, and — separately — the total **with** delivery.
- Money model: `subtotal = Σ items.price×qty`; `deliveryFee = max(0, total − subtotal)`; `total = totalStotinki`.
- Orders panel/list: no backend change (fields already present) — pure frontend breakdown.
- Route screen: backend must enrich each `RouteStop` with `itemsSubtotalStotinki`, `deliveryFeeStotinki`, `totalStotinki` (join order_items in `getRoute`).

### #5 — Two couriers + fix manual-reorder straight lines
- Two couriers already produce two routes via auto-split; keep that.
- **Fix straight lines**: add backend endpoint that returns a **road-following polyline + distance/duration for an explicit (operator-chosen) stop order** (no re-optimization — respect the given order). Frontend calls it after manual reorder / move and uses the real polyline instead of `null`.

### #6 — Per-courier daily money + move order between couriers
- Per-courier tab shows daily totals: goods value, delivery fee, total-with-delivery (summed from the enriched stops of that courier).
- **Move order courier↔courier**, persisted, with route recompute. Add `orders.courier_index` (nullable smallint). `getRoute` respects explicit assignments (overridden orders forced into their courier; remaining auto-split); out-of-range indices (courier count lowered) ignored → fall back to auto. Endpoint to set/clear an order's courier index; frontend refetches route after.

### #7 — Configurable END point "У дома" (per courier)
- Add per-courier home/end coordinates in `settings.routing.couriers[i] = { endMode?, homeAddress?, homeLat?, homeLng? }` (index-aligned; falls back to global `endMode`/`endAddress/Lat/Lng`).
- `getRoute` resolves each courier's end from its home coords (treated as a `custom` end) so the optimizer ends that courier's leg near their home.
- Config UI in the route page (per active courier): set home address, pick on map / reverse-geocode (reuse existing `/orders/route/reverse-geocode` + pick-map pattern), persist to settings.

### #13 — Per-order time slots + customer notification (the innovation)
- Add order columns: `delivery_window_start` (text 'HH:MM'), `delivery_window_end` (text 'HH:MM'), `delivery_window_status` (text: `draft|approved|sent`, default null), `delivery_window_notified_at` (timestamptz).
- **Generate**: endpoint computes a window per order for a day from the optimized per-courier routes — day start hour (`settings.routing.dayStartHour`, default 9) + accumulated drive time (from route legs) + fixed service time per stop, rounded to a window (e.g. ±/round to configurable slot size, default 60 min). Saves as `draft` on each order. Returns proposal.
- **Review/edit**: operator lightly edits a window (PATCH per order) in the маршрути section.
- **Approve**: mark day's windows `approved`.
- **Notify**: enqueue emails (new `order-email` method `sendDeliveryWindow`) to customers with approved windows; set `delivery_window_notified_at` + status `sent`. Channel-extensible for future Viber. Skip orders without email (surface count).
- **Cutoff**: `settings.routing.cutoff = { weekday, hour }` (default Wed=3, 17) — consumed by chaika storefront banner + intake close. FarmFlow side: expose in settings; the enforcement/banner is a **chaika change → documented only** in `chaika-changes.md`.

## Migrations (this session)
- **0093_order_courier_index** — `orders.courier_index smallint` (nullable).
- **0094_order_delivery_window** — `orders.delivery_window_start text`, `delivery_window_end text`, `delivery_window_status text`, `delivery_window_notified_at timestamptz`.
- Per-courier home, day start, cutoff → `settings` jsonb (no migration).

## Execution partition (no shared-file races)
- **Backend agent** owns `server/`, `packages/db` (schema + both migrations).
- **Route-frontend agent** owns `client/src/components/route/**`, `client/src/app/(admin)/route/**`, and shared `client/src/lib/api-client.ts` + route types in `client/src/lib/types.ts`.
- **Orders-frontend agent** owns `client/src/components/orders/**`, `client/src/app/(admin)/orders/**` only (uses existing `items[]`/`totalStotinki`; no api-client/types edits). Runs in parallel with route-frontend (disjoint files).
- Frontend agents start only after backend agent completes (they depend on new endpoints/types).

## Verification
- `pnpm --filter @fermeribg/db build`; server `pnpm --filter <server> build` + `jest`; `client` `next build` (or `tsc`)/`vitest`.
- Validate `_journal.json` parses and idx sequence 0..94 has no gap.
- Drive affected admin flows where feasible.

## Out of scope / documented follow-ups
- Viber Business Messages (needs BSP + ~175 €/mo) — email shipped, Viber documented.
- chaika storefront Wed-17:00 cutoff banner + intake close — documented in `chaika-changes.md`.
