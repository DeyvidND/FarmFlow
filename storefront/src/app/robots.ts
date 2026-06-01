import type { MetadataRoute } from 'next';

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3003';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/checkout', '/confirmation'] },
    sitemap: `${BASE}/sitemap.xml`,
  };
}
