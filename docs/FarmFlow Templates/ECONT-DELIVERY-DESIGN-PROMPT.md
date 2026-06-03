# Claude Design Prompt — FarmFlow Admin “Доставка” (Delivery) section + Econt integration

> Paste everything below the line into Claude Design. It is written to match the
> existing FarmFlow admin panel (`client/`) exactly: Bulgarian UI, custom Tailwind
> components, the `--ff-*` design tokens, the per-page banner-toggle pattern, and
> the BFF → NestJS API flow. Edit the bracketed `[…]` notes only if you want to
> narrow scope.

---

## ROLE / GOAL

Design a new **admin section “Доставка” (Delivery)** for **FarmFlow** — a multi-tenant
SaaS where Bulgarian farm shops run an online store. Every farm (tenant) gets its own
fully-customizable delivery setup plus an integration with **Еконт (Econt)**, the
Bulgarian courier, via Econt’s JSON API.

Output: **React + TypeScript + Tailwind** client components (`'use client'`), one per
logical block, plus realistic Bulgarian mock data. The whole UI is **in Bulgarian**.
Match the design system below 1:1 — do not invent new colors, fonts, or a different
component kit. Icons: `lucide-react` only.

This is a **multi-tenant** feature: everything is per-farm configuration stored on the
tenant. Two data classes:
- **Per-tenant (private):** delivery rules + Econt credentials + sender profile.
- **Global (shared, cached):** Econt city/office nomenclature — same for all farms.

---

## DESIGN SYSTEM — MATCH EXACTLY

**Shell:** content renders inside the admin shell (fixed left sidebar `220px`, topbar
`68px`). Page content is centered `max-w-[1200px]`, padding `px-8 pt-8 pb-10`
(`max-sm:px-4`). Add a new **sidebar nav item**: label **„Доставка“**, icon `Truck`
(lucide), placed right after „Слотове“. Active style: `border-l-[3px] border-ff-green-600
bg-ff-green-50 font-bold text-ff-green-800`.

**Color tokens (CSS vars — use these, exact hex):**
```
--ff-bg:#f3eee2   --ff-surface:#ffffff   --ff-surface-2:#fbf8f1
--ff-green-950:#16301c --ff-green-900:#1f3d26 --ff-green-800:#244a2c
--ff-green-700:#2c5530 --ff-green-600:#387040 --ff-green-500:#4c8a54
--ff-green-100:#e2ebdd --ff-green-50:#eef3e9
--ff-amber:#e8a33d --ff-amber-600:#d08b26 --ff-amber-soft:#f8e8c9 --ff-amber-softer:#fbf1dc
--ff-ink:#26241d --ff-ink-2:#585242 --ff-muted:#8b8573 --ff-muted-2:#a8a290
--ff-border:#e6dece --ff-border-2:#efe9dc
--ff-gray-badge-bg:#ece8dd --ff-gray-badge-ink:#75705f --ff-red:#bf4434
```
Tailwind exposes these as `bg-ff-surface`, `text-ff-ink`, `border-ff-border`, etc.

**Typography:** headings `font-display` (extrabold, tracking-tight); body `font-sans`;
money/stat numbers use class `ff-fig` (tabular Bitter serif). Section titles ~`15.5px`
extrabold; labels `12.5px` bold uppercase-ish `text-ff-ink-2`; helper text `13px
text-ff-ink-2`; muted meta `12.5px text-ff-muted`.

**Radius/shadow:** cards `rounded-[14px]`; modals `rounded-2xl`; inputs `rounded-sm`;
shadows `shadow-ff-sm` (cards), `shadow-ff-lg` (modals). Animations: `animate-ff-fade-up`
(page enter), `animate-ff-pop` (modal), `animate-ff-fade` (overlay).

**Reusable components & class strings (reproduce these, don’t substitute):**

- **ToggleSwitch** (custom pill switch, NOT a checkbox): green when on (`--ff-green-600`),
  beige `#D9D2C2` when off, white knob. Two sizes (`small` = 38×22, default 46×26).
  Used everywhere for on/off.
- **Button variants** (class-variance-authority): `primary` (green filled), `amber`,
  `ghost`, `outline`, `soft`, `danger`. Sizes `default | sm | lg | icon`.
- **Field input class:**
  `rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-bold text-ff-ink outline-none focus:border-ff-green-500`
- **Label class:** `flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2`
- **Banner-toggle card pattern** (the signature pattern — copy it for the master toggle):
  a wide rounded card, left icon tile (`h-11 w-11 rounded-xl`), title + explanatory
  subtext, right side a status word („Включено“/„Изключено“) + ToggleSwitch. When **on**
  the card turns `bg-ff-green-50 border-ff-green-100`; when off `bg-ff-surface
  border-ff-border`.
- **Modal pattern:** overlay `fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4`,
  inner `animate-ff-pop max-h-[92vh] w-[440px] overflow-y-auto rounded-2xl border
  border-ff-border bg-ff-surface p-6 shadow-ff-lg`, click-outside closes.
- **Toasts:** bottom-right (sonner). Success on save, error on failure.
- **Optimistic updates:** flip UI immediately, roll back on error + error toast.
- **Disabled/locked region:** `pointer-events-none opacity-50` (used when the master
  delivery toggle is off, to dim the rest).

**Status badge styles (reuse for shipment/connection states):** small pill,
`rounded-full px-2 py-0.5 text-[11px] font-extrabold`. Green = `bg-ff-green-100
text-ff-green-700`; amber = `bg-ff-amber-soft text-ff-amber-600`; gray =
`bg-ff-gray-badge-bg text-ff-gray-badge-ink`; red = `bg-[#f7e0dc] text-ff-red`.

---

## PAGE LAYOUT — “Доставка”

Single scrollable page, stacked **section cards** (each `rounded-[14px] border
border-ff-border bg-ff-surface p-5 shadow-ff-sm`, with a header row: section title +
short helper text). A **sticky bottom save bar** appears when anything is dirty.

### Header + master toggle
- Page title „Доставка“ (`font-display`), subtitle „Настрой как клиентите получават
  поръчките си.“
- **Master banner toggle** „Доставка активна“ — when OFF, show an amber notice
  („Доставката е изключена — клиентите не виждат опции за доставка в магазина.“) and
  dim all sections below (`pointer-events-none opacity-50`). Reuse the existing
  `deliveryEnabled` tenant flag.

### Section 1 — „Методи на доставка“ (Delivery methods)
A vertical list of **method cards**, each with: drag handle (reorder), icon, name,
enable ToggleSwitch, and — when enabled — an expandable config row. Methods:

1. **До офис на Еконт** (`Truck`/`Building2`) — customer picks an Econt office.
2. **До адрес (Еконт до врата)** (`Home`) — courier to door.
3. **Лична доставка (слотове)** (`CalendarDays`) — the farm’s own slots; link „Управлявай
   слотовете →“ to the Слотове page.
4. **Вземане от място** (`MapPin`) — pickup; reveals a pickup-address textarea + hours.

Per-method config (when enabled):
- **Етикет за клиента** (custom label customer sees) — text input.
- **Цена** — segmented: „Безплатна“ / „Фиксирана“ / „Според теглото“ / „Безплатна над
  сума“. „Фиксирана“ reveals a `лв` fee input; „Безплатна над сума“ reveals a threshold
  input.
- **Срок** — short text e.g. „1–2 работни дни“.
- **Кой плаща** — toggle „Клиент / Ферма“.
- Optional **минимална поръчка** for this method.

Empty/disabled method collapses its config. At least one enabled method required while
master is on (inline validation if none).

### Section 2 — „График и наличност“ (Schedule & availability)
- **Работни дни** — weekday pills „Пн Вт Ср Чт Пт Сб Нд“ (multi-select, green when on).
- **Час на прекъсване** (cutoff) — time input; helper „Поръчки след този час тръгват на
  следващия ден.“
- **Срок за обработка** (lead days) — number stepper.
- **Доставка в същия ден** — toggle.
- **Макс. поръчки на ден** — number.
- **Блокирани дати** (blackout) — list of date chips with `×`, plus an „+ Добави дата“
  date picker. (e.g. holidays.)

### Section 3 — „Ценообразуване“ (Pricing — global)
- **Праг за безплатна доставка** — `лв` input (0 = off), helper „Над тази сума доставката
  е безплатна за клиента.“
- **Модел на цената** — segmented „Фиксиран / По тегло / По зона“.
  - *По тегло* → editable tier table: rows „до [X] кг → [Y] лв“, „+ Добави праг“.
  - *По зона* → editable table: „Град/Регион [select] → [цена] лв“, „+ Добави зона“.
- **Опаковъчна такса** — optional `лв` input.
- Currency fixed **лв (BGN)**; small note about ДДС.

### Section 4 — „Еконт интеграция“ (Econt connection) — the key block
Connection card with a header status badge (Свързано ✓ / Грешка / Непроверено):
- **Среда** — segmented „Тест / Реален“ (maps demo vs prod base URL).
- **API потребител** — text input.
- **API парола** — password input, masked; when already saved show „•••••• (запазена)“
  with a „Смени“ action. **Never display the raw saved password.**
- **„Провери връзката“** button (`outline`) → shows a spinner then a status badge +
  message („Връзката е успешна“ / „Невалидни данни“).
- **Профил на подател** (sender): име на подател, телефон, **град** (autocomplete from the
  Econt city nomenclature), офис **или** адрес (radio → office picker or address fields).
- **Пакет по подразбиране**: тегло (кг), размери (Д×Ш×В, optional), описание на
  съдържанието.
- **Наложен платеж (COD)** — toggle + „кой плаща таксата за наложен платеж“.
- **Опции за товарителница**: размер на хартията „A4 / A6“, „Автоматично създавай
  товарителница при платена поръчка“ toggle.
- **Номенклатури**: „Последна синхронизация: преди 3 ч“ + „Обнови градове и офиси“ button;
  show counts („1 240 населени места · 980 офиса“).

### Section 5 — „Преглед: избор на офис“ (customer office-picker preview)
A read-only **mock of what the customer sees at checkout**, so the farmer can preview it:
- City search autocomplete (e.g. „Варна“) → list of offices, each row: office name,
  address, working hours, distance; selectable radio.
- A map panel placeholder with a pin (static is fine).
Label it clearly „Така изглежда изборът за клиента“.

### Section 6 — „Товарителници и проследяване“ (Shipments & tracking)
A **table of orders with Econt shipments**:
- Columns: „Поръчка №“, „Клиент“, „Метод“, „Статус“ (badge: Чака / Създадена / Изпратена /
  Доставена / Върната), „Товарителница №“ (tracking number, copyable), „Цена“ (`ff-fig` лв),
  „Действия“.
- Row actions: **Създай товарителница** (create label), **Принтирай** (PDF, icon),
  **Проследи** (opens tracking modal), **Откажи** (void, danger).
- **Bulk**: row checkboxes → toolbar „Създай товарителници (N)“, „Принтирай избраните“.
- **Filters/search**: status segmented, method select, date range, free-text search.
- **Empty state**: friendly illustration block + „Все още няма товарителници.“
- **Tracking modal**: a vertical timeline of statuses with timestamp + location
  („Приета в офис Варна“, „В транзит“, „Доставена“), using the modal pattern.

### Save behavior
Sticky bottom bar (appears on dirty): „Имаш незапазени промени“ + „Отмени“ (ghost) +
„Запази промените“ (primary). Save = optimistic + success toast „Настройките са
запазени“; failure rolls back + error toast.

---

## STATES TO INCLUDE (for every block)
- **Loading**: skeleton cards/rows (beige shimmer).
- **Empty**: dedicated empty states (no methods, no shipments, no blackout dates).
- **Disabled/locked**: master-off dims sections; Econt methods disabled until creds saved
  (tooltip „Първо свържи Еконт акаунт“).
- **Validation**: numeric ≥ 0; valid time; at least one method when active; creds required
  before enabling Econt methods. Inline red text + the field border turns `--ff-red`.
- **Error**: connection failure badge + toast.
- **Responsive**: sidebar collapses to drawer < lg; section cards stack; the shipments
  table becomes stacked cards on mobile; weekday pills wrap.

---

## DATA SHAPES (bind the UI to these — realistic)

Per-tenant config lives in `tenant.settings.delivery` (a JSON blob) + `tenant.deliveryEnabled`:
```ts
tenant.deliveryEnabled: boolean   // master toggle (already exists)
tenant.settings.delivery = {
  methods: {
    econtOffice:  { enabled: boolean; label: string; pricing: Pricing; etaText: string; payer: 'customer'|'farm'; minOrderStotinki?: number },
    econtAddress: { enabled: boolean; label: string; pricing: Pricing; etaText: string; payer: 'customer'|'farm' },
    ownSlots:     { enabled: boolean; label: string; pricing: Pricing },
    pickup:       { enabled: boolean; label: string; address: string; hours: string },
    order: string[]   // method keys, display order
  },
  schedule: { weekdays: number[]; cutoffTime: string; leadDays: number; sameDay: boolean; maxPerDay: number; blackout: string[] },
  pricing:  { freeThresholdStotinki: number; model: 'flat'|'byWeight'|'byZone'; flatFeeStotinki?: number;
              weightTiers?: { uptoKg: number; feeStotinki: number }[]; zones?: { region: string; feeStotinki: number }[];
              packagingFeeStotinki?: number },
  econt: {
    env: 'demo'|'prod'; configured: boolean;          // never expose username/password to the client beyond `configured`
    sender: { name: string; phone: string; cityId: number; cityName: string; mode: 'office'|'address'; officeCode?: string; address?: string },
    defaultPackage: { weightKg: number; dimensions?: string; contents: string },
    cod: { enabled: boolean; feePayer: 'customer'|'farm' },
    label: { paper: 'A4'|'A6'; autoCreate: boolean },
    nomenclature: { lastSyncedAt: string; cities: number; offices: number }
  }
}
type Pricing = { type: 'free'|'flat'|'byWeight'|'freeOver'; feeStotinki?: number; freeOverStotinki?: number }
```
*(`*Stotinki` = integer cents; display as `лв` with 2 decimals via `ff-fig`.)*

Econt nomenclature row (for the city/office pickers):
```ts
EcontOffice = { code: string; name: string; address: string; cityName: string; workingHours: string; lat?: number; lng?: number }
```

Shipment/order row for Section 6:
```ts
Shipment = {
  orderId: string; orderNumber: string; customerName: string;
  method: 'econtOffice'|'econtAddress'|'ownSlots'|'pickup';
  status: 'pending'|'created'|'shipped'|'delivered'|'returned';
  trackingNumber?: string; priceStotinki?: number;
  history?: { at: string; label: string; location?: string }[]
}
```

---

## ECONT API (context so the UI is accurate — you’re designing UI, not calling it)
- JSON over HTTPS, HTTP Basic auth. Test base `https://demo.econt.com/ee/services`,
  prod `https://ee.econt.com/services`.
- City/office pickers come from `Nomenclatures/NomenclaturesService.getCities|getOffices`.
- Price = `Shipments/LabelService.createLabel` with `mode:'calculate'`; real waybill =
  `mode:'create'`; tracking = `Shipments/ShipmentService.getShipmentStatuses`.
- This means: the office picker is a search over a cached list; “Провери връзката” pings an
  authenticated endpoint; “Създай товарителница” returns a tracking number + PDF label.

---

## DELIVERABLES
React client components (Bulgarian copy throughout), with mock data:
1. `DeliveryPage` (the page shell + master toggle + sticky save bar).
2. `MethodsSection` + `MethodCard` (reorderable, expandable config).
3. `ScheduleSection`.
4. `PricingSection` (with weight-tier + zone editors).
5. `EcontConnectionSection` (creds, sender, package, COD, label, nomenclature sync).
6. `OfficePickerPreview` (city search + office list + map placeholder).
7. `ShipmentsTable` + `TrackingModal`.
8. Shared bits: `ToggleSwitch`, `Button`, status `Badge`, section `Card`, empty/loading
   skeletons — matching the class strings above.

## DON’TS
- No new palette/fonts/component kit. Only `--ff-*` tokens, `font-display/sans`, `ff-fig`,
  Tailwind, `lucide-react`.
- Never render the saved Econt password; show „запазена“ + „Смени“ only.
- Don’t hardcode delivery rules in components — drive everything from the `settings.delivery`
  object so each farm is fully customizable.
- Keep all copy in Bulgarian. Money in лв via `ff-fig`. Times 24h.
