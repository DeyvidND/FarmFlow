# Carrier verify + multi-farmer split notice + waybill checkbox lock — design

Date: 2026-07-23. Status: approved by operator (chat). Repos: FarmFlow (this repo) + chaika
(`C:\Users\Lenovo\source\repos\fermerski-pazar-chaika`, separate CF Workers repo).

## Context

- Econt + Speedy integrations were live-verified and deployed 2026-06-29 (13/13 post-deploy
  sweep). A month of commits landed since; operator wants re-verification.
- On the chaika marketplace the courier method is fully locked (`ONLY_LOCAL_DELIVERY = true`,
  `src/lib/config.ts:53`) — Econt/courier options are hidden at checkout. **Decision: stays
  locked.** We only prepare the code; delivery launches when farmers are ready.
- Multi-farmer carts: server splits per farmer (1 order + 1 draft shipment per farmer) only
  for `deliveryType: 'courier'` (`orders.service.ts createCourierOrders`). The "split into N"
  message exists only post-purchase (confirmation page). Nothing pre-submit.
- Per-product waybill-fitness checkbox already exists: `products.courierDisabled`
  (schema, product-dialog toggle „Доставка с куриер", batch modal, server backstop in
  `reserveCartItems`). Default = shippable. Operator confirmed: keep this model — all
  products shippable by default, farmer/admin checkbox marks unfit ones.
- Per-farmer carrier creds live in `tenants.settings` jsonb under
  `delivery.farmers.<farmerId>.{econt,speedy}`; `configured` is set only after a successful
  live API call at credential save. `farmerCourierReady = econt.configured ||
  speedy.configured` (`server/src/modules/orders/courier-eligibility.ts`), already enforced
  server-side at courier-split time and exposed publicly as `PublicFarmer.courierReady`.

## Workstream A — live verification of Econt + Speedy (no repo code unless bugs found)

Re-run the 2026-06-29 style sweep against deployed prod:

- Session via dostavki demo account (`neshto@gmail.com`), calls through session + `/bff`.
- Econt (demo env, safe): config/connect state, nomenclature (cities/offices), create test
  waybill + label PDF, track, void.
- Speedy (test account `1996540`): city/street picker (server-side name search), create door
  + office test waybills, label, track, **void every created waybill immediately**.
- Cross-carrier compare returns both prices, picks cheapest.
- Scripts live in the session scratchpad only (they hold creds) — never committed.

Output: pass/fail checklist. Any failure gets diagnosed and fixed in this session (FarmFlow
repo), then re-verified.

## Workstream B — chaika checkout: N-deliveries notice (dormant)

- New info box at checkout, shown only when **cart spans ≥2 farmers AND the selected method
  is a carrier method** (`econt`, `econt_address`, `courier`). Copy (bg):
  „Поръчката съдържа продукти от N производители — ще се създадат **N отделни доставки**,
  по една от всеки фермер, всяка със собствен наложен платеж."
- N = distinct `farmerId` count over cart lines, resolved through the cached bootstrap
  product map (same pattern as `computeCourierEligible` / `initSellersNotice`).
- Re-renders on method change and cart change; hidden for local address/pickup (there the
  order is single — the message would be false).
- `ONLY_LOCAL_DELIVERY` is **not** flipped. While locked, carrier methods are hidden, so the
  box is dormant; it lights up automatically at unlock. No server changes.

## Workstream C — lock the waybill checkbox for farmers without a real carrier account

Panel (`client/`), product dialog + batch courier modal:

- If the product's farmer has `courierReady === false` → the „Доставка с куриер" toggle is
  rendered **disabled and shown off**, with the message: „Докато фермерът не свърже реален
  Еконт/Спиди акаунт, продуктите му не могат да бъдат добавяни към товарителница." For the
  farmer's own account the message points to the Доставки (dostavki) settings to connect.
- Batch modal (`courier-settings-modal.tsx`): same lock per affected farmer; products of
  not-ready farmers are excluded from enabling, with the same explanation.
- **No data rewrite.** Stored `courierDisabled` values are untouched; the lock is purely UI
  plus the already-existing server backstops (`farmerCourierReady` at courier split,
  `reserveCartItems` carrier gate). When the farmer connects a valid account, their
  checkboxes unlock by themselves with prior state intact. (Rejected alternative:
  force-persisting `courierDisabled=true` — would require manual per-product re-enable
  after connecting.)
- Data plumbing: the panel needs `courierReady` per farmer wherever the dialog/modal gets
  its farmer list; expose it on the panel farmers endpoint if not already present (compute
  identical to `farmers.service.ts` public projection).
- Products without `farmerId` (tenant's own) are out of scope — tenant-level creds and
  `deliveriesPackageEnabled` already gate those.

## Acceptance

- A: sweep checklist all green (or failures fixed + re-run green); all test waybills voided.
- B: unit-testable gate function (≥2 farmers × carrier method matrix); `astro check` +
  `tsc --noEmit` clean; local/pickup and single-farmer carts show nothing.
- C: not-ready farmer → toggle disabled + message (dialog + batch modal); ready farmer →
  unchanged behavior; farmer account sees the dostavki-pointing variant; stored values
  never mutated by the lock; client vitest + server jest for touched areas green.

## Out of scope

- Unlocking courier on chaika (operator launches later, farmer-readiness dependent).
- Redesigning the N-deliveries model itself („още не сме решили как да оправим този
  проблем" — the notice is the interim).
- Per-carrier per-product rules (Econt yes / Speedy no).
