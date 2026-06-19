// Sentry — Node.js (server) runtime init for the farmer panel (@farmflow/web).
// Loaded by src/instrumentation.ts when NEXT_RUNTIME === 'nodejs'.
//
// DSN is baked at build time from the CI build-arg NEXT_PUBLIC_SENTRY_DSN
// (GitHub repo variable FF_SENTRY_DSN_PANEL). No-op unless set, so local dev and
// any build without the DSN behave exactly as before.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    // Performance tracing is opt-in and OFF by default (0). Bump
    // SENTRY_TRACES_SAMPLE_RATE later if you want latency spans.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
  });
}
