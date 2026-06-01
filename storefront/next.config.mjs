/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@farmflow/types'],
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
