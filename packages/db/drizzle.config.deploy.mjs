/** Deploy-time migration config — plain JS, no TypeScript, no schema import.
 *  `drizzle-kit migrate` only needs the pre-generated SQL files + journal in
 *  ./drizzle and a DB URL; it never touches schema.ts. Used by the
 *  farmflow-migrate image (packages/db/Dockerfile.migrate), run by
 *  .github/workflows/deploy.yml BEFORE the new app containers start, so a
 *  migration the new code depends on is never missing in production. */
export default {
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL },
};
