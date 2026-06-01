import type { Metadata } from 'next';
import Link from 'next/link';
import { getProducts, resolveSlug, type PublicProduct } from '@/lib/api';
import { CatalogClient } from '@/components/catalog-client';

export const metadata: Metadata = { title: 'Продукти' };

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: { slug?: string };
}) {
  const slug = resolveSlug(searchParams?.slug);

  let products: PublicProduct[] = [];
  let failed = false;
  try {
    // Bundles (category='bundle') live on their own /bundles page.
    products = (await getProducts(slug)).filter((p) => p.category !== 'bundle');
  } catch {
    failed = true;
  }

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
            <CatalogClient products={products} />
          )}
        </div>
      </section>
    </main>
  );
}
