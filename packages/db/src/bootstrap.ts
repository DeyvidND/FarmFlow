import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { platformAdmins } from './schema';

/**
 * Create the first platform super-admin from env — but ONLY if none exists yet.
 * Lets the system bootstrap with no manual step: set SUPER_ADMIN_EMAIL +
 * SUPER_ADMIN_PASSWORD in the API env and the first boot seeds one super-admin,
 * who then onboards farms through the admin panel. No-op once any platform admin
 * exists; no-op if the env vars are unset. Safe to run on every boot.
 */
export async function ensureSuperAdmin(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  email: string | undefined = process.env.SUPER_ADMIN_EMAIL,
  password: string | undefined = process.env.SUPER_ADMIN_PASSWORD,
): Promise<void> {
  if (!databaseUrl || !email || !password) return;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db = drizzle(pool);
    const existing = await db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .limit(1);
    if (existing.length > 0) return;
    await db.insert(platformAdmins).values({
      email,
      passwordHash: await argon2.hash(password),
      // Force a rotation on first login so the env-provided bootstrap password
      // (which may be weak, reused, or shared during setup) can't persist.
      mustChangePassword: true,
    });
    // eslint-disable-next-line no-console
    console.log(`[bootstrap] created first super-admin: ${email}`);
  } finally {
    await pool.end();
  }
}
