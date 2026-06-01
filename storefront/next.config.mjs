/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@farmflow/types'],
  // The storefront talks to the public API directly via NEXT_PUBLIC_API_URL
  // (CORS `*`, no auth). No rewrite proxy needed — unlike the admin client.
};

export default nextConfig;
