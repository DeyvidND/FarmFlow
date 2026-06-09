import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getProducts,
  getFarmers,
  getSubcategories,
  resolveSlug,
  type PublicProduct,
  type PublicFarmer,
  type PublicSubcategory,
} from '@/lib/api';
import { farmerEyebrow, farmerSections, farmerYears } from '@/lib/farmers';
import { coverCropStyle } from '@/lib/cover-crop';
import { ProductCard } from '@/components/product-card';

const anchorOf = (subcat: PublicSubcategory | null) => (subcat ? subcat.id : 'other');

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { slug?: string };
}): Promise<Metadata> {
  const slug = resolveSlug(searchParams?.slug);
  try {
    const farmers = await getFarmers(slug);
    const farmer = farmers.find((f) => f.id === params.id);
    if (farmer) return { title: farmer.name };
  } catch {
    /* ignore — falls back to default title */
  }
  return { title: 'Фермер' };
}

/**
 * Фермер — React port of `farmer.html?id=`. Farmer hero (photo, story, stats) →
 * jump-nav chips → one subsection block per category the farmer sells in, each
 * with a grid of their products and a link to that section in the full catalog.
 */
export default async function FarmerPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { slug?: string };
}) {
  const slug = resolveSlug(searchParams?.slug);

  let products: PublicProduct[] = [];
  let farmers: PublicFarmer[] = [];
  let subcategories: PublicSubcategory[] = [];
  try {
    [products, farmers, subcategories] = await Promise.all([
      getProducts(slug).then((ps) => ps.filter((p) => p.category !== 'bundle')),
      getFarmers(slug),
      getSubcategories(slug),
    ]);
  } catch {
    notFound();
  }

  const farmer = farmers.find((f) => f.id === params.id);
  if (!farmer) notFound();

  const sections = farmerSections(products, subcategories, farmer.id);
  const productCount = sections.reduce((n, s) => n + s.items.length, 0);
  const catCount = sections.filter((s) => s.subcat).length;
  const years = farmerYears(farmer.since);
  const firstAnchor = sections.length > 0 ? anchorOf(sections[0].subcat) : undefined;

  return (
    <main data-screen-label="Farmer detail">
      <div className="wrap">
        <nav className="breadcrumb">
          <Link href="/">Начало</Link> / <Link href="/farmers">Фермери</Link> /{' '}
          <span>{farmer.name}</span>
        </nav>
      </div>

      {/* farmer hero */}
      <section className="section--tight">
        <div className="wrap">
          <div className="farmer-hero">
            <div className="ph ph--rounded">
              {farmer.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={farmer.imageUrl}
                  alt={farmer.name}
                  style={{ width: '100%', height: '100%', ...coverCropStyle(farmer.coverCrop) }}
                />
              ) : (
                <span className="ph__label">{farmer.name}</span>
              )}
            </div>
            <div>
              {farmerEyebrow(farmer) && <span className="eyebrow">{farmerEyebrow(farmer)}</span>}
              <h1 style={{ fontSize: 'clamp(34px,5vw,56px)', margin: '12px 0 8px' }}>
                {farmer.name}
              </h1>
              {farmer.bio && (
                <p className="lead" style={{ marginTop: 18 }}>
                  {farmer.bio}
                </p>
              )}
              <div className="farmer-hero__meta">
                <div>
                  <div className="n">{productCount}</div>
                  <div className="l">продукта</div>
                </div>
                <div>
                  <div className="n">{catCount}</div>
                  <div className="l">категории</div>
                </div>
                {years !== null && (
                  <div>
                    <div className="n">{years}+</div>
                    <div className="l">години с нас</div>
                  </div>
                )}
              </div>
              <div className="cta-row">
                {firstAnchor && (
                  <a href={`#${firstAnchor}`} className="btn btn--primary">
                    Виж продуктите
                  </a>
                )}
                <Link href="/contact" className="btn btn--ghost">
                  Свържи се с фермера
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* subsection jump nav */}
      {sections.length > 1 && (
        <section className="section--tight" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <div className="sub-nav">
              {sections.map((s) => (
                <a key={anchorOf(s.subcat)} href={`#${anchorOf(s.subcat)}`} className="chip">
                  {s.subcat ? s.subcat.name : 'Други'} · {s.items.length}
                </a>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* subsections (categories) with products */}
      <div className="wrap">
        {sections.length === 0 ? (
          <p className="muted" style={{ padding: '28px 0' }}>
            Този фермер все още няма налични продукти.
          </p>
        ) : (
          sections.map((s) => (
            <section
              key={anchorOf(s.subcat)}
              className="subsection"
              id={anchorOf(s.subcat)}
              data-screen-label={`Farmer / ${s.subcat?.name ?? 'Други'}`}
            >
              <div className="subsection__head">
                <div>
                  <span className="eyebrow">Категория</span>
                  <h2
                    style={{
                      marginTop: 6,
                      borderLeft: s.subcat?.tint ? `4px solid ${s.subcat.tint}` : undefined,
                      paddingLeft: s.subcat?.tint ? 12 : undefined,
                    }}
                  >
                    {s.subcat ? s.subcat.name : 'Други продукти'}
                  </h2>
                  {s.subcat?.description && <p>{s.subcat.description}</p>}
                </div>
                {s.subcat && (
                  <Link href={`/products#${s.subcat.id}`} className="btn btn--soft btn--sm">
                    Виж всички в „{s.subcat.name}“
                  </Link>
                )}
              </div>
              <div className="grid grid--4">
                {s.items.map((p) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <div style={{ height: 48 }} />
    </main>
  );
}
