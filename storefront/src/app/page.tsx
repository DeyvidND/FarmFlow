import Link from 'next/link';
import {
  getArticles,
  getProducts,
  getFarmers,
  getSubcategories,
  getStorefront,
  getAvailability,
  resolveSlug,
  type PublicArticle,
  type PublicProduct,
  type PublicFarmer,
  type PublicSubcategory,
  type PublicAvailabilityWindow,
} from '@/lib/api';
import { formatDate, readingTime } from '@/lib/format';
import {
  farmerProductCount,
  farmerSubcatCount,
  subcategoryCount,
} from '@/lib/farmers';
import { NewsletterForm } from '@/components/newsletter-form';
import { HomeListing } from '@/components/home-listing';
import { FarmerCard } from '@/components/farmer-card';
import { ProductOfWeekHighlight } from '@/components/product-of-week';
import { AvailabilitySection } from '@/components/availability-section';
import { resolveProductOfWeek } from '@/lib/product-of-week';
import { Leaf, Truck, Heart } from '@/components/icons';

/**
 * Home — React port of `home.html`. Hero → featured strip (live catalog) →
 * trust → about teaser → blog teaser (live articles) → newsletter. The featured
 * strip prefers `featured` products, falling back to the first non-bundle four.
 */
export default async function HomePage() {
  const slug = resolveSlug();

  const [products, posts, farmers, subcategories, profile, availability] = await Promise.all([
    getProducts(slug).catch(() => [] as PublicProduct[]),
    getArticles(slug)
      .then((a) => a.slice(0, 3))
      .catch(() => [] as PublicArticle[]),
    getFarmers(slug).catch(() => [] as PublicFarmer[]),
    getSubcategories(slug).catch(() => [] as PublicSubcategory[]),
    getStorefront(slug).catch(() => null),
    getAvailability(slug).catch(() => [] as PublicAvailabilityWindow[]),
  ]);

  // The blog teaser hides when the «Статии» section is switched off.
  const articlesEnabled = profile?.articlesEnabled ?? true;

  const sellable = products.filter((p) => p.category !== 'bundle');
  const flagged = sellable.filter((p) => p.featured);
  const featured = (flagged.length > 0 ? flagged : sellable).slice(0, 4);

  // «Продукт на седмицата» — optional home highlight (manual pick or weekly auto).
  const potw = resolveProductOfWeek(profile, sellable, new Date());

  // Subsection cards for the home listing toggle (only sections with products).
  const categories = [...subcategories]
    .sort((a, b) => a.position - b.position)
    .map((subcat) => ({ subcat, count: subcategoryCount(sellable, subcat.id) }))
    .filter((c) => c.count > 0);

  // Farmers teaser — first three producers (multi-farmer mode only).
  const teaserFarmers = farmers.slice(0, 3);

  return (
    <main>
      {/* HERO */}
      <section className="hero section">
        <div className="wrap hero-grid">
          <div>
            <span className="eyebrow">Семейно стопанство · от 2014</span>
            <h1 style={{ marginTop: 14 }}>
              Берем сутрин,
              <br />
              на вратата ти
              <br />
              до вечерта.
            </h1>
            <p className="lead" style={{ marginTop: 20, maxWidth: '46ch' }}>
              Био малини, боровинки и горски плодове от слънчевите хълмове край Варна. Без пръскане,
              без компромис — само истински вкус.
            </p>
            <div className="cta-row">
              <Link href="/products" className="btn btn--primary btn--lg">
                Поръчай сега
              </Link>
              <Link href="/about" className="btn btn--ghost btn--lg">
                Нашата история
              </Link>
            </div>
            <div className="hero-stats">
              <div>
                <div className="n">100%</div>
                <div className="l">био, без пръскане</div>
              </div>
              <div>
                <div className="n">24ч</div>
                <div className="l">от бране до доставка</div>
              </div>
              <div>
                <div className="n">1 200+</div>
                <div className="l">щастливи клиенти</div>
              </div>
            </div>
          </div>
          <div>
            <div className="ph ph--rounded" style={{ aspectRatio: '4 / 5' }}>
              <span className="ph__label">Hero снимка · купа с малини · 4:5</span>
            </div>
          </div>
        </div>
      </section>

      {/* PRODUCT OF THE WEEK · optional highlight */}
      {potw && <ProductOfWeekHighlight product={potw} note={profile?.productOfWeekNote} />}

      {/* „НАЛИЧНО СЕГА" · time-bounded availability windows (opt-in toggle) */}
      {profile?.availabilitySectionEnabled && (
        <AvailabilitySection
          title={
            (profile.availabilityTitle && profile.availabilityTitle.trim())
              ? profile.availabilityTitle
              : 'Налично сега'
          }
          products={sellable}
          windows={availability}
          farmers={farmers}
        />
      )}

      {/* FEATURED LISTING · products / subsections (toggleable home layout) */}
      {featured.length > 0 && <HomeListing featured={featured} categories={categories} />}

      {/* FARMERS teaser — multi-farmer mode only */}
      {teaserFarmers.length > 0 && (
        <section className="section">
          <div className="wrap">
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                gap: 20,
                marginBottom: 28,
                flexWrap: 'wrap',
              }}
            >
              <div className="section-head" style={{ margin: 0 }}>
                <span className="eyebrow">Хора зад реколтата</span>
                <h2 style={{ marginTop: 8 }}>Запознай се с фермерите</h2>
              </div>
              <Link href="/farmers" className="btn btn--soft">
                Всички фермери
              </Link>
            </div>
            <div className="grid grid--3">
              {teaserFarmers.map((f) => (
                <FarmerCard
                  key={f.id}
                  farmer={f}
                  productCount={farmerProductCount(sellable, f.id)}
                  subcatCount={farmerSubcatCount(sellable, subcategories, f.id)}
                />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* TRUST */}
      <section className="section" style={{ background: 'var(--surface-2)' }}>
        <div className="wrap">
          <div className="grid grid--3">
            <div className="card value-card">
              <div className="ic">
                <Leaf />
              </div>
              <h3>Биологично чисти</h3>
              <p>
                Отглеждаме без химически пръскания и изкуствени торове. Само вода, слънце и грижа.
              </p>
            </div>
            <div className="card value-card">
              <div className="ic">
                <Truck />
              </div>
              <h3>Берем днес — доставяме днес</h3>
              <p>
                Поръчаното сутрин се бере същия ден и пътува към теб още преди да е омекнало.
              </p>
            </div>
            <div className="card value-card">
              <div className="ic">
                <Heart />
              </div>
              <h3>Специално отношение</h3>
              <p>Към всеки клиент се отнасяме като към съсед. Питаме, помним, благодарим.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ABOUT TEASER */}
      <section className="section">
        <div className="wrap split">
          <div className="ph ph--rounded" style={{ aspectRatio: '5 / 4' }}>
            <span className="ph__label">Снимка · стопанинът сред насажденията · 5:4</span>
          </div>
          <div>
            <span className="eyebrow">Нашата история</span>
            <h2 style={{ fontSize: 'clamp(28px,4vw,42px)', marginTop: 10 }}>
              Малка градина с
              <br />
              голяма мисия
            </h2>
            <p className="lead" style={{ marginTop: 18 }}>
              Започнахме с няколко реда малини зад къщата. Днес гледаме над тридесет сорта горски
              плодове, но философията не се е променила — качество пред количество, всеки плод обран
              на ръка.
            </p>
            <Link href="/about" className="btn btn--primary" style={{ marginTop: 24 }}>
              Научи повече
            </Link>
          </div>
        </div>
      </section>

      {/* BLOG TEASER */}
      {articlesEnabled && posts.length > 0 && (
        <section className="section--tight">
          <div className="wrap">
            <div className="section-head center" style={{ marginBottom: 30 }}>
              <span className="eyebrow">От влога</span>
              <h2 style={{ marginTop: 8 }}>Рецепти, съвети и истории от полето</h2>
            </div>
            <div className="grid grid--3">
              {posts.map((p) => (
                <Link href={`/article/${p.slug}`} className="card" key={p.id}>
                  {p.coverImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.coverImageUrl}
                      alt={p.title}
                      loading="lazy"
                      decoding="async"
                      style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'cover' }}
                    />
                  ) : (
                    <div className="ph" style={{ aspectRatio: '16 / 10' }}>
                      <span className="ph__label">Корица · 16:10</span>
                    </div>
                  )}
                  <div style={{ padding: '20px 20px 24px' }}>
                    {p.category && <span className="tag">{p.category}</span>}
                    <h3 style={{ fontSize: 21, margin: p.category ? '12px 0 10px' : '0 0 10px' }}>
                      {p.title}
                    </h3>
                    <div className="muted" style={{ fontSize: 13.5 }}>
                      {formatDate(p.publishedAt)} · {readingTime(p.body)}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* NEWSLETTER */}
      <section className="section--tight">
        <div className="wrap">
          <div className="newsletter">
            <div>
              <h2>Получавай сезонните оферти първи</h2>
              <p>Веднъж седмично — какво зрее сега, нови пакети и рецепти. Без спам.</p>
            </div>
            <NewsletterForm variant="panel" />
          </div>
        </div>
      </section>
    </main>
  );
}
