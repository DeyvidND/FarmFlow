// Sentry — Edge runtime init for the farmer panel (@farmflow/web).
// Loaded by src/instrumentation.ts when NEXT_RUNTIME === 'edge' (middleware,
// edge routes). DSN baked at build time (NEXT_PUBLIC_SENTRY_DSN). No-op unless set.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
  });
}
