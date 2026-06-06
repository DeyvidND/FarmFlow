import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getProduct,
  getProducts,
  getFarmers,
  resolveSlug,
  money,
  ApiError,
  type PublicProduct,
  type PublicFarmer,
} from '@/lib/api';
import { categoryMeta } from '@/lib/categories';
import { ProductBuy } from '@/components/product-buy';
import { ProductCard } from '@/components/product-card';
import { ProductGallery } from '@/components/product-gallery';
import { Leaf } from '@/components/icons';

type Props = {
  params: { slug: string };
  searchParams: { slug?: string };
};

async function loadProduct(
  tenantSlug: string,
  productSlug: string,
): Promise<PublicProduct> {
  try {
    return await getProduct(tenantSlug, productSlug);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export async function generateMetadata({
  params,
  searchParams,
}: Props): Promise<Metadata> {
  const tenantSlug = resolveSlug(searchParams?.slug);
  try {
    const product = await getProduct(tenantSlug, params.slug);
    return { title: product.name };
  } catch {
    return { title: 'Продукт' };
  }
}

export default async function ProductPage({ params, searchParams }: Props) {
  const tenantSlug = resolveSlug(searchParams?.slug);
  const product = await loadProduct(tenantSlug, params.slug);

  // Related = same category, current product excluded, up to 4. Non-fatal.
  let related: PublicProduct[] = [];
  try {
    const all = await getProducts(tenantSlug);
    related = all
      .filter((p) => p.id !== product.id && p.category === product.category)
      .slice(0, 4);
  } catch {
    related = [];
  }

  // Farmer attribution — only when the farm runs multi-producer (non-fatal).
  let farmer: PublicFarmer | undefined;
  if (product.farmerId) {
    try {
      farmer = (await getFarmers(tenantSlug)).find((f) => f.id === product.farmerId);
    } catch {
      farmer = undefined;
    }
  }

  const meta = [product.weight, product.unit].filter(Boolean).join(' · ');

  return (
    <main data-screen-label="Product detail">
      <div className="wrap">
        <nav className="breadcrumb">
          <Link href="/">Начало</Link> / <Link href="/products">Продукти</Link> /{' '}
          <span>{product.name}</span>
        </nav>
      </div>

      <section className="section--tight">
        <div className="wrap split" style={{ alignItems: 'flex-start' }}>
          {/* gallery — real ordered images (cover first), fallback to the cover */}
          <ProductGallery
            images={product.images?.length ? product.images : product.imageUrl ? [product.imageUrl] : []}
            name={product.name}
          />

          {/* info */}
          <div>
            <span className="tag">{categoryMeta(product.category).label}</span>
            <h1 style={{ fontSize: 'clamp(34px,5vw,52px)', margin: '14px 0 6px' }}>
              {product.name}
            </h1>
            {meta && (
              <div className="muted" style={{ fontSize: 16 }}>
                {meta}
              </div>
            )}
            {farmer && (
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 15, fontWeight: 600 }}
              >
                <span
                  style={{ width: 10, height: 10, borderRadius: 99, background: farmer.tint ?? '#4C8A54', flexShrink: 0 }}
                />
                Произведено от {farmer.name}
                {farmer.role && <span className="muted" style={{ fontWeight: 500 }}>· {farmer.role}</span>}
              </div>
            )}
            <div className="product__price" style={{ fontSize: 34, margin: '18px 0' }}>
              {money(product.priceStotinki)}
            </div>
            <p className="lead" style={{ fontSize: 17 }}>
              {product.description ??
                'Брани в деня на доставката и пакетирани веднага — за да стигнат до теб свежи и с непокътнат вкус.'}
            </p>

            <div className="note-fresh" style={{ margin: '22px 0' }}>
              <Leaf /> Берем в деня на доставката
            </div>

            <ProductBuy product={product} />

            <div className="card" style={{ marginTop: 26, padding: 20, boxShadow: 'none' }}>
              <div
                style={{
                  display: 'flex',
                  gap: 22,
                  flexWrap: 'wrap',
                  fontSize: 14.5,
                }}
              >
                <div>
                  <div className="muted">Произход</div>
                  <b>Варненско, България</b>
                </div>
                <div>
                  <div className="muted">Съхранение</div>
                  <b>2–3 дни в хладилник</b>
                </div>
                <div>
                  <div className="muted">Бране</div>
                  <b>На ръка</b>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {related.length > 0 && (
        <section className="section--tight">
          <div className="wrap">
            <h2 style={{ fontSize: 28, marginBottom: 22 }}>Може да харесаш още</h2>
            <div className="grid grid--4">
              {related.map((p) => (
                <ProductCard key={p.id} product={p} withStepper={false} />
              ))}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
