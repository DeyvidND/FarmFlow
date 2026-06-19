// Sentry — Edge runtime init for the farmer panel (@farmflow/web).
// Loaded by src/instrumentation.ts when NEXT_RUNTIME === 'edge' (middleware,
// edge routes). DSN read at RUNTIME from container env. No-op unless set.
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
