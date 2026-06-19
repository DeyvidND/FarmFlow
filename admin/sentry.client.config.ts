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
    // Route events through our own same-origin handler (src/app/api/ff-rt/route.ts)
    // so ad-blockers don't drop them. The SDK includes the DSN in the envelope
    // header so the handler knows where to forward.
    tunnel: '/api/ff-rt',
    // Error monitoring only — tracing and replay OFF (zero extra payload / cost).
    tracesSampleRate: 0,
  });
}
