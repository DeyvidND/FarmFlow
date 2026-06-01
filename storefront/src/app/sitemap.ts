import type { MetadataRoute } from 'next';
import { getProducts, getArticles, resolveSlug } from '@/lib/api';

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3003';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const slug = resolveSlug();

  const staticPaths = ['', '/products', '/bundles', '/cart', '/checkout', '/blog', '/about', '/contact', '/faq', '/reviews'];
  const staticEntries: MetadataRoute.Sitemap = staticPaths.map((p) => ({
    url: `${BASE}${p}`,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: p === '' ? 1 : 0.7,
  }));

  let dynamicEntries: MetadataRoute.Sitemap = [];
  try {
    const [products, articles] = await Promise.all([
      getProducts(slug).catch(() => []),
      getArticles(slug).catch(() => []),
    ]);
    dynamicEntries = [
      ...products
        .filter((p) => p.slug && p.category !== 'bundle')
        .map((p) => ({
          url: `${BASE}/product/${p.slug}`,
          changeFrequency: 'weekly' as const,
          priority: 0.6,
        })),
      ...articles.map((a) => ({
        url: `${BASE}/article/${a.slug}`,
        lastModified: a.publishedAt ? new Date(a.publishedAt) : undefined,
        changeFrequency: 'monthly' as const,
        priority: 0.5,
      })),
    ];
  } catch {
    // catalog offline → ship the static map
  }

  return [...staticEntries, ...dynamicEntries];
}
