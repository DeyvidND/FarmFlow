import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

export default nextConfig;
