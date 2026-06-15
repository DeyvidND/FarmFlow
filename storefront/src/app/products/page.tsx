import type { Metadata } from 'next';
import Link from 'next/link';
import {
  getProducts,
  getSubcategories,
  getFarmers,
  getAvailability,
  resolveSlug,
  type PublicProduct,
  type PublicSubcategory,
  type PublicFarmer,
  type PublicAvailabilityWindow,
} from '@/lib/api';
import { StorefrontCatalog } from '@/components/storefront-catalog';

export const metadata: Metadata = { title: 'Продукти' };

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: { slug?: string };
}) {
  const slug = resolveSlug(searchParams?.slug);

  let products: PublicProduct[] = [];
  let subcategories: PublicSubcategory[] = [];
  let farmers: PublicFarmer[] = [];
  let availability: PublicAvailabilityWindow[] = [];
  let failed = false;
  try {
    // Bundles (category='bundle') live on their own /bundles page.
    [products, subcategories, farmers, availability] = await Promise.all([
      getProducts(slug).then((ps) => ps.filter((p) => p.category !== 'bundle')),
      getSubcategories(slug),
      getFarmers(slug),
      getAvailability(slug).catch(() => [] as PublicAvailabilityWindow[]),
    ]);
  } catch {
    failed = true;
  }

  // Per-product availability map: productId → remaining (defensive: empty when feature off).
  const availMap = new Map((availability ?? []).map((w) => [w.productId, w.remaining]));

  return (
    <main data-screen-label="Catalog">
      <div className="wrap">
        <nav className="breadcrumb">
          <Link href="/">Начало</Link> / <span>Продукти</span>
        </nav>
      </div>

      <section className="section--tight">
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">Магазин</span>
            <h2 style={{ marginTop: 8 }}>Цялата реколта на едно място</h2>
            <p>
              Избери категория. Всичко се бере в деня на доставка — затова
              наличностите се обновяват сутрин.
            </p>
          </div>

          {failed ? (
            <p className="muted" style={{ marginTop: 28 }}>
              Каталогът е временно недостъпен. Опитайте отново по-късно.
            </p>
          ) : (
            <StorefrontCatalog products={products} subcategories={subcategories} farmers={farmers} availMap={availMap} />
          )}
        </div>
      </section>
    </main>
  );
}
