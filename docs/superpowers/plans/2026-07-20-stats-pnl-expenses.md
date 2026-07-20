# Статистика: приходи, ръчни разходи и печалба по куриер — план за изпълнение

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собственикът вижда в Статистика своите приходи (доставка + информационна комисионна), ръчно въведените разходи и печалбата — общо и по куриер.

**Architecture:** Нова таблица `manual_expenses` + процент в `tenants.settings.stats.infoCommissionBps`. Нов `PnlService` в `stats` модула прави три групирани SQL заявки (приходи по акаунт, разходи по акаунт+категория, имейли), а цялата математика живее в чиста функция `buildPnl` — в репото няма тестова база, така че само чиста функция може да се тества истински. Клиентът получава нова секция в `/stats`.

**Tech Stack:** NestJS + Drizzle (Postgres), jest на бекенда; Next.js App Router + vitest (node-only, без jsdom) на клиента.

**Спецификация:** [`docs/superpowers/specs/2026-07-20-stats-pnl-expenses-design.md`](../specs/2026-07-20-stats-pnl-expenses-design.md)

## Global Constraints

- Пари: **integer стотинки** навсякъде (`amount_stotinki`, `*_stotinki`). Никакви float-ове.
- Дати: БГ календарен ден, `Europe/Sofia`. За `timestamptz` колони (`orders.delivered_at`) се ползва `bgDateTz` (единично `AT TIME ZONE`), НЕ `bgDate` — двойната конверсия мести деня.
- Миграциите се пишат **на ръка** в `packages/db/drizzle/` и се добавят в `meta/_journal.json` **без дупка в `idx`** — пропуск чупи мигратора мълчаливо.
- Drizzle: без `ANY()` → `inArray`; `CASE … THEN` към типизирана колона иска каст на всяко рамо.
- `settings` се пише само през `jsonbDeepMerge` (`server/src/common/db/jsonb.ts`) — read-modify-write трие чужди ключове.
- Всяка заявка е tenant-scoped; write по `:id` носи `tenant_id` в `WHERE`.
- Мобилни модали: `w-full max-w-[Npx]`, никога `w-[Npx]` — иначе излизат извън 375px.
- Тестове: бекенд `pnpm --filter @fermeribg/api test`, клиент `pnpm --filter @fermeribg/web test`. В прясна worktree първо `pnpm --filter "./packages/*" build`, иначе 130+ suite-а гърмят с TS2307.
- Работната директория се дели с друга сесия: работи в изолирана worktree и комитвай с изрични пътища, не `git add -A`.

**Отклонение от спецификацията (нарочно):** `GET /stats/pnl` **не се кешира**. Спецификацията предвиждаше кеш + инвалидация, но ключът е за прозорец (`from`/`to`), не може да се изброи при запис на разход — потребителят би добавил разход и не би го видял. Заявките са три групирани агрегата върху индексирани колони при ферма-мащаб данни; кешът не купува нищо.

---

### Task 1: Таблица `manual_expenses`

**Files:**
- Modify: `packages/db/src/schema.ts` (нова таблица след `routeCourierAssignments`, ~ред 620)
- Create: `packages/db/drizzle/0111_manual_expenses.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Test: `server/src/modules/stats/manual-expenses.schema.spec.ts`

**Interfaces:**
- Consumes: нищо
- Produces: `manualExpenses` експорт от `@fermeribg/db` с колони `id, tenantId, date, amountStotinki, category, courierAccountId, note, createdAt, createdById`

- [ ] **Step 1: Добави таблицата в схемата**

В `packages/db/src/schema.ts`, веднага след затварящата скоба на `routeCourierAssignments`:

```ts
// Ръчно въведени разходи на фермата (гориво, амбалаж, заплати…). Няма автоматичен
// източник — собственикът ги пише сам, за да има смислена печалба в Статистика.
// `courierAccountId` NULL = общ разход, който НЕ се разпределя по куриери.
export const manualExpenses = pgTable(
  'manual_expenses',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // БГ календарен ден на разхода (YYYY-MM-DD), същата конвенция като deliverySlots.date.
    date: date('date').notNull(),
    amountStotinki: integer('amount_stotinki').notNull(),
    // 'fuel' | 'packaging' | 'salary' | 'fees' | 'other' — валидира се в DTO-то, не в enum,
    // за да не иска миграция всяка нова категория.
    category: text('category').notNull(),
    // Изтрит куриерски акаунт превръща разхода в общ, вместо да го изгуби.
    courierAccountId: uuid('courier_account_id').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    createdAt: timestamp('created_at').defaultNow(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    // Периодните заявки на /stats/pnl: WHERE tenant_id = ? AND date BETWEEN ? AND ?
    tenantDateIdx: index('manual_expenses_tenant_date_idx').on(t.tenantId, t.date),
    // Разбивката по куриер.
    tenantCourierIdx: index('manual_expenses_tenant_courier_idx').on(t.tenantId, t.courierAccountId),
  }),
);
```

Ако `date` не е в импортите от `drizzle-orm/pg-core` най-горе на файла — добави го.

- [ ] **Step 2: Напиши миграцията**

`packages/db/drizzle/0111_manual_expenses.sql`:

```sql
CREATE TABLE IF NOT EXISTS "manual_expenses" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "amount_stotinki" integer NOT NULL,
  "category" text NOT NULL,
  "courier_account_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "note" text,
  "created_at" timestamp DEFAULT now(),
  "created_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "manual_expenses_tenant_date_idx" ON "manual_expenses" ("tenant_id", "date");
CREATE INDEX IF NOT EXISTS "manual_expenses_tenant_courier_idx" ON "manual_expenses" ("tenant_id", "courier_account_id");
```

- [ ] **Step 3: Впиши я в журнала**

В `packages/db/drizzle/meta/_journal.json`, в края на масива `entries`, след записа с `"idx": 108`:

```json
    ,{
      "idx": 109,
      "version": "7",
      "when": 1784800000000,
      "tag": "0111_manual_expenses",
      "breakpoints": true
    }
```

Провери, че последователността `idx` няма дупка: 107 → 108 → 109.

- [ ] **Step 4: Напиши теста за схемата**

`server/src/modules/stats/manual-expenses.schema.spec.ts` (мирише на `route-courier-assignments.schema.spec.ts` — работи само при налична база, иначе се скипва):

```ts
// Live-DB тест за `manual_expenses` (Task 1). Иска реален Postgres през
// TEST_DATABASE_URL (пада към DATABASE_URL, както е локално). Скипва се напълно,
// когато няма нито едното — за да не чупи DB-less CI лентата.
import { eq } from 'drizzle-orm';
import { createDb, manualExpenses, tenants, users, type Database } from '@fermeribg/db';

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

(DB_URL ? describe : describe.skip)('manual_expenses schema', () => {
  let db: Database;
  let tenantId: string;
  let accountId: string;

  beforeAll(async () => {
    db = createDb(DB_URL!, { max: 3 });
    const [tenant] = await db
      .insert(tenants)
      .values({ name: 'Expenses Schema Test', slug: `exp-schema-${Date.now()}` })
      .returning({ id: tenants.id });
    tenantId = tenant.id;
    const [acc] = await db
      .insert(users)
      .values({ tenantId, email: `exp-${Date.now()}@test.local`, passwordHash: 'x', role: 'driver' })
      .returning({ id: users.id });
    accountId = acc.id;
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('приема разход с куриер и без куриер', async () => {
    const rows = await db
      .insert(manualExpenses)
      .values([
        { tenantId, date: '2026-07-20', amountStotinki: 5000, category: 'fuel', courierAccountId: accountId },
        { tenantId, date: '2026-07-20', amountStotinki: 1200, category: 'other', courierAccountId: null },
      ])
      .returning({ id: manualExpenses.id });
    expect(rows).toHaveLength(2);
  });

  it('изтриването на куриерския акаунт превръща разхода в общ, не го трие', async () => {
    const [exp] = await db
      .insert(manualExpenses)
      .values({ tenantId, date: '2026-07-20', amountStotinki: 999, category: 'fuel', courierAccountId: accountId })
      .returning({ id: manualExpenses.id });
    await db.delete(users).where(eq(users.id, accountId));
    const [after] = await db
      .select({ courierAccountId: manualExpenses.courierAccountId })
      .from(manualExpenses)
      .where(eq(manualExpenses.id, exp.id));
    expect(after).toBeDefined();
    expect(after.courierAccountId).toBeNull();
  });
});
```

- [ ] **Step 5: Пусни миграцията и теста**

```bash
pnpm --filter @fermeribg/db build
pnpm db:migrate
pnpm --filter @fermeribg/api test -- manual-expenses.schema
```
Очаквано: миграцията минава без грешка; двата теста са зелени (или целият describe е skipped, ако няма `DATABASE_URL` — тогава пусни с локалната база на порт 5433).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0111_manual_expenses.sql packages/db/drizzle/meta/_journal.json server/src/modules/stats/manual-expenses.schema.spec.ts
git commit -m "feat(db): manual_expenses table for farm-entered costs"
```

---

### Task 2: Чистата математика на P&L

**Files:**
- Create: `server/src/modules/stats/pnl.util.ts`
- Test: `server/src/modules/stats/pnl.util.spec.ts`

**Interfaces:**
- Consumes: нищо
- Produces: `commissionOf(itemsStotinki: number, bps: number): number`; `buildPnl(rows: PnlAccountRow[], expenses: PnlExpenseRow[], commissionBps: number, names: Record<string, string>): PnlResult`; типовете `PnlAccountRow`, `PnlExpenseRow`, `PnlCourier`, `PnlResult`

- [ ] **Step 1: Напиши падащите тестове**

`server/src/modules/stats/pnl.util.spec.ts`:

```ts
import { buildPnl, commissionOf } from './pnl.util';

describe('commissionOf', () => {
  it('закръгля до цяла стотинка', () => {
    expect(commissionOf(12345, 1000)).toBe(1235); // 1234.5 → 1235
  });

  it('нулев или липсващ процент дава нула', () => {
    expect(commissionOf(50000, 0)).toBe(0);
    expect(commissionOf(50000, Number.NaN)).toBe(0);
  });
});

describe('buildPnl', () => {
  const names = { 'acc-1': 'ivan@ferma.bg', 'acc-2': 'petar@ferma.bg' };

  it('празен период дава нули, не null', () => {
    const r = buildPnl([], [], 1000, {});
    expect(r.revenue).toEqual({ deliveryStotinki: 0, commissionStotinki: 0, totalStotinki: 0 });
    expect(r.expenses.totalStotinki).toBe(0);
    expect(r.profitStotinki).toBe(0);
    expect(r.couriers).toEqual([]);
    expect(r.goodsTurnoverStotinki).toBe(0);
  });

  it('приход на куриер = доставка + комисионна върху неговите стоки', () => {
    const r = buildPnl(
      [{ accountId: 'acc-1', itemsStotinki: 100_00, deliveryStotinki: 5_00 }],
      [],
      1000,
      names,
    );
    expect(r.couriers).toHaveLength(1);
    expect(r.couriers[0]).toMatchObject({
      accountId: 'acc-1',
      name: 'ivan@ferma.bg',
      deliveryStotinki: 500,
      commissionStotinki: 1000,
      revenueStotinki: 1500,
      expenseStotinki: 0,
      profitStotinki: 1500,
    });
  });

  it('разходите на куриера се вадят само от неговата печалба', () => {
    const r = buildPnl(
      [
        { accountId: 'acc-1', itemsStotinki: 100_00, deliveryStotinki: 5_00 },
        { accountId: 'acc-2', itemsStotinki: 50_00, deliveryStotinki: 3_00 },
      ],
      [{ accountId: 'acc-1', category: 'fuel', amountStotinki: 400 }],
      1000,
      names,
    );
    const a1 = r.couriers.find((c) => c.accountId === 'acc-1')!;
    const a2 = r.couriers.find((c) => c.accountId === 'acc-2')!;
    expect(a1.expenseStotinki).toBe(400);
    expect(a1.profitStotinki).toBe(1500 - 400);
    expect(a2.expenseStotinki).toBe(0);
    expect(a2.profitStotinki).toBe(300 + 500);
  });

  it('общите разходи не се разпределят по куриери, но влизат в общата печалба', () => {
    const r = buildPnl(
      [{ accountId: 'acc-1', itemsStotinki: 100_00, deliveryStotinki: 5_00 }],
      [
        { accountId: null, category: 'fees', amountStotinki: 700 },
        { accountId: 'acc-1', category: 'fuel', amountStotinki: 300 },
      ],
      1000,
      names,
    );
    expect(r.generalExpensesStotinki).toBe(700);
    expect(r.couriers[0].expenseStotinki).toBe(300);
    expect(r.expenses.totalStotinki).toBe(1000);
    expect(r.revenue.totalStotinki).toBe(1500);
    expect(r.profitStotinki).toBe(500);
  });

  it('доставените без назначен куриер отиват в „неразпределени“', () => {
    const r = buildPnl(
      [
        { accountId: null, itemsStotinki: 20_00, deliveryStotinki: 2_00 },
        { accountId: 'acc-1', itemsStotinki: 10_00, deliveryStotinki: 1_00 },
      ],
      [],
      1000,
      names,
    );
    expect(r.unassigned).toEqual({ deliveryStotinki: 200, commissionStotinki: 200, revenueStotinki: 400 });
    expect(r.couriers).toHaveLength(1);
    expect(r.revenue.totalStotinki).toBe(400 + 200);
  });

  it('сборът на редовете в таблицата е точно общият приход (без разминаване от закръгляне)', () => {
    const r = buildPnl(
      [
        { accountId: 'acc-1', itemsStotinki: 3333, deliveryStotinki: 0 },
        { accountId: 'acc-2', itemsStotinki: 3333, deliveryStotinki: 0 },
      ],
      [],
      1000,
      names,
    );
    const sum = r.couriers.reduce((s, c) => s + c.revenueStotinki, 0) + r.unassigned.revenueStotinki;
    expect(sum).toBe(r.revenue.totalStotinki);
  });

  it('разходите се сумират по категория, подредени низходящо', () => {
    const r = buildPnl(
      [],
      [
        { accountId: null, category: 'fuel', amountStotinki: 100 },
        { accountId: 'acc-1', category: 'fuel', amountStotinki: 250 },
        { accountId: null, category: 'salary', amountStotinki: 900 },
      ],
      0,
      names,
    );
    expect(r.expenses.byCategory).toEqual([
      { category: 'salary', amountStotinki: 900 },
      { category: 'fuel', amountStotinki: 350 },
    ]);
  });

  it('акаунт без известен имейл пада към „Куриер“', () => {
    const r = buildPnl([{ accountId: 'acc-x', itemsStotinki: 100, deliveryStotinki: 0 }], [], 0, {});
    expect(r.couriers[0].name).toBe('Куриер');
  });
});
```

- [ ] **Step 2: Пусни ги, за да видиш, че падат**

Run: `pnpm --filter @fermeribg/api test -- pnl.util`
Expected: FAIL — `Cannot find module './pnl.util'`

- [ ] **Step 3: Напиши имплементацията**

`server/src/modules/stats/pnl.util.ts`:

```ts
/**
 * Чистата математика зад „приходи / разходи / печалба“ в Статистика. Стои
 * отделно от SQL-а нарочно: в репото няма тестова база (всички service тестове
 * са с мокове), така че само чиста функция може да се тества истински.
 *
 * Приход = доставка (order.total − стоките) + информационна комисионна
 * (процент върху стоките). Оборотът на стоката НЕ е наш приход и се връща
 * отделно, само за контекст.
 */

/** Един ред от групираната по акаунт заявка. `accountId` NULL = доставено без
 *  назначен куриер за деня (или без courierIndex). */
export interface PnlAccountRow {
  accountId: string | null;
  itemsStotinki: number;
  deliveryStotinki: number;
}

/** Групиран разход. `accountId` NULL = общ разход. */
export interface PnlExpenseRow {
  accountId: string | null;
  category: string;
  amountStotinki: number;
}

export interface PnlCourier {
  accountId: string;
  name: string;
  deliveryStotinki: number;
  commissionStotinki: number;
  revenueStotinki: number;
  expenseStotinki: number;
  profitStotinki: number;
}

export interface PnlResult {
  commissionBps: number;
  goodsTurnoverStotinki: number;
  revenue: { deliveryStotinki: number; commissionStotinki: number; totalStotinki: number };
  expenses: { totalStotinki: number; byCategory: { category: string; amountStotinki: number }[] };
  profitStotinki: number;
  couriers: PnlCourier[];
  unassigned: { deliveryStotinki: number; commissionStotinki: number; revenueStotinki: number };
  generalExpensesStotinki: number;
}

/** Комисионна в стотинки за дадени стоки, при ставка в базисни точки (1000 = 10%). */
export function commissionOf(itemsStotinki: number, bps: number): number {
  if (!Number.isFinite(bps) || bps <= 0) return 0;
  return Math.round((itemsStotinki * bps) / 10000);
}

const FALLBACK_NAME = 'Куриер';

export function buildPnl(
  rows: PnlAccountRow[],
  expenses: PnlExpenseRow[],
  commissionBps: number,
  names: Record<string, string>,
): PnlResult {
  const bps = Number.isFinite(commissionBps) && commissionBps > 0 ? commissionBps : 0;

  // Разходите по акаунт и по категория — сборват се преди приходите, за да може
  // всеки куриерски ред да си вземе своя разход наготово.
  const expenseByAccount = new Map<string, number>();
  const expenseByCategory = new Map<string, number>();
  let generalExpensesStotinki = 0;
  let expensesTotal = 0;
  for (const e of expenses) {
    expensesTotal += e.amountStotinki;
    expenseByCategory.set(e.category, (expenseByCategory.get(e.category) ?? 0) + e.amountStotinki);
    if (e.accountId === null) generalExpensesStotinki += e.amountStotinki;
    else expenseByAccount.set(e.accountId, (expenseByAccount.get(e.accountId) ?? 0) + e.amountStotinki);
  }

  const couriers: PnlCourier[] = [];
  const unassigned = { deliveryStotinki: 0, commissionStotinki: 0, revenueStotinki: 0 };
  let goodsTurnoverStotinki = 0;
  let deliveryTotal = 0;
  // Комисионната се смята ПО РЕД и после се сумира — не върху общия оборот —
  // за да е сборът на таблицата точно равен на общия приход.
  let commissionTotal = 0;

  for (const r of rows) {
    const commission = commissionOf(r.itemsStotinki, bps);
    goodsTurnoverStotinki += r.itemsStotinki;
    deliveryTotal += r.deliveryStotinki;
    commissionTotal += commission;

    if (r.accountId === null) {
      unassigned.deliveryStotinki += r.deliveryStotinki;
      unassigned.commissionStotinki += commission;
      unassigned.revenueStotinki += r.deliveryStotinki + commission;
      continue;
    }

    const revenueStotinki = r.deliveryStotinki + commission;
    const expenseStotinki = expenseByAccount.get(r.accountId) ?? 0;
    couriers.push({
      accountId: r.accountId,
      name: names[r.accountId] ?? FALLBACK_NAME,
      deliveryStotinki: r.deliveryStotinki,
      commissionStotinki: commission,
      revenueStotinki,
      expenseStotinki,
      profitStotinki: revenueStotinki - expenseStotinki,
    });
  }

  // Куриер с разходи, но без нито една доставка в периода, пак трябва да се вижда —
  // иначе разходът му изчезва от таблицата, докато влиза в общата печалба.
  for (const [accountId, expenseStotinki] of expenseByAccount) {
    if (couriers.some((c) => c.accountId === accountId)) continue;
    couriers.push({
      accountId,
      name: names[accountId] ?? FALLBACK_NAME,
      deliveryStotinki: 0,
      commissionStotinki: 0,
      revenueStotinki: 0,
      expenseStotinki,
      profitStotinki: -expenseStotinki,
    });
  }

  couriers.sort((a, b) => b.profitStotinki - a.profitStotinki);

  const revenueTotal = deliveryTotal + commissionTotal;
  return {
    commissionBps: bps,
    goodsTurnoverStotinki,
    revenue: {
      deliveryStotinki: deliveryTotal,
      commissionStotinki: commissionTotal,
      totalStotinki: revenueTotal,
    },
    expenses: {
      totalStotinki: expensesTotal,
      byCategory: [...expenseByCategory.entries()]
        .map(([category, amountStotinki]) => ({ category, amountStotinki }))
        .sort((a, b) => b.amountStotinki - a.amountStotinki),
    },
    profitStotinki: revenueTotal - expensesTotal,
    couriers,
    unassigned,
    generalExpensesStotinki,
  };
}
```

- [ ] **Step 4: Пусни тестовете**

Run: `pnpm --filter @fermeribg/api test -- pnl.util`
Expected: PASS, 9 теста.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/stats/pnl.util.ts server/src/modules/stats/pnl.util.spec.ts
git commit -m "feat(stats): pure P&L math for revenue, expenses and per-courier profit"
```

---

### Task 3: Настройката за информационния процент

**Files:**
- Create: `server/src/modules/stats/stats.settings.ts`
- Test: `server/src/modules/stats/stats.settings.spec.ts`

**Interfaces:**
- Consumes: `jsonbDeepMerge` от `server/src/common/db/jsonb.ts`
- Produces: `readInfoCommissionBps(settings: unknown): number`; `MAX_COMMISSION_BPS = 5000`

- [ ] **Step 1: Напиши падащия тест**

`server/src/modules/stats/stats.settings.spec.ts`:

```ts
import { readInfoCommissionBps, MAX_COMMISSION_BPS } from './stats.settings';

describe('readInfoCommissionBps', () => {
  it('чете запазената стойност', () => {
    expect(readInfoCommissionBps({ stats: { infoCommissionBps: 1250 } })).toBe(1250);
  });

  it('липсваща/повредена настройка дава 0, не NaN', () => {
    expect(readInfoCommissionBps(null)).toBe(0);
    expect(readInfoCommissionBps({})).toBe(0);
    expect(readInfoCommissionBps({ stats: {} })).toBe(0);
    expect(readInfoCommissionBps({ stats: { infoCommissionBps: 'десет' } })).toBe(0);
    expect(readInfoCommissionBps('не е обект')).toBe(0);
  });

  it('отрицателна стойност се приравнява на 0, а прекомерна се реже на тавана', () => {
    expect(readInfoCommissionBps({ stats: { infoCommissionBps: -500 } })).toBe(0);
    expect(readInfoCommissionBps({ stats: { infoCommissionBps: 99999 } })).toBe(MAX_COMMISSION_BPS);
  });

  it('дробна стойност се закръгля до цяла базисна точка', () => {
    expect(readInfoCommissionBps({ stats: { infoCommissionBps: 1000.6 } })).toBe(1001);
  });
});
```

- [ ] **Step 2: Пусни го, за да падне**

Run: `pnpm --filter @fermeribg/api test -- stats.settings`
Expected: FAIL — `Cannot find module './stats.settings'`

- [ ] **Step 3: Имплементирай**

`server/src/modules/stats/stats.settings.ts`:

```ts
/** Таван на информационната комисионна: 50%. По-високо е почти сигурно
 *  сгрешено въвеждане (напр. 10000 вместо 1000), а не реална уговорка. */
export const MAX_COMMISSION_BPS = 5000;

/** Пътят в `tenants.settings`, по който се пише процентът. Ползва се и от
 *  `jsonbDeepMerge` при запис, за да не се разминат ключовете. */
export const INFO_COMMISSION_PATH = ['stats', 'infoCommissionBps'] as const;

/**
 * Информационната комисионна в базисни точки (1000 = 10%), прочетена от
 * `tenants.settings`. Всяко нещо, което не е крайно число — липсваща настройка,
 * стар низ, повреден blob — дава 0: статистиката показва само доставката,
 * вместо да гръмне с NaN през целия екран.
 */
export function readInfoCommissionBps(settings: unknown): number {
  if (!settings || typeof settings !== 'object') return 0;
  const stats = (settings as Record<string, unknown>).stats;
  if (!stats || typeof stats !== 'object') return 0;
  const raw = (stats as Record<string, unknown>).infoCommissionBps;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  if (raw <= 0) return 0;
  return Math.min(MAX_COMMISSION_BPS, Math.round(raw));
}
```

- [ ] **Step 4: Пусни тестовете**

Run: `pnpm --filter @fermeribg/api test -- stats.settings`
Expected: PASS, 4 теста.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/stats/stats.settings.ts server/src/modules/stats/stats.settings.spec.ts
git commit -m "feat(stats): read the informational commission rate from tenant settings"
```

---

### Task 4: `ExpensesService` — CRUD + записът на процента

**Files:**
- Create: `server/src/modules/stats/expenses.service.ts`
- Create: `server/src/modules/stats/dto/expense.dto.ts`
- Test: `server/src/modules/stats/expenses.service.spec.ts`

**Interfaces:**
- Consumes: `manualExpenses` (Task 1), `readInfoCommissionBps` / `INFO_COMMISSION_PATH` / `MAX_COMMISSION_BPS` (Task 3), `jsonbDeepMerge`
- Produces: `ExpensesService` с `list(tenantId, from, to)`, `create(tenantId, userId, dto)`, `update(tenantId, id, dto)`, `remove(tenantId, id)`, `setCommissionBps(tenantId, bps)`; DTO класове `CreateExpenseDto`, `UpdateExpenseDto`, `ExpenseQueryDto`, `SetCommissionDto`; `EXPENSE_CATEGORIES`

- [ ] **Step 1: Напиши DTO-тата**

`server/src/modules/stats/dto/expense.dto.ts`:

```ts
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

/** Категориите живеят тук, а не в pg enum — нова категория не бива да иска миграция. */
export const EXPENSE_CATEGORIES = ['fuel', 'packaging', 'salary', 'fees', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Под int4 тавана (2 147 483 647 стотинки) с място за сборове. */
const MAX_AMOUNT_STOTINKI = 2_000_000_000;

/** `@IsOptional()` НЕ превръща '' в undefined — празното поле от формата иначе
 *  минава като празен низ и се записва като празна бележка/куриер. */
const emptyToUndefined = Transform(({ value }) => (value === '' ? undefined : value));

export class CreateExpenseDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Невалидна дата' })
  date!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT_STOTINKI)
  amountStotinki!: number;

  @IsIn(EXPENSE_CATEGORIES as unknown as string[])
  category!: ExpenseCategory;

  @IsOptional()
  @emptyToUndefined
  @IsUUID()
  courierAccountId?: string;

  @IsOptional()
  @emptyToUndefined
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class UpdateExpenseDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Невалидна дата' })
  date?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT_STOTINKI)
  amountStotinki?: number;

  @IsOptional()
  @IsIn(EXPENSE_CATEGORIES as unknown as string[])
  category?: ExpenseCategory;

  /** `null` изрично отвързва разхода от куриер (прави го общ). */
  @IsOptional()
  @emptyToUndefined
  @IsUUID()
  courierAccountId?: string | null;

  @IsOptional()
  @emptyToUndefined
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class ExpenseQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Невалиден период' })
  from!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Невалиден период' })
  to!: string;
}

export class SetCommissionDto {
  @IsInt()
  @Min(0)
  @Max(5000)
  bps!: number;
}
```

- [ ] **Step 2: Напиши падащия тест**

`server/src/modules/stats/expenses.service.spec.ts`:

```ts
import { NotFoundException } from '@nestjs/common';
import { SQL, Param } from 'drizzle-orm';
import { ExpensesService } from './expenses.service';

/** Изважда всяка вградена Param стойност от drizzle SQL дърво — така тестът
 *  вижда дали WHERE наистина е стеснил по tenant, вместо да вярва на мока. */
function paramValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node instanceof Param) out.push(node.value);
  else if (node instanceof SQL)
    for (const c of (node as unknown as { queryChunks: unknown[] }).queryChunks) paramValues(c, out);
  else if (Array.isArray(node)) for (const c of node) paramValues(c, out);
  return out;
}

function makeDb(returning: unknown[] = [{ id: 'exp-1' }]) {
  const captured: { where?: unknown; values?: unknown; set?: unknown } = {};
  const chain: any = {};
  for (const m of ['from', 'orderBy', 'limit']) chain[m] = jest.fn(() => chain);
  chain.where = jest.fn((w: unknown) => {
    captured.where = w;
    return chain;
  });
  chain.returning = jest.fn(async () => returning);
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(returning).then(res, rej);

  const db = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => ({
      values: jest.fn((v: unknown) => {
        captured.values = v;
        return chain;
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn((s: unknown) => {
        captured.set = s;
        return chain;
      }),
    })),
    delete: jest.fn(() => chain),
  };
  return { db, captured, chain };
}

describe('ExpensesService', () => {
  it('create записва tenantId и автора', async () => {
    const { db, captured } = makeDb();
    const svc = new ExpensesService(db as any);
    await svc.create('tenant-1', 'user-9', {
      date: '2026-07-20',
      amountStotinki: 5000,
      category: 'fuel',
    });
    expect(captured.values).toMatchObject({
      tenantId: 'tenant-1',
      createdById: 'user-9',
      amountStotinki: 5000,
      category: 'fuel',
      courierAccountId: null,
    });
  });

  it('update стеснява по tenant И по id — не само по id', async () => {
    const { db, captured } = makeDb();
    const svc = new ExpensesService(db as any);
    await svc.update('tenant-1', 'exp-1', { amountStotinki: 700 });
    const params = paramValues(captured.where);
    expect(params).toContain('tenant-1');
    expect(params).toContain('exp-1');
  });

  it('update на чужд разход дава 404, не мълчалив успех', async () => {
    const { db } = makeDb([]);
    const svc = new ExpensesService(db as any);
    await expect(svc.update('tenant-1', 'exp-foreign', { amountStotinki: 700 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('remove стеснява по tenant И по id', async () => {
    const { db, captured } = makeDb();
    const svc = new ExpensesService(db as any);
    await svc.remove('tenant-1', 'exp-1');
    const params = paramValues(captured.where);
    expect(params).toContain('tenant-1');
    expect(params).toContain('exp-1');
  });

  it('remove на несъществуващ разход дава 404', async () => {
    const { db } = makeDb([]);
    const svc = new ExpensesService(db as any);
    await expect(svc.remove('tenant-1', 'exp-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list стеснява по tenant и по двата края на периода', async () => {
    const { db, captured } = makeDb([]);
    const svc = new ExpensesService(db as any);
    await svc.list('tenant-1', '2026-07-01', '2026-07-31');
    const params = paramValues(captured.where);
    expect(params).toContain('tenant-1');
    expect(params).toContain('2026-07-01');
    expect(params).toContain('2026-07-31');
  });

  it('setCommissionBps пише през jsonbDeepMerge (запазва другите настройки)', async () => {
    const { db, captured } = makeDb();
    const svc = new ExpensesService(db as any);
    await svc.setCommissionBps('tenant-1', 1500);
    const rendered = JSON.stringify(paramValues((captured.set as { settings: unknown }).settings));
    // Пътят е вграден като параметри от jsonbDeepMerge: 'stats' → 'infoCommissionBps'.
    expect(rendered).toContain('stats');
    expect(rendered).toContain('infoCommissionBps');
    expect(rendered).toContain('1500');
  });
});
```

- [ ] **Step 3: Пусни го, за да падне**

Run: `pnpm --filter @fermeribg/api test -- expenses.service`
Expected: FAIL — `Cannot find module './expenses.service'`

- [ ] **Step 4: Имплементирай сервиза**

`server/src/modules/stats/expenses.service.ts`:

```ts
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { type Database, manualExpenses, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { jsonbDeepMerge } from '../../common/db/jsonb';
import { INFO_COMMISSION_PATH } from './stats.settings';
import type { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';

export interface ExpenseRow {
  id: string;
  date: string;
  amountStotinki: number;
  category: string;
  courierAccountId: string | null;
  note: string | null;
}

/**
 * Ръчните разходи на фермата. Всеки write стеснява по `tenant_id` И по `id` —
 * `id`-ът идва от URL-а, така че само проверка по него би позволил писане през
 * граница на наемател. Нулев засегнат ред → 404, не мълчалив успех.
 */
@Injectable()
export class ExpensesService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async list(tenantId: string, from: string, to: string): Promise<ExpenseRow[]> {
    return this.db
      .select({
        id: manualExpenses.id,
        date: manualExpenses.date,
        amountStotinki: manualExpenses.amountStotinki,
        category: manualExpenses.category,
        courierAccountId: manualExpenses.courierAccountId,
        note: manualExpenses.note,
      })
      .from(manualExpenses)
      .where(
        and(
          eq(manualExpenses.tenantId, tenantId),
          gte(manualExpenses.date, from),
          lte(manualExpenses.date, to),
        ),
      )
      .orderBy(desc(manualExpenses.date), desc(manualExpenses.createdAt));
  }

  async create(tenantId: string, userId: string, dto: CreateExpenseDto): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(manualExpenses)
      .values({
        tenantId,
        date: dto.date,
        amountStotinki: dto.amountStotinki,
        category: dto.category,
        courierAccountId: dto.courierAccountId ?? null,
        note: dto.note ?? null,
        createdById: userId,
      })
      .returning({ id: manualExpenses.id });
    return { id: row.id };
  }

  async update(tenantId: string, id: string, dto: UpdateExpenseDto): Promise<{ id: string }> {
    const patch: Record<string, unknown> = {};
    if (dto.date !== undefined) patch.date = dto.date;
    if (dto.amountStotinki !== undefined) patch.amountStotinki = dto.amountStotinki;
    if (dto.category !== undefined) patch.category = dto.category;
    // `null` е валидна цел: отвързва разхода от куриер.
    if ('courierAccountId' in dto) patch.courierAccountId = dto.courierAccountId ?? null;
    if (dto.note !== undefined) patch.note = dto.note ?? null;

    const [row] = await this.db
      .update(manualExpenses)
      .set(patch)
      .where(and(eq(manualExpenses.tenantId, tenantId), eq(manualExpenses.id, id)))
      .returning({ id: manualExpenses.id });
    if (!row) throw new NotFoundException('Разходът не е намерен');
    return { id: row.id };
  }

  async remove(tenantId: string, id: string): Promise<{ ok: true }> {
    const [row] = await this.db
      .delete(manualExpenses)
      .where(and(eq(manualExpenses.tenantId, tenantId), eq(manualExpenses.id, id)))
      .returning({ id: manualExpenses.id });
    if (!row) throw new NotFoundException('Разходът не е намерен');
    return { ok: true };
  }

  /** Пише процента атомарно в `settings`. `jsonbDeepMerge`, а не read-modify-write:
   *  паралелен запис по друг път в blob-а не бива да губи чужди ключове. */
  async setCommissionBps(tenantId: string, bps: number): Promise<{ bps: number }> {
    await this.db
      .update(tenants)
      .set({ settings: jsonbDeepMerge(tenants.settings, [...INFO_COMMISSION_PATH], bps) })
      .where(eq(tenants.id, tenantId));
    return { bps };
  }
}
```

- [ ] **Step 5: Пусни тестовете**

Run: `pnpm --filter @fermeribg/api test -- expenses.service`
Expected: PASS, 7 теста.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/stats/expenses.service.ts server/src/modules/stats/expenses.service.spec.ts server/src/modules/stats/dto/expense.dto.ts
git commit -m "feat(stats): tenant-scoped CRUD for manual expenses"
```

---

### Task 5: `PnlService` — заявките

**Files:**
- Create: `server/src/modules/stats/pnl.service.ts`
- Test: `server/src/modules/stats/pnl.service.spec.ts`

**Interfaces:**
- Consumes: `buildPnl` / `PnlAccountRow` / `PnlExpenseRow` / `PnlResult` (Task 2), `readInfoCommissionBps` (Task 3), `resolveWindow` от `./stats.service`, `bgDateTz` от `../../common/time/bg-time`
- Produces: `PnlService.pnl(tenantId: string, opts: { range?: string; from?: string; to?: string }): Promise<PnlResult & { from: string; to: string; range: StatsRangeTag }>`

- [ ] **Step 1: Напиши падащия тест**

`server/src/modules/stats/pnl.service.spec.ts`:

```ts
import { SQL, Param } from 'drizzle-orm';
import { PnlService } from './pnl.service';

function paramValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node instanceof Param) out.push(node.value);
  else if (node instanceof SQL)
    for (const c of (node as unknown as { queryChunks: unknown[] }).queryChunks) paramValues(c, out);
  else if (Array.isArray(node)) for (const c of node) paramValues(c, out);
  return out;
}

/**
 * Мок, който разпознава коя от трите заявки върви по ПРОЕКЦИЯТА ѝ и записва
 * нейния WHERE. Passthrough мок не вижда SQL-а, затова tenant-scope твърденията
 * се правят върху записания клауз, а не върху върнатите редове.
 */
function makeDb(canned: {
  revenue?: unknown[];
  expenses?: unknown[];
  names?: unknown[];
  settings?: unknown[];
}) {
  const wheres: Record<string, unknown> = {};
  const tag = (proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    if (keys.includes('deliveryStotinki')) return 'revenue';
    if (keys.includes('category')) return 'expenses';
    if (keys.includes('email')) return 'names';
    if (keys.includes('settings')) return 'settings';
    return 'other';
  };
  const rowsFor = (t: string): unknown[] =>
    t === 'revenue'
      ? (canned.revenue ?? [])
      : t === 'expenses'
        ? (canned.expenses ?? [])
        : t === 'names'
          ? (canned.names ?? [])
          : (canned.settings ?? [{ settings: null }]);

  const chain = (proj: Record<string, unknown>) => {
    const t = tag(proj);
    const b: any = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'groupBy', 'orderBy', 'as']) b[m] = jest.fn(() => b);
    b.where = jest.fn((w: unknown) => {
      wheres[t] = w;
      return b;
    });
    b.limit = jest.fn(async () => rowsFor(t));
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rowsFor(t)).then(res, rej);
    return b;
  };
  return { db: { select: jest.fn((proj: Record<string, unknown>) => chain(proj)) }, wheres };
}

describe('PnlService.pnl', () => {
  it('стеснява приходите и разходите по tenant и по прозореца', async () => {
    const { db, wheres } = makeDb({});
    const svc = new PnlService(db as any);
    await svc.pnl('tenant-1', { from: '2026-07-01', to: '2026-07-31' });

    const rev = paramValues(wheres.revenue);
    expect(rev).toContain('tenant-1');
    expect(rev).toContain('2026-07-01');
    expect(rev).toContain('2026-07-31');
    expect(rev).toContain('delivered'); // само доставени поръчки

    const exp = paramValues(wheres.expenses);
    expect(exp).toContain('tenant-1');
    expect(exp).toContain('2026-07-01');
    expect(exp).toContain('2026-07-31');
  });

  it('сглобява резултата с процента от настройките и имейлите като имена', async () => {
    const { db } = makeDb({
      revenue: [{ accountId: 'acc-1', itemsStotinki: 10000, deliveryStotinki: 500 }],
      expenses: [{ accountId: 'acc-1', category: 'fuel', amountStotinki: 400 }],
      names: [{ id: 'acc-1', email: 'ivan@ferma.bg' }],
      settings: [{ settings: { stats: { infoCommissionBps: 1000 } } }],
    });
    const svc = new PnlService(db as any);
    const res = await svc.pnl('tenant-1', { from: '2026-07-01', to: '2026-07-31' });

    expect(res.commissionBps).toBe(1000);
    expect(res.revenue).toEqual({ deliveryStotinki: 500, commissionStotinki: 1000, totalStotinki: 1500 });
    expect(res.couriers[0]).toMatchObject({ name: 'ivan@ferma.bg', expenseStotinki: 400, profitStotinki: 1100 });
    expect(res.profitStotinki).toBe(1100);
    expect(res.from).toBe('2026-07-01');
    expect(res.to).toBe('2026-07-31');
  });

  it('без нито един акаунт не се пуска заявка за имена', async () => {
    const { db } = makeDb({ revenue: [{ accountId: null, itemsStotinki: 100, deliveryStotinki: 0 }] });
    const svc = new PnlService(db as any);
    const res = await svc.pnl('tenant-1', { range: '30d' });
    expect(res.unassigned.revenueStotinki).toBe(0 + res.unassigned.commissionStotinki);
    // 3 заявки максимум: приходи, разходи, настройки — без „имена“.
    expect((db.select as jest.Mock).mock.calls.length).toBe(3);
  });

  it('доставката се клампва в SQL — никога отрицателна', async () => {
    const { db } = makeDb({});
    const svc = new PnlService(db as any);
    await svc.pnl('tenant-1', { range: '30d' });
    // Проекцията на приходната заявка е първият аргумент на select().
    const proj = (db.select as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((p: Record<string, unknown>) => 'deliveryStotinki' in p);
    const rendered = JSON.stringify((proj.deliveryStotinki as SQL).queryChunks);
    expect(rendered).toContain('greatest(0,');
  });

  it('невалиден период гърми с 400, не смята каквото и да е', async () => {
    const { db } = makeDb({});
    const svc = new PnlService(db as any);
    await expect(svc.pnl('tenant-1', { from: '2026-07-31', to: '2026-07-01' })).rejects.toMatchObject({
      status: 400,
    });
  });
});
```

- [ ] **Step 2: Пусни го, за да падне**

Run: `pnpm --filter @fermeribg/api test -- pnl.service`
Expected: FAIL — `Cannot find module './pnl.service'`

- [ ] **Step 3: Имплементирай**

`server/src/modules/stats/pnl.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { type Database, manualExpenses, orderItems, orders, routeCourierAssignments, tenants, users } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { bgDateTz, bgToday } from '../../common/time/bg-time';
import { resolveWindow, type StatsRangeTag } from './stats.service';
import { readInfoCommissionBps } from './stats.settings';
import { buildPnl, type PnlAccountRow, type PnlExpenseRow, type PnlResult } from './pnl.util';

export type PnlResponse = PnlResult & { from: string; to: string; range: StatsRangeTag };

/**
 * „Приходи / разходи / печалба“ за Статистика. Базата на деня е `deliveredAt`
 * (БГ ден): куриер печели само когато е доставил, а недоставена поръчка няма
 * ден на доставка. Нарочно НЕ се кешира — ключът е за прозорец и не може да се
 * изброи при запис на разход, а собственикът трябва да вижда въведеното веднага.
 */
@Injectable()
export class PnlService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async pnl(
    tenantId: string,
    opts: { range?: string; from?: string; to?: string } = {},
  ): Promise<PnlResponse> {
    const { from, to, range } = resolveWindow(opts, bgToday());

    // Стоките на поръчка се сумират в подзаявка. Иначе join-ът към редовете
    // размножава `orders.total_stotinki` по броя артикули и доставката излиза
    // няколкократно завишена.
    const itemsSub = this.db
      .select({
        orderId: orderItems.orderId,
        items: sql<number>`sum(${orderItems.quantity} * ${orderItems.priceStotinki})`.as('items'),
      })
      .from(orderItems)
      .groupBy(orderItems.orderId)
      .as('order_items_sum');

    // `deliveredAt` е timestamptz → ЕДНА конверсия (bgDateTz). Двойната
    // конверсия на bgDate() тук би изместила деня.
    const deliveredDay = bgDateTz(orders.deliveredAt);

    const revenueP = this.db
      .select({
        accountId: routeCourierAssignments.accountId,
        itemsStotinki: sql<number>`coalesce(sum(coalesce(${itemsSub.items}, 0)), 0)::int`,
        deliveryStotinki: sql<number>`coalesce(sum(greatest(0, ${orders.totalStotinki} - coalesce(${itemsSub.items}, 0))), 0)::int`,
      })
      .from(orders)
      .leftJoin(itemsSub, eq(itemsSub.orderId, orders.id))
      // Кой е карал тази лента в деня на доставката. `date` в дъската е text
      // 'YYYY-MM-DD', затова датата се форматира, вместо да се кастне.
      .leftJoin(
        routeCourierAssignments,
        and(
          eq(routeCourierAssignments.tenantId, orders.tenantId),
          eq(routeCourierAssignments.date, sql`to_char(${deliveredDay}, 'YYYY-MM-DD')`),
          eq(routeCourierAssignments.legIndex, orders.courierIndex),
        ),
      )
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'delivered'),
          sql`${deliveredDay} >= ${from}::date`,
          sql`${deliveredDay} <= ${to}::date`,
        ),
      )
      // Един ред на акаунт — `buildPnl` разчита на това и не слива дубликати.
      .groupBy(routeCourierAssignments.accountId);

    const expensesP = this.db
      .select({
        accountId: manualExpenses.courierAccountId,
        category: manualExpenses.category,
        amountStotinki: sql<number>`coalesce(sum(${manualExpenses.amountStotinki}), 0)::int`,
      })
      .from(manualExpenses)
      .where(
        and(
          eq(manualExpenses.tenantId, tenantId),
          gte(manualExpenses.date, from),
          lte(manualExpenses.date, to),
        ),
      )
      .groupBy(manualExpenses.courierAccountId, manualExpenses.category);

    const settingsP = this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const [revenueRows, expenseRows, settingsRows] = await Promise.all([revenueP, expensesP, settingsP]);

    const ids = [
      ...new Set(
        [...revenueRows, ...expenseRows]
          .map((r) => r.accountId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    // inArray, не ANY() — драйверът не сериализира ANY() коректно тук.
    const nameRows = ids.length
      ? await this.db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(and(eq(users.tenantId, tenantId), inArray(users.id, ids)))
      : [];
    const names: Record<string, string> = {};
    for (const n of nameRows) names[n.id] = n.email;

    const commissionBps = readInfoCommissionBps(settingsRows[0]?.settings ?? null);
    const result = buildPnl(
      revenueRows as PnlAccountRow[],
      expenseRows as PnlExpenseRow[],
      commissionBps,
      names,
    );
    return { ...result, from, to, range };
  }
}
```

- [ ] **Step 4: Пусни тестовете**

Run: `pnpm --filter @fermeribg/api test -- pnl.service`
Expected: PASS, 4 теста.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/stats/pnl.service.ts server/src/modules/stats/pnl.service.spec.ts
git commit -m "feat(stats): per-courier P&L query on the delivered-day basis"
```

---

### Task 6: Ендпойнтите

**Files:**
- Modify: `server/src/modules/stats/stats.controller.ts` (добави методи след `turnover`, ~ред 74)
- Modify: `server/src/modules/stats/stats.module.ts`
- Test: `server/src/modules/stats/stats.controller.spec.ts` (добави `describe` в края)

**Interfaces:**
- Consumes: `PnlService.pnl` (Task 5), `ExpensesService` (Task 4), DTO-тата (Task 4)
- Produces: `GET /stats/pnl`, `GET /stats/expenses`, `POST /stats/expenses`, `PATCH /stats/expenses/:id`, `DELETE /stats/expenses/:id`, `PATCH /stats/commission`

- [ ] **Step 1: Регистрирай сервизите в модула**

`server/src/modules/stats/stats.module.ts` — цялото съдържание:

```ts
import { Module } from '@nestjs/common';
import { StatsService } from './stats.service';
import { StatsController } from './stats.controller';
import { PnlService } from './pnl.service';
import { ExpensesService } from './expenses.service';

@Module({
  controllers: [StatsController],
  providers: [StatsService, PnlService, ExpensesService],
})
export class StatsModule {}
```

- [ ] **Step 2: Напиши падащите тестове за контролера**

В края на `server/src/modules/stats/stats.controller.spec.ts` (вътре във външния `describe`, преди последната затваряща скоба) добави:

```ts
  describe('P&L и разходи', () => {
    const pnlSvc = { pnl: jest.fn().mockResolvedValue('pnl') };
    const expSvc = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'exp-1' }),
      update: jest.fn().mockResolvedValue({ id: 'exp-1' }),
      remove: jest.fn().mockResolvedValue({ ok: true }),
      setCommissionBps: jest.fn().mockResolvedValue({ bps: 1000 }),
    };
    const c = new StatsController(svc as any, pnlSvc as any, expSvc as any);
    const owner = { type: 'tenant', userId: 'user-1', tenantId: 't', role: 'admin' } as any;

    beforeEach(() => jest.clearAllMocks());

    it('pnl подава прозореца на сервиза', async () => {
      await c.pnl(owner, '30d', undefined, undefined);
      expect(pnlSvc.pnl).toHaveBeenCalledWith('t', { range: '30d', from: undefined, to: undefined });
    });

    it('create записва автора от токена, не от тялото', async () => {
      await c.createExpense(owner, { date: '2026-07-20', amountStotinki: 100, category: 'fuel' } as any);
      expect(expSvc.create).toHaveBeenCalledWith('t', 'user-1', expect.objectContaining({ category: 'fuel' }));
    });

    it('update и delete подават tenantId от токена', async () => {
      await c.updateExpense(owner, 'exp-1', { amountStotinki: 200 } as any);
      expect(expSvc.update).toHaveBeenCalledWith('t', 'exp-1', { amountStotinki: 200 });
      await c.deleteExpense(owner, 'exp-1');
      expect(expSvc.remove).toHaveBeenCalledWith('t', 'exp-1');
    });

    it('процентът се записва за наемателя от токена', async () => {
      await c.setCommission(owner, { bps: 1500 } as any);
      expect(expSvc.setCommissionBps).toHaveBeenCalledWith('t', 1500);
    });
  });

  describe('роли', () => {
    // Пазачът е глобален (TenantRolesGuard) и чете @Roles през
    // reflector.getAllAndOverride([handler, class]) — метод бие клас. Тестът
    // проверява метаданните, защото пазачът не минава през unit теста.
    const ROLES_KEY = 'roles';
    it('новите ендпойнти са само за собственик, въпреки че класът пуска и farmer', () => {
      const reflect = (m: string) => Reflect.getMetadata(ROLES_KEY, (StatsController.prototype as any)[m]);
      for (const m of ['pnl', 'listExpenses', 'createExpense', 'updateExpense', 'deleteExpense', 'setCommission']) {
        expect(reflect(m)).toEqual(['admin']);
      }
      // Старите остават отворени за производител.
      expect(Reflect.getMetadata(ROLES_KEY, StatsController)).toEqual(['admin', 'farmer']);
    });
  });
```

Горе във файла добави `import 'reflect-metadata';` ако още го няма.

- [ ] **Step 3: Пусни ги, за да паднат**

Run: `pnpm --filter @fermeribg/api test -- stats.controller`
Expected: FAIL — `c.pnl is not a function`

- [ ] **Step 4: Добави методите в контролера**

В `server/src/modules/stats/stats.controller.ts` разшири импортите и конструктора:

```ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PnlService } from './pnl.service';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto, ExpenseQueryDto, SetCommissionDto, UpdateExpenseDto } from './dto/expense.dto';
```

```ts
  constructor(
    private readonly statsService: StatsService,
    private readonly pnlService: PnlService,
    private readonly expensesService: ExpensesService,
  ) {}
```

И след метода `turnover` добави:

```ts
  // ── Приходи / разходи / печалба. Само собственик: показва разходите на
  //    фермата, които производител-подакаунт и шофьор нямат работа да виждат. ──

  @Get('pnl')
  @Roles('admin')
  @ApiQuery({ name: 'range', required: false, enum: ['7d', '30d', '90d', '1y'] })
  @ApiQuery({ name: 'from', required: false, description: 'Custom range start (BG date YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, description: 'Custom range end (BG date YYYY-MM-DD)' })
  pnl(
    @CurrentUser() user: TenantRequestUser,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.pnlService.pnl(user.tenantId, { range, from, to });
  }

  @Get('expenses')
  @Roles('admin')
  listExpenses(@CurrentUser() user: TenantRequestUser, @Query() q: ExpenseQueryDto) {
    return this.expensesService.list(user.tenantId, q.from, q.to);
  }

  @Post('expenses')
  @Roles('admin')
  createExpense(@CurrentUser() user: TenantRequestUser, @Body() dto: CreateExpenseDto) {
    return this.expensesService.create(user.tenantId, user.userId, dto);
  }

  @Patch('expenses/:id')
  @Roles('admin')
  updateExpense(
    @CurrentUser() user: TenantRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseDto,
  ) {
    return this.expensesService.update(user.tenantId, id, dto);
  }

  @Delete('expenses/:id')
  @Roles('admin')
  deleteExpense(@CurrentUser() user: TenantRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.expensesService.remove(user.tenantId, id);
  }

  @Patch('commission')
  @Roles('admin')
  setCommission(@CurrentUser() user: TenantRequestUser, @Body() dto: SetCommissionDto) {
    return this.expensesService.setCommissionBps(user.tenantId, dto.bps);
  }
```

- [ ] **Step 5: Пусни тестовете на контролера**

Run: `pnpm --filter @fermeribg/api test -- stats.controller`
Expected: PASS. Ако старите тестове гърмят с „expects 3 arguments“, поправи `new StatsController(svc as any)` на `new StatsController(svc as any, {} as any, {} as any)` в съществуващите describe-ове.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/stats/stats.controller.ts server/src/modules/stats/stats.controller.spec.ts server/src/modules/stats/stats.module.ts
git commit -m "feat(stats): owner-only endpoints for P&L, expenses and commission rate"
```

---

### Task 7: Клиентски типове и API обвивки

**Files:**
- Modify: `client/src/lib/types.ts` (в края)
- Modify: `client/src/lib/api-client.ts` (след `getTurnover`, ~ред 880)

**Interfaces:**
- Consumes: формата на отговора от Task 5/6
- Produces: типове `PnlSummary`, `PnlCourier`, `ExpenseRow`, `ExpenseCategory`; функции `getPnl`, `listExpenses`, `createExpense`, `updateExpense`, `deleteExpense`, `setCommissionBps`

- [ ] **Step 1: Добави типовете**

В края на `client/src/lib/types.ts`:

```ts
// ---- Приходи / разходи / печалба (Статистика, само собственик) ----

export type ExpenseCategory = 'fuel' | 'packaging' | 'salary' | 'fees' | 'other';

export interface ExpenseRow {
  id: string;
  date: string;
  amountStotinki: number;
  category: ExpenseCategory;
  courierAccountId: string | null;
  note: string | null;
}

export interface PnlCourier {
  accountId: string;
  name: string;
  deliveryStotinki: number;
  commissionStotinki: number;
  revenueStotinki: number;
  expenseStotinki: number;
  profitStotinki: number;
}

export interface PnlSummary {
  from: string;
  to: string;
  range: StatsRange | 'custom';
  /** Информационната комисионна в базисни точки (1000 = 10%). */
  commissionBps: number;
  /** Оборот на стоката — контекст, НЕ наш приход. */
  goodsTurnoverStotinki: number;
  revenue: { deliveryStotinki: number; commissionStotinki: number; totalStotinki: number };
  expenses: { totalStotinki: number; byCategory: { category: ExpenseCategory; amountStotinki: number }[] };
  profitStotinki: number;
  couriers: PnlCourier[];
  unassigned: { deliveryStotinki: number; commissionStotinki: number; revenueStotinki: number };
  generalExpensesStotinki: number;
}
```

- [ ] **Step 2: Добави API обвивките**

В `client/src/lib/api-client.ts`, след `getTurnover`:

```ts
// ---- Приходи / разходи / печалба ----

export const getPnl = (opts: { range: StatsRange } | { from: string; to: string }) => {
  const base =
    'from' in opts
      ? `from=${encodeURIComponent(opts.from)}&to=${encodeURIComponent(opts.to)}`
      : `range=${opts.range}`;
  return apiFetch<PnlSummary>(`stats/pnl?${base}`);
};

export const listExpenses = (from: string, to: string) =>
  apiFetch<ExpenseRow[]>(`stats/expenses?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

export const createExpense = (data: {
  date: string;
  amountStotinki: number;
  category: ExpenseCategory;
  courierAccountId?: string;
  note?: string;
}) => apiFetch<{ id: string }>('stats/expenses', { method: 'POST', ...json(data) });

export const updateExpense = (
  id: string,
  data: {
    date?: string;
    amountStotinki?: number;
    category?: ExpenseCategory;
    courierAccountId?: string | null;
    note?: string;
  },
) => apiFetch<{ id: string }>(`stats/expenses/${id}`, { method: 'PATCH', ...json(data) });

export const deleteExpense = (id: string) =>
  apiFetch<{ ok: true }>(`stats/expenses/${id}`, { method: 'DELETE' });

export const setCommissionBps = (bps: number) =>
  apiFetch<{ bps: number }>('stats/commission', { method: 'PATCH', ...json({ bps }) });
```

Добави `PnlSummary`, `ExpenseRow`, `ExpenseCategory` към `import type { … } from './types'` най-горе на файла.

- [ ] **Step 3: Провери, че типовете компилират**

Run: `pnpm --filter @fermeribg/web build`
Expected: build минава без TS грешки.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts
git commit -m "feat(web): types and API wrappers for the P&L section"
```

---

### Task 8: Секцията в Статистика

**Files:**
- Create: `client/src/components/stats/pnl-format.ts`
- Create: `client/src/components/stats/pnl-section.tsx`
- Create: `client/src/components/stats/expense-dialog.tsx`
- Test: `client/src/components/stats/pnl-format.test.ts`
- Modify: `client/src/components/stats/stats-client.tsx`

**Interfaces:**
- Consumes: `getPnl`, `listExpenses`, `createExpense`, `updateExpense`, `deleteExpense`, `setCommissionBps` (Task 7); `moneyFromStotinki` от `@/lib/utils`; `StatTile`, `errMsg` от `@/lib/stat-ui`
- Produces: `<PnlSection range mode applied />`; `CATEGORY_LABELS`, `bpsToPct`, `pctToBps`, `parseAmountToStotinki`

- [ ] **Step 1: Напиши падащия тест за чистата логика**

`client/src/components/stats/pnl-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CATEGORY_LABELS, bpsToPct, pctToBps, parseAmountToStotinki } from './pnl-format';

describe('pnl-format', () => {
  it('всяка категория има български етикет', () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual(
      ['fees', 'fuel', 'other', 'packaging', 'salary'].sort(),
    );
    expect(CATEGORY_LABELS.fuel).toBe('Гориво');
  });

  it('базисни точки ↔ проценти', () => {
    expect(bpsToPct(1000)).toBe('10');
    expect(bpsToPct(1250)).toBe('12.5');
    expect(bpsToPct(0)).toBe('0');
    expect(pctToBps('12.5')).toBe(1250);
    expect(pctToBps('10')).toBe(1000);
  });

  it('невалиден процент дава null, а не NaN', () => {
    expect(pctToBps('')).toBeNull();
    expect(pctToBps('абв')).toBeNull();
    expect(pctToBps('-3')).toBeNull();
    expect(pctToBps('120')).toBeNull(); // над 50% таван
  });

  it('сума в лева → стотинки, с двата десетични разделителя', () => {
    expect(parseAmountToStotinki('12.34')).toBe(1234);
    expect(parseAmountToStotinki('12,34')).toBe(1234);
    expect(parseAmountToStotinki('7')).toBe(700);
    expect(parseAmountToStotinki('0.005')).toBe(1); // закръгля до стотинка
  });

  it('невалидна или нулева сума дава null', () => {
    expect(parseAmountToStotinki('')).toBeNull();
    expect(parseAmountToStotinki('абв')).toBeNull();
    expect(parseAmountToStotinki('0')).toBeNull();
    expect(parseAmountToStotinki('-5')).toBeNull();
  });
});
```

- [ ] **Step 2: Пусни го, за да падне**

Run: `pnpm --filter @fermeribg/web test -- pnl-format`
Expected: FAIL — не може да разреши `./pnl-format`

- [ ] **Step 3: Напиши чистата логика**

`client/src/components/stats/pnl-format.ts`:

```ts
import type { ExpenseCategory } from '@/lib/types';

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  fuel: 'Гориво',
  packaging: 'Амбалаж',
  salary: 'Заплати',
  fees: 'Такси',
  other: 'Друго',
};

/** Таванът от бекенда (MAX_COMMISSION_BPS) в проценти. */
const MAX_PCT = 50;

/** 1250 → '12.5'; целите числа остават без излишна нула. */
export function bpsToPct(bps: number): string {
  return String(Math.round(bps) / 100);
}

/** '12,5' → 1250. null при празно, нечислово, отрицателно или над тавана. */
export function pctToBps(input: string): number | null {
  const n = Number(input.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > MAX_PCT) return null;
  return Math.round(n * 100);
}

/** '12,34' лв → 1234 стотинки. null при празно, нечислово или ≤ 0. */
export function parseAmountToStotinki(input: string): number | null {
  const n = Number(input.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  const stotinki = Math.round(n * 100);
  return stotinki > 0 ? stotinki : null;
}
```

- [ ] **Step 4: Пусни теста**

Run: `pnpm --filter @fermeribg/web test -- pnl-format`
Expected: PASS, 5 теста.

- [ ] **Step 5: Напиши диалога за разход**

`client/src/components/stats/expense-dialog.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { createExpense, updateExpense } from '@/lib/api-client';
import { errMsg } from '@/lib/stat-ui';
import type { ExpenseCategory, ExpenseRow, PnlCourier } from '@/lib/types';
import { CATEGORY_LABELS, parseAmountToStotinki } from './pnl-format';

const field =
  'w-full rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[14px] font-semibold text-ff-ink focus:outline-none focus:ring-2 focus:ring-ff-green-500/40';
const labelCls = 'flex flex-col gap-1.5 text-[13px] font-bold text-ff-ink-2';

/** Днешната дата като 'YYYY-MM-DD' за подразбиране в полето. */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ExpenseDialog({
  expense,
  couriers,
  onClose,
  onSaved,
}: {
  /** null = нов разход; иначе редакция. */
  expense: ExpenseRow | null;
  couriers: PnlCourier[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(expense?.date ?? todayStr());
  const [amount, setAmount] = useState(expense ? String(expense.amountStotinki / 100) : '');
  const [category, setCategory] = useState<ExpenseCategory>(expense?.category ?? 'fuel');
  const [courierAccountId, setCourierAccountId] = useState(expense?.courierAccountId ?? '');
  const [note, setNote] = useState(expense?.note ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    const amountStotinki = parseAmountToStotinki(amount);
    if (!amountStotinki) {
      toast.error('Въведи сума по-голяма от нула');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      toast.error('Избери дата');
      return;
    }
    setSaving(true);
    try {
      if (expense) {
        await updateExpense(expense.id, {
          date,
          amountStotinki,
          category,
          courierAccountId: courierAccountId || null,
          note,
        });
      } else {
        await createExpense({
          date,
          amountStotinki,
          category,
          ...(courierAccountId ? { courierAccountId } : {}),
          ...(note ? { note } : {}),
        });
      }
      toast.success(expense ? 'Разходът е обновен' : 'Разходът е записан');
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      {/* w-full max-w-*, НЕ w-[Npx]: фиксирана ширина излиза извън 375px екран. */}
      <div
        className="w-full max-w-sm rounded-2xl bg-ff-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 font-display text-lg font-bold text-ff-ink">
          {expense ? 'Промени разход' : 'Добави разход'}
        </h2>
        <div className="flex flex-col gap-3.5">
          <label className={labelCls}>
            Дата
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
          </label>
          <label className={labelCls}>
            Сума (лв.)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="напр. 45.50"
              className={field}
              autoFocus
            />
          </label>
          <label className={labelCls}>
            Категория
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              className={field}
            >
              {(Object.keys(CATEGORY_LABELS) as ExpenseCategory[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Куриер (по избор)
            <select
              value={courierAccountId}
              onChange={(e) => setCourierAccountId(e.target.value)}
              className={field}
            >
              <option value="">Общ разход</option>
              {couriers.map((c) => (
                <option key={c.accountId} value={c.accountId}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Бележка (по избор)
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder="напр. зареждане OMV"
              className={field}
            />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Откажи
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Записвам…' : 'Запази'}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

Вариантите на `Button` са `primary | amber | ghost | outline | soft | danger` — `ghost` е правилният за „Откажи".

- [ ] **Step 6: Напиши секцията**

`client/src/components/stats/pnl-section.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Coins, Receipt, Wallet, Plus, Pencil, Trash2 } from 'lucide-react';
import { moneyFromStotinki } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { deleteExpense, getPnl, listExpenses, setCommissionBps } from '@/lib/api-client';
import { errMsg, StatTile } from '@/lib/stat-ui';
import type { ExpenseRow, PnlSummary, StatsRange } from '@/lib/types';
import { CATEGORY_LABELS, bpsToPct, pctToBps } from './pnl-format';
import { ExpenseDialog } from './expense-dialog';

const card = 'rounded-2xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm';

/** 'YYYY-MM-DD' → 'DD.MM' за компактния списък с разходи. */
const shortDate = (d: string) => {
  const [, m, dd] = d.split('-');
  return `${dd}.${m}`;
};

export function PnlSection({
  range,
  mode,
  applied,
}: {
  range: StatsRange;
  mode: 'preset' | 'custom';
  applied: { from: string; to: string } | null;
}) {
  const [data, setData] = useState<PnlSummary | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<ExpenseRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pct, setPct] = useState('');
  const [savingPct, setSavingPct] = useState(false);

  const load = useCallback(async () => {
    if (mode === 'custom' && !applied) return;
    setLoading(true);
    try {
      const summary = mode === 'custom' && applied ? await getPnl(applied) : await getPnl({ range });
      setData(summary);
      setPct(bpsToPct(summary.commissionBps));
      setExpenses(await listExpenses(summary.from, summary.to));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [mode, applied, range]);

  useEffect(() => {
    void load();
  }, [load]);

  async function savePct() {
    const bps = pctToBps(pct);
    if (bps === null) {
      toast.error('Процентът трябва да е между 0 и 50');
      return;
    }
    setSavingPct(true);
    try {
      await setCommissionBps(bps);
      toast.success('Процентът е записан');
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSavingPct(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Да изтрия ли разхода?')) return;
    try {
      await deleteExpense(id);
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  const courierName = (id: string | null) =>
    id ? (data?.couriers.find((c) => c.accountId === id)?.name ?? 'Куриер') : 'Общ';

  return (
    <section className="mt-8 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-ff-ink">Приходи и разходи</h2>
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus size={16} /> Добави разход
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile Icon={Coins} label="Приходи" value={moneyFromStotinki(data?.revenue.totalStotinki ?? 0)} sub={`доставка ${moneyFromStotinki(data?.revenue.deliveryStotinki ?? 0)} + комисионна ${moneyFromStotinki(data?.revenue.commissionStotinki ?? 0)}`} />
        <StatTile Icon={Receipt} label="Разходи" value={moneyFromStotinki(data?.expenses.totalStotinki ?? 0)} index={1} />
        <StatTile Icon={Wallet} label="Печалба" value={moneyFromStotinki(data?.profitStotinki ?? 0)} index={2} />
      </div>

      <div className={card}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-[13px] font-bold text-ff-ink-2">
            Информационна комисионна (%)
            <input
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              inputMode="decimal"
              className="w-28 rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[14px] font-semibold text-ff-ink focus:outline-none focus:ring-2 focus:ring-ff-green-500/40"
            />
          </label>
          <Button onClick={savePct} disabled={savingPct}>
            {savingPct ? 'Записвам…' : 'Запази'}
          </Button>
          <p className="text-[12.5px] font-semibold text-ff-muted-2">
            Прилага се върху стойността на доставените стоки за целия избран период.
          </p>
        </div>
      </div>

      {/* Таблица на широко, карти на телефон. */}
      <div className={card}>
        <h3 className="mb-3 font-display text-base font-bold text-ff-ink">Печалба по куриер</h3>
        {loading && !data ? (
          <p className="text-[13.5px] font-semibold text-ff-muted-2">Зареждам…</p>
        ) : (
          <>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-[13.5px]">
                <thead className="text-[12px] font-bold uppercase text-ff-muted-2">
                  <tr>
                    <th className="py-2">Куриер</th>
                    <th className="py-2 text-right">Доставка</th>
                    <th className="py-2 text-right">Комисионна</th>
                    <th className="py-2 text-right">Приход</th>
                    <th className="py-2 text-right">Разходи</th>
                    <th className="py-2 text-right">Печалба</th>
                  </tr>
                </thead>
                <tbody className="font-semibold text-ff-ink-2">
                  {(data?.couriers ?? []).map((c) => (
                    <tr key={c.accountId} className="border-t border-ff-border">
                      <td className="py-2">{c.name}</td>
                      <td className="py-2 text-right">{moneyFromStotinki(c.deliveryStotinki)}</td>
                      <td className="py-2 text-right">{moneyFromStotinki(c.commissionStotinki)}</td>
                      <td className="py-2 text-right">{moneyFromStotinki(c.revenueStotinki)}</td>
                      <td className="py-2 text-right">{moneyFromStotinki(c.expenseStotinki)}</td>
                      <td className={`py-2 text-right ${c.profitStotinki < 0 ? 'text-ff-red' : 'text-ff-ink'}`}>
                        {moneyFromStotinki(c.profitStotinki)}
                      </td>
                    </tr>
                  ))}
                  {data && data.unassigned.revenueStotinki > 0 && (
                    <tr className="border-t border-ff-border text-ff-muted-2">
                      <td className="py-2">Неразпределени</td>
                      <td className="py-2 text-right">{moneyFromStotinki(data.unassigned.deliveryStotinki)}</td>
                      <td className="py-2 text-right">{moneyFromStotinki(data.unassigned.commissionStotinki)}</td>
                      <td className="py-2 text-right">{moneyFromStotinki(data.unassigned.revenueStotinki)}</td>
                      <td className="py-2 text-right">—</td>
                      <td className="py-2 text-right">—</td>
                    </tr>
                  )}
                  {data && data.generalExpensesStotinki > 0 && (
                    <tr className="border-t border-ff-border text-ff-muted-2">
                      <td className="py-2">Общи разходи</td>
                      <td className="py-2 text-right">—</td>
                      <td className="py-2 text-right">—</td>
                      <td className="py-2 text-right">—</td>
                      <td className="py-2 text-right">{moneyFromStotinki(data.generalExpensesStotinki)}</td>
                      <td className="py-2 text-right">−{moneyFromStotinki(data.generalExpensesStotinki)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-2 sm:hidden">
              {(data?.couriers ?? []).map((c) => (
                <div key={c.accountId} className="rounded-xl border border-ff-border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[14px] font-bold text-ff-ink">{c.name}</span>
                    <span className={`text-[14px] font-extrabold ${c.profitStotinki < 0 ? 'text-ff-red' : 'text-ff-ink'}`}>
                      {moneyFromStotinki(c.profitStotinki)}
                    </span>
                  </div>
                  <div className="mt-1 text-[12.5px] font-semibold text-ff-muted-2">
                    приход {moneyFromStotinki(c.revenueStotinki)} · разходи {moneyFromStotinki(c.expenseStotinki)}
                  </div>
                </div>
              ))}
              {data && data.generalExpensesStotinki > 0 && (
                <div className="rounded-xl border border-ff-border p-3 text-[13px] font-semibold text-ff-muted-2">
                  Общи разходи: {moneyFromStotinki(data.generalExpensesStotinki)}
                </div>
              )}
            </div>

            {data && data.couriers.length === 0 && (
              <p className="text-[13.5px] font-semibold text-ff-muted-2">
                Няма доставки с назначен куриер в периода.
              </p>
            )}
          </>
        )}
      </div>

      <div className={card}>
        <h3 className="mb-3 font-display text-base font-bold text-ff-ink">Разходи за периода</h3>
        {expenses.length === 0 ? (
          <p className="text-[13.5px] font-semibold text-ff-muted-2">Няма въведени разходи.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-ff-border">
            {expenses.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-bold text-ff-ink">
                    {CATEGORY_LABELS[e.category]} · {moneyFromStotinki(e.amountStotinki)}
                  </div>
                  <div className="truncate text-[12.5px] font-semibold text-ff-muted-2">
                    {shortDate(e.date)} · {courierName(e.courierAccountId)}
                    {e.note ? ` · ${e.note}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label="Промени"
                    onClick={() => {
                      setEditing(e);
                      setDialogOpen(true);
                    }}
                    className="rounded-lg p-2 text-ff-muted-2 hover:bg-ff-surface-2"
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Изтрий"
                    onClick={() => void remove(e.id)}
                    className="rounded-lg p-2 text-ff-muted-2 hover:bg-ff-surface-2"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {dialogOpen && (
        <ExpenseDialog
          expense={editing}
          couriers={data?.couriers ?? []}
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            setDialogOpen(false);
            void load();
          }}
        />
      )}
    </section>
  );
}
```

Токените `text-ff-red`, `ff-surface-2`, `ff-muted-2` и вариантът `ghost` на `Button` вече съществуват — не ги измисляй наново.

- [ ] **Step 7: Включи секцията в страницата**

В `client/src/components/stats/stats-client.tsx` добави импорта:

```tsx
import { PnlSection } from './pnl-section';
```

и я рендирай непосредствено преди затварящия таг на главния контейнер (след `<TurnoverSection … />`):

```tsx
      {role === 'admin' && <PnlSection range={range} mode={mode} applied={applied} />}
```

- [ ] **Step 8: Пусни клиентските тестове и build**

```bash
pnpm --filter @fermeribg/web test
pnpm --filter @fermeribg/web build
```
Expected: тестовете са зелени, build минава.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/stats/pnl-format.ts client/src/components/stats/pnl-format.test.ts client/src/components/stats/pnl-section.tsx client/src/components/stats/expense-dialog.tsx client/src/components/stats/stats-client.tsx
git commit -m "feat(web): revenue, expenses and per-courier profit section in Статистика"
```

---

### Task 9: Проверка от край до край

**Files:**
- Modify: няма (само проверка; поправки, ако нещо гръмне)

**Interfaces:**
- Consumes: всичко отгоре
- Produces: доказателство, че работи

- [ ] **Step 1: Пусни целите тестови набори**

```bash
pnpm --filter @fermeribg/api test
pnpm --filter @fermeribg/web test
```
Expected: и двата напълно зелени. Тест, който минава изолирано, но пада в целия набор, е истински провал — поправи го, не го скипвай.

- [ ] **Step 2: Пусни lint и build**

```bash
pnpm lint
pnpm build
```
Expected: без грешки.

- [ ] **Step 3: Провери на живо в браузъра**

Пусни dev сървъра през preview_start (не през bash), влез като собственик, отвори `/stats`:

1. Въведи процент 10 → „Запази" → плочката „Приходи" вече включва комисионна.
2. „Добави разход" → 45.50 лв, Гориво, куриер → появява се в списъка, „Разходи" и „Печалба" се обновяват веднага (няма кеш).
3. Редактирай разхода → сумата се сменя в списъка и в плочките.
4. Изтрий го → изчезва, числата се връщат.
5. Смени периода (7д / 30д / собствен) → числата се презареждат.
6. `resize_window` на 375px → таблицата по куриер става карти, диалогът се побира без хоризонтален скрол.

Прикачи екранна снимка на секцията на 375px и на десктоп.

- [ ] **Step 4: Commit на всякакви поправки**

```bash
git add <точните пътища, които си пипнал>
git commit -m "fix(stats): <какво точно>"
```

---

## Отворени точки за собственика (не блокират изпълнението)

- Името на куриера в таблицата е неговият **имейл** — `users` таблицата няма колона за име. Ако е нужно четимо име, това е отделна задача (име на акаунт или ползване на `settings.routing.couriers[].name`).
- Процентът важи ретроактивно за цялата история — както е решено в спецификацията.
