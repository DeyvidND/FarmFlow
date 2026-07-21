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
