import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export function createDb(connectionString: string, opts: { max?: number } = {}) {
  const pool = new Pool({
    connectionString,
    max: opts.max,
    // Fail fast instead of blocking forever when every pooled connection is
    // busy — surfaces overload as a quick 500 rather than a pile-up.
    connectionTimeoutMillis: 5_000,
    // Cap any single statement so one runaway query can't pin a connection
    // (and eventually starve the whole pool) indefinitely. OLTP queries here
    // run in single-digit ms; 30s is a generous ceiling. Migrations use their
    // own Pool (migrate.ts) and are unaffected.
    statement_timeout: 30_000,
  });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;
export * from './schema';
export { schema };
export { runMigrations } from './migrate';
export { ensureSuperAdmin } from './bootstrap';
