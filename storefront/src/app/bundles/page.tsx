import type { Metadata } from 'next';
import Link from 'next/link';
import { getProducts, resolveSlug, type PublicProduct } from '@/lib/api';
import { BundlesClient } from '@/components/bundles-client';

export const metadata: Metadata = { title: 'Сезонни пакети' };

export default async function BundlesPage({
  searchParams,
}: {
  searchParams: { slug?: string };
}) {
  const slug = resolveSlug(searchParams?.slug);

  let bundles: PublicProduct[] = [];
  let failed = false;
  try {
    bundles = (await getProducts(slug)).filter((p) => p.category === 'bundle');
  } catch {
    failed = true;
  }

  return (
    <main data-screen-label="Bundles">
      <div className="wrap">
        <nav className="breadcrumb">
          <Link href="/">Начало</Link> / <span>Сезонни пакети</span>
        </nav>
      </div>

      <section className="section--tight">
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">Подбрано за теб</span>
            <h2 style={{ marginTop: 8 }}>Сезонни пакети</h2>
            <p>
              Готови комбинации на по-добра цена — идеални за подарък или за
              зареждане за седмицата. Съдържанието се сменя с реколтата.
            </p>
          </div>

          {failed ? (
            <p className="muted" style={{ marginTop: 28 }}>
              Каталогът е временно недостъпен. Опитайте отново по-късно.
            </p>
          ) : (
            <BundlesClient bundles={bundles} />
          )}
        </div>
      </section>

      <section className="section--tight">
        <div className="wrap">
          <div
            className="card"
            style={{
              padding: 'clamp(24px,4vw,44px)',
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: 24,
              alignItems: 'center',
            }}
          >
            <div>
              <h3 style={{ fontSize: 26, marginBottom: 8 }}>Искаш персонален пакет?</h3>
              <p className="muted">
                Кажи ни какво обичаш и за колко души — съставяме кутия по поръчка.
              </p>
            </div>
            <Link href="/contact" className="btn btn--primary btn--lg">
              Поискай оферта
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
