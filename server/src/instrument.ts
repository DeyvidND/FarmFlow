import * as Sentry from '@sentry/nestjs';

// Sentry must initialize before the rest of the app loads, so this file is the
// VERY FIRST import in main.ts — that lets its auto-instrumentation patch the
// http/express/pg layers as they're required.
//
// No-op unless SENTRY_DSN is set: local dev and any deploy without the secret
// behave exactly as before (Sentry.init never runs, so every captureException()
// elsewhere is a silent no-op). Set SENTRY_DSN in the environment to switch it on.
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Tag events by environment so prod errors don't mix with staging/dev.
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    // Performance tracing is opt-in and OFF by default (0) — error monitoring
    // needs none of it. Bump SENTRY_TRACES_SAMPLE_RATE (e.g. 0.1) later if you
    // want latency spans on requests/queries.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
  });
}
