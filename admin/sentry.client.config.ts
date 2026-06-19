// Sentry — browser init for the super-admin panel (@farmflow/admin). Auto-injected
// into the client bundle by withSentryConfig (next.config.mjs).
//
// The DSN is provided at RUNTIME, not build time: the root layout reads
// process.env.SENTRY_DSN on the server and writes it to window.__SENTRY_DSN__ via
// an inline <head> script that runs before this bundle. That keeps every DSN in
// Dokploy env only — nothing baked into the image, no rebuild to rotate.
//
// (A browser DSN is necessarily visible in the shipped JS — that is how any
// client-side error reporter works — but it still lives only in Dokploy.)
import * as Sentry from '@sentry/nextjs';

declare global {
  interface Window {
    __SENTRY_DSN__?: string;
    __SENTRY_ENV__?: string;
  }
}

const dsn = typeof window !== 'undefined' ? window.__SENTRY_DSN__ : undefined;

if (dsn) {
  Sentry.init({
    dsn,
    environment: window.__SENTRY_ENV__ || 'production',
    // Error monitoring only — tracing and replay OFF (zero extra payload / cost).
    tracesSampleRate: 0,
  });
}
