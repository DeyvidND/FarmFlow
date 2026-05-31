import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Load env from the repo root .env, then a local .env if present (cwd is packages/db
// when run via pnpm --filter, so the root file would otherwise be missed).
config({ path: '../../.env' });
config();

// uuid-ossp extension must be installed in PostgreSQL before running migrations.
// The first migration prepends CREATE EXTENSION IF NOT EXISTS "uuid-ossp".
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
