import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { join } from 'node:path';

/**
 * Apply any pending Drizzle migrations, then close the connection. Idempotent —
 * already-applied migrations are skipped (tracked in the __drizzle_migrations
 * table). Uses the drizzle-orm migrator (a runtime dep) rather than the
 * drizzle-kit CLI (dev-only, absent from the production image).
 *
 * The compiled SQL lives in this package's `drizzle/` folder, which sits next to
 * `dist/` at runtime (the Dockerfile copies it into node_modules/@farmflow/db).
 * `__dirname` here is `.../@farmflow/db/dist`, so `../drizzle` resolves correctly.
 */
export async function runMigrations(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
): Promise<void> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: join(__dirname, '..', 'drizzle') });
  } finally {
    await pool.end();
  }
}
