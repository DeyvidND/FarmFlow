// Sentry — browser init for the super-admin panel (@farmflow/admin). Auto-injected
// into the client bundle by withSentryConfig (next.config.mjs).
//
// DSN is baked into the bundle at build time from NEXT_PUBLIC_SENTRY_DSN (CI
// build-arg, GitHub repo variable FF_SENTRY_DSN_ADMIN). No-op unless set. The
// browser DSN ships in the JS by design — that is how the browser SDK reports
// errors — it is a public value, not a secret.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Error monitoring only — tracing and replay OFF (zero extra payload / cost).
    tracesSampleRate: 0,
  });
}
