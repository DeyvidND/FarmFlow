// Sentry — browser init for the farmer panel (@fermeribg/web). Auto-injected into
// the client bundle by withSentryConfig (next.config.mjs).
//
// DSN is baked into the bundle at build time from NEXT_PUBLIC_SENTRY_DSN (CI
// build-arg, GitHub repo variable FF_SENTRY_DSN_PANEL). No-op unless set. The
// browser DSN ships in the JS by design — that is how the browser SDK reports
// errors — it is a public value, not a secret.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Events go straight to Sentry's ingest. No tunnel: the Next standalone
    // container can't reliably proxy to sentry.io, and tunnelling fought too many
    // layers (ad-block path names, the rewrite proxy, CF). Direct ingest works
    // for all non-ad-blocker users; ad-blocked frontend errors are accepted loss
    // (server-side errors are covered by the api's Sentry, which is ad-block-immune).
    // Error monitoring only — tracing and replay OFF (zero extra payload / cost).
    tracesSampleRate: 0,
  });
}
