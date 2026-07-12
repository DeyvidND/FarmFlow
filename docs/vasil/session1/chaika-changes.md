# chaika (storefront) changes — DOCUMENTED, NOT APPLIED

The storefront **farmmarket.bg** lives in the separate **chaika** repo (Cloudflare Workers) and auto-deploys on push. Per session constraints we do **not** edit it here. The changes below must be applied in the chaika repo by whoever owns it. FarmFlow (this repo) exposes the data these changes consume.

---

## 1. Order-intake cutoff banner (task #13)

**Requirement (Vasil):** "след като затворим приемът на поръчки в сряда в 17ч. (това трябва да го има на видни места в сайта)."
Show the weekly intake cutoff **prominently** on the storefront, and (recommended) stop accepting orders for the upcoming delivery cycle after it passes.

### Data source (already exposed by FarmFlow)
FarmFlow stores the cutoff in `tenants.settings.routing.cutoff = { weekday, hour }` where `weekday` is 0–6 (0=Sunday … 3=Wednesday) and `hour` is 0–23 local (Europe/Sofia). Default `{ weekday: 3, hour: 17 }` (Wednesday 17:00).

This is surfaced on the **public tenant/storefront config payload** (the same public endpoint chaika already reads for storefront settings — e.g. `GET /public/:slug` / storefront bootstrap). Field path on the public payload: `settings.ordering.cutoff` (mirrored from `settings.routing.cutoff`; see FarmFlow public-config mapping). If absent, chaika should default to Wed 17:00.

> ⚠️ Redis caches the public payload ~300 s (TTL). After an operator edits the cutoff, chaika sees the new value only after the cache TTL. Acceptable — the cutoff changes rarely.

### chaika UI changes
1. **Persistent banner** near the top of the storefront (home + product + checkout pages), e.g.:
   > „Приемаме поръчки до **сряда, 17:00 ч.** Поръчки след този час влизат в следващата доставка."
   Localize weekday/hour from the config value (Bulgarian day names, Europe/Sofia).
2. **Checkout reinforcement**: repeat the cutoff line above the „Поръчай" button.
3. **Countdown (optional, nice-to-have):** "Оставащо време за поръчка: 2 дни 3 часа" computed from now → next `{weekday, hour}` in Europe/Sofia.

### Cutoff enforcement (recommended, optional)
The FarmFlow delivery-slots public query already excludes **today's** slots (midnight Sofia). It does **not** yet enforce a specific weekday/hour cutoff. Two options:
- **Chaika-side (simplest):** after the cutoff for the current cycle passes, chaika hides/greys the slot(s) for the imminent delivery day and shows "Приемът за тази доставка е затворен." Purely presentational; uses the same `{weekday, hour}` value.
- **FarmFlow-side (future, if stronger enforcement needed):** add a server guard in the slots public query / checkout that rejects orders for a delivery day whose cutoff has passed. Not built this session; noted as a follow-up. Until then, enforcement is presentational in chaika.

### Timezone
All cutoff math is **Europe/Sofia**. Reuse chaika's existing Sofia-aware date utilities (the storefront already renders slot days in Sofia). Do not compute in UTC.

---

## 2. (No other chaika change required)

Tasks #4, #5, #6, #7 are entirely inside the FarmFlow admin panel + API; the customer storefront is unaffected. The delivery-window **customer notification** (#13) is sent by FarmFlow (email now; see below), not by chaika.

---

## 3. Viber follow-up (task #13 — deferred, needs infra + budget)

**Decision: ship email now; Viber is a documented follow-up.** Vasil asked for "имейл на клиента или най-добре съобщение по вайбър." Feasibility research:

- Sending a Viber message to an **arbitrary customer phone number** requires **Viber Business Messages**, only available through a **BSP** (Business Solution Provider: Infobip, CM.com, D7, BSG, Messaggio, etc.), plus a registered Viber sender ID.
- **Cost:** a minimum monthly commitment of **~175 €/sender/month** for traffic to Bulgaria (Viber's higher-tier country group), on top of per-message fees (~0.0025 €+, transactional cheaper than promotional). First calendar month after registration is free.
- The **free Viber Bot / Public Account API** (`developers.viber.com`) can only message users who have **already added your bot and messaged it first** — it cannot cold-message a customer by phone number. So it does not fit "notify the customer of their delivery window" unless every customer first subscribes to a FarmFlow Viber bot.
- **Recommendation:** launch delivery-window notifications over **email** (already built this session — `order-email.sendDeliveryWindow`). Revisit Viber once volume justifies a BSP contract. When adding it:
  1. Sign up with a BSP, register a Viber sender ("ФермериБГ"), complete brand verification.
  2. Add `VIBER_BSP_*` credentials to server env.
  3. Implement a `ViberService.sendDeliveryWindow(phone, text)` behind the same notify orchestration; the notify endpoint is already channel-extensible (loops orders, picks a channel). Prefer Viber when the customer has a Viber-capable number, else fall back to email.
  4. SMS via the same BSP is a cheaper universal fallback if Viber verification is slow.

Sources consulted: Infobip Viber pricing, Messaggio Viber-for-business guide, Viber REST Bot API docs, CM.com Viber docs.
