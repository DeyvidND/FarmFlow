import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export function createDb(connectionString: string, opts: { max?: number } = {}) {
  const pool = new Pool({ connectionString, max: opts.max });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;
export * from './schema';
export { schema };
export { runMigrations } from './migrate';
export { ensureSuperAdmin } from './bootstrap';
