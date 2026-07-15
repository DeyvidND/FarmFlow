// Live-DB constraint test for the `route_courier_assignments` table (Task A1).
// Requires a real Postgres reachable via TEST_DATABASE_URL (falls back to
// DATABASE_URL, matching local dev — see .env.example). Skips entirely when
// neither is set, so it never blocks a DB-less CI lane.
import { eq } from 'drizzle-orm';
import { createDb, routeCourierAssignments, tenants, users, type Database } from '@fermeribg/db';

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

(DB_URL ? describe : describe.skip)('route_courier_assignments constraints', () => {
  let db: Database;
  let tenantId: string;
  let accountA: string;
  let accountB: string;

  beforeAll(async () => {
    db = createDb(DB_URL!, { max: 3 });

    const [tenant] = await db
      .insert(tenants)
      .values({ name: 'RCA Schema Test Tenant', slug: `rca-schema-test-${Date.now()}` })
      .returning({ id: tenants.id });
    tenantId = tenant.id;

    const [a] = await db
      .insert(users)
      .values({
        tenantId,
        email: `rca-a-${Date.now()}@test.local`,
        passwordHash: 'x',
        role: 'driver',
      })
      .returning({ id: users.id });
    accountA = a.id;

    const [b] = await db
      .insert(users)
      .values({
        tenantId,
        email: `rca-b-${Date.now()}@test.local`,
        passwordHash: 'x',
        role: 'driver',
      })
      .returning({ id: users.id });
    accountB = b.id;
  });

  afterAll(async () => {
    // users.tenant_id has no ON DELETE CASCADE, so a tenant delete alone would
    // violate that FK — clean up child rows first (route_courier_assignments
    // itself cascades off both tenant_id and account_id, but the seeded users
    // don't cascade off the tenant).
    await db.delete(routeCourierAssignments).where(eq(routeCourierAssignments.tenantId, tenantId));
    await db.delete(users).where(eq(users.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });

  it('rejects a duplicate (tenantId, date, accountId)', async () => {
    await db.insert(routeCourierAssignments).values({
      tenantId,
      date: '2026-07-20',
      accountId: accountA,
      legIndex: 0,
    });

    await expect(
      db.insert(routeCourierAssignments).values({
        tenantId,
        date: '2026-07-20',
        accountId: accountA,
        legIndex: 1,
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('rejects a duplicate (tenantId, date, legIndex)', async () => {
    await db.insert(routeCourierAssignments).values({
      tenantId,
      date: '2026-07-21',
      accountId: accountA,
      legIndex: 0,
    });

    await expect(
      db.insert(routeCourierAssignments).values({
        tenantId,
        date: '2026-07-21',
        accountId: accountB,
        legIndex: 0,
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});
