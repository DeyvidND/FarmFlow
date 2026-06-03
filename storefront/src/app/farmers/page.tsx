import type { Metadata } from 'next';
import Link from 'next/link';
import {
  getProducts,
  getFarmers,
  getSubcategories,
  resolveSlug,
  type PublicProduct,
  type PublicFarmer,
  type PublicSubcategory,
} from '@/lib/api';
import { farmerProductCount, farmerSubcatCount } from '@/lib/farmers';
import { FarmerCard } from '@/components/farmer-card';
import { Heart, Star, Cart } from '@/components/icons';

export const metadata: Metadata = { title: 'Фермери' };

/**
 * Фермери — React port of `farmers.html`. Lists every producer behind the
 * storefront (multi-farmer mode) with a card → their page, plus a "how the shop
 * is organized" explainer. Empty (single-producer farm, toggle off) → a tasteful
 * fallback pointing back to the catalog.
 */
export default async function FarmersPage({
  searchParams,
}: {
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
    // fall through to the empty state below
  }

  return (
    <main data-screen-label="Farmers">
      <div className="wrap">
        <nav className="breadcrumb">
          <Link href="/">Начало</Link> / <span>Фермери</span>
        </nav>
      </div>

      <section className="section--tight">
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">Хора зад реколтата</span>
            <h2 style={{ marginTop: 8 }}>Нашите фермери</h2>
            <p>
              Малки семейни стопанства, които подбираме на ръка. Всеки фермер има своя страница с
              продукти, подредени по категории — избери чие стопанство да разгледаш.
            </p>
          </div>

          {farmers.length === 0 ? (
            <p className="muted" style={{ marginTop: 28 }}>
              Все още няма добавени фермери.{' '}
              <Link href="/products" style={{ color: 'var(--primary)' }}>
                Разгледай всички продукти
              </Link>
              .
            </p>
          ) : (
            <div className="grid grid--3" style={{ marginTop: 32 }}>
              {farmers.map((f) => (
                <FarmerCard
                  key={f.id}
                  farmer={f}
                  productCount={farmerProductCount(products, f.id)}
                  subcatCount={farmerSubcatCount(products, subcategories, f.id)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* how the relation works */}
      <section className="section" style={{ background: 'var(--surface-2)' }}>
        <div className="wrap">
          <div className="section-head center" style={{ marginBottom: 34 }}>
            <span className="eyebrow">Как е подреден магазинът</span>
            <h2 style={{ marginTop: 8 }}>Фермер → категория → продукт</h2>
          </div>
          <div className="grid grid--3">
            <div className="card value-card">
              <div className="ic">
                <Heart />
              </div>
              <h3>1 · Избираш фермер</h3>
              <p>Всяко стопанство има профил със снимка, история и собствен асортимент.</p>
            </div>
            <div className="card value-card">
              <div className="ic">
                <Star />
              </div>
              <h3>2 · Разглеждаш категориите</h3>
              <p>Продуктите на фермера са групирани в събсекции — мед, сладка, плодове, сиропи.</p>
            </div>
            <div className="card value-card">
              <div className="ic">
                <Cart />
              </div>
              <h3>3 · Поръчваш продукта</h3>
              <p>Добавяш в количката директно от категорията. Всичко идва от едно стопанство.</p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
