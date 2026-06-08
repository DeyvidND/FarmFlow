# FarmFlow Admin Panel — User Guide

> **How to read this guide.** Every section below is a **dropdown** — click a title to expand it,
> click again to collapse. Open only what you need so the page stays short and easy to scan.

FarmFlow has **two** panels:

| Panel | Who uses it | URL |
| --- | --- | --- |
| **Super-Admin (Platform)** | You, the operator — onboard farms, disable unpaid ones, change your own password | **http://localhost:3002** |
| **Farmer Admin** | A farm owner — manage their own products, farmers, categories, orders, delivery, route, articles | **http://localhost:3005** |

Both talk to the same API (`http://localhost:3000`, Swagger at `/docs`). Each farm is an isolated **tenant**: a farmer only ever sees and edits **their own** data.

> Demo logins (seed): super-admin `admin@farmflow.bg` / `admin1234`; farm owner `ivan@ferma-petrovi.bg` / `ferma1234`.

> **What's new in this guide.** The Farmer Admin (Part B) now covers the full **Доставка / Еконт** courier integration, the **Маршрут** Google-Maps route planner, **multi-photo galleries** on products / farmers / sections, rich-media **Статии** (video + YouTube/Instagram embeds), the **Имейл клиенти** broadcast tab, and the **location & routing** block in Настройки. Every farmer screen below is captured from the live panel.

> **In-app help (for the farmers themselves).** Beyond this guide, the panel now hand-holds users directly: first login opens a **blocking, self-explaining password modal** (B1); every busy screen has an **„Обяснения"** button (top-right) that opens a short, plain-language help modal for *that* screen (Табло, Поръчки, Продукти, Слотове, Доставка/Еконт, Маршрут); and **Документация** inside the panel opens with a **„Първи стъпки"** quick-start. Keep those in sync when screens change — the in-app copy lives in `client/src/lib/help-content.ts`, `client/src/lib/delivery-data.ts`, and `client/src/app/(admin)/help/page.tsx`.

---

# Part A — Super-Admin Panel (you, the operator)

<details>
<summary><b>A1. Log in</b></summary>

Open **http://localhost:3002** → sign in with your platform admin email + password ("Вход за администратор").

</details>

<details>
<summary><b>A2. The farms list ("Фермери")</b></summary>

You land on the farms table — every farm, its email, order count, **План** (Стандартен / Премиум, with a toggle), **status** (Активен / **Просрочен · N дни** / Спрян), and an access toggle. "Просрочен" means a subscription payment failed and the farm is in its grace window before auto-suspend (see A6).

![Super-admin farms list + disable dialog](images/guide-sa-disable.png)

</details>

<details>
<summary><b>A3. Onboard a new farm ("Нова ферма")</b></summary>

Click **+ Нова ферма** (top-right). Fill:

- **Име на фермата** — the farm name (the public **slug** is derived from this).
- **Имейл** — the owner's login email.
- **Временна парола** — a temporary password. Click **Генерирай** to auto-create a strong one.
- **Телефон** *(optional)*.

Click **Създай**. The farm + its owner login are created instantly.

![Create a farm — Нова ферма dialog](images/feat-02-add-farmer-dialog.png)

**Hand the email + temporary password to the farmer.** On their first login they are **forced to change it** (see B1). Then point a storefront at their slug → see [adding-a-new-storefront.md](adding-a-new-storefront.md).

</details>

<details>
<summary><b>A4. Disable / re-enable a farm (manual override)</b></summary>

Flip the farm's **Достъп toggle**. Disabling asks for confirmation ("Спиране на достъпа", screenshot in A2):

- The farmer **can still log in**, but **route, production, slot creation, and newsletter sending are blocked**, and history is limited to 7 days.
- **Their online store keeps working** (customers can still browse/order).

Re-enabling is immediate (no confirmation). This is a **manual override** — billing normally drives the status automatically (A6), but you can suspend or restore any farm by hand.

</details>

<details>
<summary><b>A6. Billing & premium</b></summary>

Farms are billed automatically through Stripe: **30 € / month** + **2 € per newsletter broadcast** they send. You don't collect anything by hand.

- **План column** — toggle a farm to **Премиум** to make its subscription **free** (no monthly fee, no per-email fee); it stays active forever without a card. Toggle back to **Стандартен** to bill it normally.
- **Status** — driven by Stripe: a successful charge keeps it **Активен**; a failed charge moves it to **Просрочен** with a visible countdown (default **7 days**) and emails the farmer; if still unpaid when the countdown ends, it auto-suspends to **Спрян** (same effect as A4).
- **„Имейл сметки"** page — the per-farm tally of newsletter pushes (now collected automatically via Stripe, not by hand).

**Setup (one-time, to go live):** set `STRIPE_SECRET_KEY`, create the 30 €/mo price (`node server/scripts/create-billing-price.mjs`) → put the id in `STRIPE_BILLING_PRICE_ID`, set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and register a Stripe webhook for `invoice.*`, `customer.subscription.*`, and `checkout.session.completed`. Until then billing is dormant (no charges) and farms run free.

</details>

<details>
<summary><b>A5. Change your own password</b></summary>

Click **Настройки** in the top bar → enter current + new password → **Смени паролата**.

![Super-admin change password](images/feat-03-superadmin-change-password.png)

> The new password must differ from the current one. There is no public sign-up — only you create farms.

</details>

---

# Part B — Farmer Admin Panel (the farm owner)

The farmer logs in at **http://localhost:3005**.

![Farmer admin login](images/guide-login.png)

<details>
<summary><b>The layout at a glance</b></summary>

Every screen shares the same frame: a **left sidebar** with the farm's logo, the full nav, a live **"Сезон активен"** status card, and **Настройки / Изход** pinned to the bottom; a **top bar** with the current page title, a notifications bell, and the farm's avatar. The main area is where the work happens.

The sidebar nav, top to bottom: **Табло · Поръчки · Производство · Продукти · Фермери · Подкатегории · Слотове · Доставка · Маршрут · Плащания · Статии · Имейл клиенти**. Tabs marked **🔒 needs active subscription** are blocked (by you, via A4, or automatically when a subscription lapses) when the farm is disabled. The **Поръчки** item also shows a badge with the count of pending orders.

</details>

<details>
<summary><b>B1. First login — forced password change (blocking modal)</b></summary>

When you onboarded the farm you set a **temporary** password. On first login a **blocking modal** appears over the panel — it can't be dismissed (no X, no backdrop-close) and the rest of the panel stays locked behind it until a new password is set. (The server also enforces this: the `MustChangePasswordGuard` rejects every write while the temp password is in place, so the lock is real, not just visual.)

The modal **explains why** the change matters: the temporary password travelled by email or by hand, so other people may have seen it — a personal password only the farmer knows protects the orders, customers and farm data.

They enter the temporary password as **Временна парола**, choose a **Нова парола** (≥ 6 chars, must differ), confirm it (an eye toggle reveals what they typed), and click **Запази новата парола**. The modal then flips to a clear **„Готово! Паролата е сменена."** confirmation; **Към таблото** unlocks the panel and drops them on the dashboard.

> They can change their password again anytime from **Настройки** (see B13) — that screen now shows an inline green success message instead of redirecting away.

</details>

<details>
<summary><b>B2. Табло (Dashboard)</b></summary>

The daily home screen. Four live stat cards sit across the top:

- **Поръчки днес** — orders today, with the +/− delta vs yesterday.
- **Оборот днес** — today's turnover in € (cancelled orders excluded).
- **Чакам потвърждение** — pending confirmations ("всичко чисто" when zero).
- **Следващ слот** — the next delivery slot (booked/capacity + time window).

Below the cards: **Поръчки за днес** (today's order feed — click a row to open the status panel), a **Бързи действия** card with **Потвърди всички чакащи** (confirm every pending order at once) and **Виж маршрута за днес** (jump to Route), and a **Капацитет днес** panel showing each time slot's fill. If the subscription is disabled, a banner appears and history is limited to 7 days.

![Табло — dashboard](images/guide-dashboard.png)

</details>

<details>
<summary><b>B3. Поръчки (Orders)</b></summary>

The full order list. **Search** by customer name or order ID, and **filter** by status (Всички / Чакащи / Потвърдени / Доставени / Отказани). Columns: time, customer, products, **Доставка** (delivery type), status badge, and total in €.

The **Доставка** column tells you how each order ships at a glance:

- **Адрес** (green pin) — personal/own-slot delivery to the customer's address.
- **Еконт офис** (amber box) — pickup at an Econt office.
- **Еконт адрес** (amber box) — Econt courier to the customer's door.

![Поръчки — orders list with delivery-type column](images/guide-orders.png)

Click any row to open the **order panel** on the right. It shows the full customer block (phone, email, the structured delivery **address** or the chosen **Econt office**), the line items with quantities, the running total, and the status actions — move the order through **pending → confirmed → delivered**, or **cancel** it. Pending orders also badge the sidebar.

![Поръчки — order detail panel](images/guide-order-panel.png)

</details>

<details>
<summary><b>B4. Производство (Production) &nbsp;🔒 needs active subscription</b></summary>

A daily prep/harvest checklist built from the products in **confirmed** orders. Pick a date; the list shows each product, how many orders include it, and the total quantity needed (бр.). Tick rows off as you prepare them — a **Напредък** counter (X/N) and progress bar track completion. The list rebuilds automatically from the day's confirmed orders. (Ticks are a working aid, not saved state.)

![Производство — production prep list](images/guide-production.png)

</details>

<details>
<summary><b>B5. Продукти (Products)</b></summary>

The catalog — the core of day-to-day work. The toolbar shows "X active · Y total" and **+ Добави продукт**. Each card carries the product image, name, weight/category, an **active** toggle (controls whether it shows on the storefront), the price, a stock-status dot, and two actions: **Редактирай** (quick inline edit) and **Снимки** (full editor with the photo gallery).

![Продукти — products list](images/guide-products.png)

**Quick edit (Редактирай)** flips a card into an inline form for the two things that change most often — **Цена (€)** and **Наличност (бр.)** — with **Запази / Отказ** and a delete button right there.

**+ Добави продукт** opens the **Нов продукт** dialog:

![Нов продукт — create dialog](images/guide-product-create.png)

Fields: **Име** (required), **Тегло**, **Категория**, **Цена (€)** (required), **Наличност (бр.)** (empty = unlimited), **Единица** (бр./кг…), **Цвят** (accent colour), and — when the matching toggles are on — **Фермер** (link a producer) and **Подкатегория** (group under a shop section). Click **Създай**.

**Снимки** opens the full **Редакция на продукт** dialog, which adds the **multi-photo gallery** at the top:

![Редакция на продукт — gallery + full edit](images/guide-product-media.png)

- **Снимки (N)** — add as many photos as you like via the **Добави** tile (drag-drop or file picker). Each upload lands in the product's own folder on Cloudflare R2.
- **Reorder** photos by dragging; **photo 0 is the cover** and is auto-synced to the product card and storefront.
- Delete individual photos. The same gallery component powers Farmers and Subcategories.

> **Delete is a soft-delete:** the product is hidden and its name stays reserved per farm. To bring it back, re-activate it rather than creating a duplicate with the same name.

</details>

<details>
<summary><b>B6. Фермери (Farmers)</b></summary>

The producers shown on the storefront. The banner toggle **"Няколко фермери в това стопанство"** turns on multi-producer mode — when on, each product can be tied to a specific farmer and the producer's name appears on products in the shop. With it on you get **+ Добави фермер** and a grid of farmer cards (avatar with colour tint, name, role, since-year, phone, bio, and the count of **свързани продукти**). The pencil opens a panel to edit name/role/bio/colour, manage the farmer's **photo gallery** (same multi-photo manager as products), and link products.

![Фермери — farmers](images/guide-farmers.png)

</details>

<details>
<summary><b>B7. Подкатегории (Categories)</b></summary>

Visual sections that group products in the shop. The banner toggle **"Подкатегории в магазина"** enables them. With it on: **+ Добави подкатегория** and a grid of section cards (hero photo, colour dot, name, description, and **свързани продукти** count). Each becomes a section in the customer-facing catalog. The pencil edits name/description/colour and the section's **photo gallery**.

![Подкатегории — categories](images/guide-subcategories.png)

</details>

<details>
<summary><b>B8. Слотове (Slots) &nbsp;🔒 creating needs active subscription</b></summary>

Personal-delivery time slots for the week; customers pick a free slot at checkout. A master **Доставка** toggle turns own-slot delivery on/off in the shop. The week shows as a 7-day grid (today highlighted), each day listing its time slots with a capacity bar and "booked/max" — colour-coded **свободно** (free) / **почти пълно** (≥ 80 %) / **пълно** (full). **+ Слот** adds a slot (time range + max orders); click a slot pill to remove it. These are *your own* deliveries — for courier delivery use **Доставка → Еконт** (B9).

![Слотове — delivery slots](images/guide-slots.png)

</details>

<details>
<summary><b>B9. Доставка (Delivery)</b></summary>

The delivery control centre. A master **Доставка активна** toggle shows/hides all delivery options in the shop. Sticky **Save / Discard** buttons appear on any unsaved change, and you must enable at least one method before saving. The page is one long form built from five blocks:

![Доставка — full delivery configuration](images/guide-delivery.png)

**1 · Методи за доставка.** Up to four methods, each with its own on/off toggle, a customer-facing **Етикет**, a **Срок** ("1–2 работни дни"), and a pricing rule (**Безплатна / Фиксирана / Според теглото / Безплатна над сума**) plus **кой плаща** (customer or farm) and a minimum-order threshold:

1. **До офис на Еконт** — customer collects from an Econt office.
2. **До адрес (Еконт до врата)** — Econt courier to the door.
3. **Лична доставка** — your own time slots (links to B8).
4. **Вземане на място** — pickup at your location.

**2 · График.** Which weekdays you deliver, the daily **cutoff** time, lead days, same-day toggle, max orders per day, and blackout dates.

**3 · Ценообразуване.** A flat fee, weight tiers, or zone-based pricing, an optional free-over-threshold, and a packaging surcharge.

**4 · Еконт интеграция.** The live courier connection:

![Доставка — Еконт integration block](images/guide-delivery-econt.png)

- **Среда** (Тест / Реално) and the **API потребител / API парола** (stored encrypted, never returned). **Пробвай връзката** validates the credentials live and shows a status badge.
- **Профил на подателя** — sender name, phone, city, and whether you ship **От офис** or **От адрес** (with the office picker / custom address).
- **Пакет по подразбиране** — default weight, dimensions, and contents description.
- **Наложен платеж (COD)** — enable cash-on-delivery and choose who pays the Econt COD fee.
- **Товарителница** — label size (**A4 / A6**) and an **Авто-товарителница** toggle to create waybills automatically.
- **Номенклатури** — last sync date + city/office counts, with **Обнови градове и офиси** to refresh from Econt.

**5 · Пратки.** A table of orders that already have Econt waybills — tracking number, method, status, and shipment history, with actions to refresh or void a label.

</details>

<details>
<summary><b>B10. Маршрут (Route) &nbsp;🔒 needs active subscription</b></summary>

The optimised delivery route for a chosen date, built from confirmed home-delivery orders. The summary reads **stops · km · ~minutes**.

![Маршрут — Google Maps route planner](images/guide-route.png)

- **Order mode** — **По часови слот** (group by booked slot time) or **Най-кратък път** (re-order stops by geography to minimise km).
- **Route end** — **Към фирма** (return to the depot), **Едностранно** (end at the last stop), or **По избор** (end at a custom address from Настройки).
- The **stop list** numbers each delivery with customer, address, and item summary, plus per-stop **Карти** (open that stop in Google Maps) and **Обади** (call) buttons.
- **Google Maps** opens the whole route and **Старт** launches turn-by-turn navigation. Long routes are split into ≤ 9-waypoint **legs** (Google's limit), each leg chaining into the next.
- The right panel is an interactive map of every stop and the start/end points. (Empty when there are no confirmed home-delivery orders for the day.)

</details>

<details>
<summary><b>B11. Статии (Articles) &nbsp;🔒 creating & editing needs active subscription</b></summary>

Blog/news posts for the public storefront. The header shows "X published · Y total"; **Нова статия** creates a draft. Each card has a cover thumbnail, title, a status badge — **Чернова** (draft, hidden) or **Публикувана** (published, live) — and an excerpt. Click a card to open the editor; the trash icon deletes it (with confirmation).

![Статии — articles list](images/guide-articles.png)

The **editor** (`/articles/{id}`) has a **Редактор / Преглед** tab pair, a **Чернова ⇄ Публикувана** publish toggle, and **Запази**:

![Статия — editor with rich-media blocks](images/guide-article-editor.png)

- **Заглавие**, **Кратко описание**, and the **Съдържание** body.
- **Корица** — the cover image (upload / drag-drop).
- **Медия** — rich-media blocks inside the article: **Качи снимка / видео** (image or MP4 to R2) and a **YouTube / Instagram адрес** field that embeds by URL. Blocks can be reordered, captioned, and deleted.
- **Преглед** renders the post exactly as the storefront will show it.

</details>

<details>
<summary><b>B12. Имейл клиенти (Newsletter broadcasts)</b></summary>

Reach the customers who subscribed to the farm's newsletter. The header shows the **active subscriber** count; the **Абонати** list shows each email and signup date.

![Имейл клиенти — newsletter broadcast](images/guide-newsletters.png)

**Ново съобщение** composes a broadcast: a **Тема** (subject) and **Съобщение** (body), then **Изпрати**. A confirmation step shows the recipient count before anything goes out, and a toast reports how many emails were sent. (Empty state: "Все още няма абонати.") **Each broadcast costs 2 €**, added to the farm's monthly subscription bill (see B13a) — unless the farm is **Премиум** (free). Sending is blocked while the subscription is suspended.

</details>

<details>
<summary><b>B13a. Плащания (Payments & subscription)</b></summary>

Two things live here:

**Абонамент (subscription)** — the farm's plan for using FarmFlow:

- **Стандартен** — **30 € / месец** + **2 € на изпратен бюлетин**, billed automatically.
- **Add a card** with **Добави карта** (a secure Stripe checkout). After that the card is charged each month; **Управление на плащането** opens the Stripe portal to update the card or see invoices.
- A status badge shows **Активен**, **Просрочен** (a payment failed — a countdown shows how many days before the shop is paused; just update the card), or **Спрян**.
- **Премиум** farms see **„Премиум — безплатно"** and are never charged.
- A green nudge appears on the **Табло** until a card is added.

**Приемане на плащания с карта (storefront orders)** — connect Stripe so customers can pay online; the money goes straight to the farm's bank account. **FarmFlow takes 0 % of orders** — the farm keeps everything (minus Stripe's own processing fee).

Connecting is via a **Standard** Stripe account — the farmer signs Stripe's terms directly, gets their own full Stripe Dashboard, and bears all liability (refunds, disputes, negative balance); the platform carries none of it. Because Standard accounts can't use Stripe's embedded components, the Плащания page is a **native FarmFlow dashboard** (status, balance, next payout, recent payments) with an **„Отвори Stripe"** button to the farmer's own dashboard for refunds/disputes.

**Connect guide (shown in-app on the CTA + under Документация → „Как да свържа Stripe"):**

1. Have ready: **лична карта, IBAN, телефон, имейл** (~5 min).
2. **Плащания → „Свържи Stripe"** opens Stripe's secure hosted onboarding.
3. Choose **физическо лице / фирма**, fill name + address + date of birth.
4. Add the **IBAN** Stripe will pay out to; sometimes Stripe asks for an ID photo.
5. Return to the panel — status flips to **„Свързано"** and card checkout goes live.
6. Payouts land automatically (typically 2–7 days); refunds/disputes are handled in the farmer's own Stripe via **„Отвори Stripe"**.

> Both are dormant until the operator configures Stripe (A6). With no Stripe keys, the page shows a "not activated" state and nothing is charged.

</details>

<details>
<summary><b>B13. Настройки (Settings)</b></summary>

Account and farm configuration, in two cards.

![Настройки — password + location & routing](images/guide-settings.png)

**Смяна на парола** — change the password anytime: **Текуща парола**, **Нова парола** (≥ 6 chars, must differ), **Потвърди нова парола**, then **Смени паролата**. On success the card shows an inline green **„Паролата е сменена успешно"** confirmation and clears the fields (it no longer redirects away). The first-login forced change uses the dedicated modal instead (B1).

**Локация и маршрут** — the farm's logistics base:

- **Адрес на базата (дом)** — your depot/start address, saved as a point on the map and used as the **origin** for every route (B10).
- **Край на маршрута** — where routes end by default: **Към дома** (back to base), **Едностранно** (stop at the last delivery), or **По избор** (a custom end address, revealed when selected).
- **Запази локацията** stores the choice as the routing default.

</details>

---

<details>
<summary><b>How it reaches the public website</b></summary>

Everything a farmer creates here is served to their storefront through the public API
(`/public/<slug>/…`). To connect or add a storefront site, see
**[adding-a-new-storefront.md](adding-a-new-storefront.md)**.

</details>

<details>
<summary><b>Quick reference</b></summary>

| Action | Where |
| --- | --- |
| Onboard a farm | Super-admin (3002) → **Нова ферма** |
| Disable/enable a farm | Super-admin (3002) → farm **toggle** |
| Super-admin password | Super-admin (3002) → **Настройки** |
| Farmer first-login password | Farmer (3005) → forced **modal** on first login |
| Per-screen in-app help | Farmer (3005) → **„Обяснения"** button (top-right) |
| Full in-app guide | Farmer (3005) → **Документация** (start at „Първи стъпки") |
| Add product + photo gallery | Farmer (3005) → **Продукти → Снимки** |
| Manage farmers / sections | Farmer (3005) → **Фермери / Подкатегории** |
| Orders & statuses | Farmer (3005) → **Поръчки** |
| Configure courier / Econt | Farmer (3005) → **Доставка → Еконт интеграция** |
| Plan the day's route | Farmer (3005) → **Маршрут** |
| Publish an article | Farmer (3005) → **Статии** |
| Email the subscribers | Farmer (3005) → **Имейл клиенти** |
| Set depot & route end | Farmer (3005) → **Настройки → Локация и маршрут** |
| API reference | **http://localhost:3000/docs** |

</details>
