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
  transpilePackages: ['@farmflow/types'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
  // The storefront talks to the public API directly via NEXT_PUBLIC_API_URL
  // (CORS `*`, no auth). No rewrite proxy needed — unlike the admin client.
  images: {
    // Allowed remote image hosts (article media on Unsplash, product media on R2)
    // so next/image can be adopted without further config.
    remotePatterns: [
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: '**.r2.dev' },
      { protocol: 'https', hostname: '**.r2.cloudflarestorage.com' },
    ],
  },
};

export default nextConfig;
