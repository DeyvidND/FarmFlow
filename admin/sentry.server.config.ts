// Sentry — Node.js (server) runtime init for the super-admin panel (@farmflow/admin).
// Loaded by src/instrumentation.ts when NEXT_RUNTIME === 'nodejs'.
//
// DSN is read at RUNTIME from the container env (set in Dokploy, mapped from
// SENTRY_DSN_ADMIN → SENTRY_DSN in docker-compose). No-op unless set, so local
// dev and any deploy without the secret behave exactly as before.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
  });
}
