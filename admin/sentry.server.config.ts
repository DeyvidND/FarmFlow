// Sentry — Node.js (server) runtime init for the super-admin panel (@farmflow/admin).
// Loaded by src/instrumentation.ts when NEXT_RUNTIME === 'nodejs'.
//
// DSN is baked at build time from the CI build-arg NEXT_PUBLIC_SENTRY_DSN
// (GitHub repo variable FF_SENTRY_DSN_ADMIN). No-op unless set, so local dev and
// any build without the DSN behave exactly as before.
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
