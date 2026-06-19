import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withSentryConfig } from '@sentry/nextjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle for Docker, gated behind an env flag the
  // Dockerfile sets (NEXT_OUTPUT_STANDALONE=1). Off by default so local builds —
  // including on Windows, where standalone tracing can't create symlinks — work
  // unchanged. `outputFileTracingRoot` points at the monorepo root for tracing.
  output: process.env.NEXT_OUTPUT_STANDALONE === '1' ? 'standalone' : undefined,
  outputFileTracingRoot: join(__dirname, '..'),
  // Security headers on every response — clickjacking + sniffing + referrer + HSTS.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            // frame-ancestors blocks clickjacking; object-src/base-uri are
            // zero-breakage hardening (kill <object>/<embed> and <base> hijacks).
            // A full script-src is still omitted (Next ships inline bootstrap).
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

// Wrap with Sentry. The bundler plugin injects sentry.client.config.ts into the
// browser bundle and wires source-map upload. Upload only runs when SENTRY_ORG /
// SENTRY_PROJECT / SENTRY_AUTH_TOKEN are set — otherwise the build still succeeds
// and errors are captured with minified stack traces. SDK init itself is a no-op
// unless NEXT_PUBLIC_SENTRY_DSN is present, so local builds are unchanged.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  disableLogger: true,
  // NOTE: we do NOT use Sentry's `tunnelRoute` (Next external-rewrite proxy) — it
  // 500s under output:'standalone' in Docker. Instead a custom route handler at
  // src/app/api/ff-rt/route.ts forwards envelopes via plain fetch, and the client
  // SDK targets it via `tunnel` in sentry.client.config.ts. Same-origin obscure
  // slug = ad-blockers don't drop real users' error reports.
});
