# Ръчно изпращане на поръчки към фермери (organizer-triggered)

**Дата:** 2026-07-12
**Статус:** одобрен дизайн, чака имплементационен план

## Проблем

Организаторът на multi-farmer магазин иска **ръчно** да прати на фермерите
имейл какви поръчки има и в какво време — когато той реши, не по график.

Днес единственият механизъм е автоматичният 07:00 cron (`DigestProcessor`),
който праща per-farmer digest „Твоите доставки за днес". Няма UI бутон и няма
избор на период / фермери / статуси. `POST /digest/test` съществува, но е
етикетиран „тест", праща само за днес, копира и owner-а — не е подходящ за
редовна ръчна употреба.

## Обхват

Организаторът (tenant owner, panel-логнат) натиска бутон в Фермери страницата,
избира **диапазон дати**, **кои фермери** и **кои статуси**, и системата праща
на всеки избран фермер имейл с неговите поръчки за периода.

**НЕ** е в обхвата: промяна на съществуващия cron, промяна на `POST /digest/test`.

## Решение

Reuse на максимум от съществуващата `DigestService` per-farmer логика. Ново е:
- on-demand endpoint с диапазон + избор на фермери + статуси,
- UI бутон + модал,
- обобщаване на дневната digest логика до диапазон.

### Семантика „поръчка за деня"

Мирори `scheduledForDay` (в `orders/order-scheduling.ts`):
- Поръчка със slot → брои се за **датата на delivery slot-а**.
- Поръчка без slot (пазарен pickup / адрес без избран slot) → **деня на създаване**.
- Часът, показан в имейла = часът на slot-а (`timeFrom–timeTo`), както сега.

За диапазон: нов helper `scheduledForRange(from, to)` — обобщава `scheduledForDay`
(slot дата в `[from, to]` ИЛИ slotless с `createdAt` в `[bgDayBounds(from).from,
bgDayBounds(to).to)`).

### Статуси

Организаторът избира от `pending` / `confirmed` / `delivered` (multi-select).
`cancelled` (и всякакви други извън тези три) никога не влизат — whitelist на
backend-а сече подадените стойности до разрешеното множество. Ако след
пресичането не остане нито един валиден статус → 400.

Default в модала: **Потвърдени** е чекнато; Чакащи и Доставени — по избор.

## Backend

### Endpoint

`POST /digest/farmers/send` — `JwtAuthGuard`, `@CurrentTenant()`.

Тяло (нов DTO `SendFarmerOrdersDto`):
```
{
  from: string;        // 'YYYY-MM-DD'
  to: string;          // 'YYYY-MM-DD'
  farmerIds: string[]; // UUID[], non-empty
  statuses: string[];  // подмножество на ['pending','confirmed','delivered'], non-empty
}
```

Валидация (в service, преди работа):
- Tenant трябва да е `multiFarmer` → иначе `BadRequestException`.
- `from ≤ to`; диапазон ≤ **31 дни** → иначе `BadRequestException`.
- `statuses ∩ ['pending','confirmed','delivered']` не е празно → иначе 400.
- `farmerIds` се пресичат с реалните фермери на tenant-а (по tenantId) — чужди/
  несъществуващи id-та мълчаливо се игнорират; ако не остане никой → 400.

Отговор:
```
{ sent: number; skipped: number }
```
`skipped` = избрани фермери (с имейл), които нямат поръчки за периода/статусите.
Фермер без имейл изобщо не се брои тук — модалът вече не му е дал да го избере.

### Service

Нов публичен метод в `DigestService`:

```
async sendFarmerOrderEmails(
  tenantId: string,
  opts: { from: string; to: string; farmerIds: string[]; statuses: string[] },
): Promise<{ sent: number; skipped: number }>
```

Логика:
1. Валидации (горе).
2. Прочети избраните фермери с имейл:
   `farmers WHERE tenantId = t AND id IN farmerIds AND email IS NOT NULL`.
   (Фермер без имейл се пропуска — не може да получи.)
3. **Една** batch заявка за line items за целия период (без N+1):
   `orderItems ⋈ orders ⋈ products ⋈ (left) deliverySlots`
   `WHERE orders.tenantId = t AND orders.status IN statuses`
   `AND scheduledForRange(from, to) AND products.farmerId IN farmerIds`.
   Селектира и `deliverySlots.date` (за групиране по ден) + `products.farmerId`.
4. Групирай редовете `byFarmer → byDay`.
5. За всеки избран фермер с имейл:
   - ако няма редове → `skipped++`, continue;
   - иначе построй имейла (виж рендер) и `email.sendMail(...)`, `sent++`.
   - грешка при пращане се логва, брои се към skipped (не хвърля — един счупен
     имейл не спира останалите), както в съществуващия `sendFarmerDigests`.

### Рендер (рефактор на дневния асемблер)

Днес `assembleFarmerDigest(date, name, rows)` връща цял HTML документ за **един**
ден. За диапазон трябват няколко дневни секции в **един** документ.

Рефактор:
- Извади **body-фрагмент** билдер: `buildFarmerDayFragment(date, rows) → string`
  (текущите таблици по delivery type: за вземане / до адрес / Еконт), без
  `<!DOCTYPE>/<html>/<body>` обвивка.
- `assembleFarmerDigest` (използван от cron-а и `/digest/test`) остава със същото
  поведение — обвива един fragment. Нищо в cron пътя не се чупи.
- Нов `assembleFarmerRangeEmail(from, to, farmerName, byDay) → DigestResult`:
  header „Твоите поръчки за <период>", после по един ден-секция (възходящо) с
  заглавие на деня; дни без поръчки се пропускат. Празен `byDay` → връща null
  (тогава фермерът се брои skipped).

Subject: `Твоите поръчки за <период> — ФермериБГ` (без „тест").
Период текст: ако `from === to` → един ден (`relDayLabel`-стил), иначе `from – to`.

### Файлове (backend)

- `server/src/modules/orders/order-scheduling.ts` — добави `scheduledForRange`.
- `server/src/modules/digest/dto/send-farmer-orders.dto.ts` — нов DTO.
- `server/src/modules/digest/digest.service.ts` — `sendFarmerOrderEmails`,
  рефактор на асемблера (`buildFarmerDayFragment`, `assembleFarmerRangeEmail`).
- `server/src/modules/digest/digest.controller.ts` — нов route.

## Frontend

### Бутон

В `farmers-client.tsx`, в toolbar-а на multiFarmer изгледа (до „Добави фермер"):
бутон „Изпрати поръчки на фермери" (icon `Mail`/`Send`). Показва се само при
`multi === true`. Отваря новия модал.

### Модал `SendFarmerOrdersModal`

- **Период:** два `<input type="date">` — от / до. Default: днес / днес.
  Валидация в UI: `to ≥ from`.
- **Фермери:** checkbox списък (име + имейл). Фермер без имейл → disabled, сив,
  етикет „няма имейл". Тези с имейл са pre-checked. Бутон „Всички/Никой".
- **Статуси:** три checkbox-а — Чакащи / Потвърдени / Доставени. Потвърдени
  чекнато по подразбиране.
- **Изпрати:** disabled докато няма поне един фермер И поне един статус И валиден
  период. При успех toast: `Изпратени N · прескочени M (без поръчки за периода)`;
  затваря модала.

### Файлове (frontend)

- `client/src/lib/api-client.ts` — `sendFarmerOrders({from,to,farmerIds,statuses})`.
- `client/src/lib/types.ts` — тип за отговора при нужда.
- `client/src/components/farmers/send-farmer-orders-modal.tsx` — нов.
- `client/src/components/farmers/farmers-client.tsx` — бутон + state за модала.
  `Farmer` вече носи `email`, тъй че списъкът за модала идва от наличните
  `farmers` без нова заявка.

## Тестове

Backend (jest, mock db chain в стила на `digest.service.spec.ts`):
- `scheduledForRange` — граници: slot дата в/извън `[from,to]`; slotless по
  `createdAt`; `from === to` съвпада с `scheduledForDay`.
- `sendFarmerOrderEmails`:
  - праща само на избрани фермери с имейл; пропуска без имейл;
  - фермер без поръчки за периода → `skipped++`, без `sendMail`;
  - non-multiFarmer tenant / празни `farmerIds` след пресичане / празни
    `statuses` / `from > to` / диапазон > 31 дни → `BadRequestException`;
  - `cancelled` подаден в `statuses` се изрязва (whitelist);
  - счупен `sendMail` за един фермер не спира останалите (брои се skipped).
- Асемблер: `buildFarmerDayFragment` няма `<html>` обвивка; `assembleFarmerDigest`
  запазва старото поведение (regression); range email съдържа по секция на ден и
  пропуска празните дни.

Frontend: без нов тест-harness освен ако вече има за farmers-client; ръчна
верификация през preview (виж по-долу).

## Верификация

Preview на клиента: multiFarmer tenant → Фермери → бутон → модал → избери период/
фермери/статуси → Изпрати → toast. SMTP в dev може да не праща реално; провери
network заявката (200 + `{sent,skipped}`) и server лог `[digest] Farmer sent`.

## Отворени рискове

- **Обем имейли:** организатор може да натисне за голям диапазон × много фермери.
  Митигация: cap 31 дни + праща само на фермери с реални поръчки. `sendMail` вече
  минава през queue (`EMAIL_QUEUE`), тъй че не блокира заявката.
- **Дублирани имейли:** ръчното пращане може да съвпадне с 07:00 cron за днес —
  приемливо (различни subject-и; организаторът съзнателно натиска).
