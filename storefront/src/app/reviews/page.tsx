import type { Metadata } from 'next';
import Link from 'next/link';
import { getReviews, resolveSlug, type ReviewSummary } from '@/lib/api';
import { Stars } from '@/components/stars';
import { ReviewForm } from '@/components/review-form';

export const metadata: Metadata = { title: 'Отзиви' };

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: { slug?: string };
}) {
  const slug = resolveSlug(searchParams?.slug);

  let data: ReviewSummary = { average: 0, count: 0, reviews: [] };
  let failed = false;
  try {
    data = await getReviews(slug);
  } catch {
    failed = true;
  }
  const avgText = data.average.toFixed(1).replace('.', ',');

  return (
    <main data-screen-label="Reviews">
      <div className="wrap">
        <nav className="breadcrumb">
          <Link href="/">Начало</Link> / <span>Отзиви</span>
        </nav>
      </div>

      <section className="section--tight">
        <div className="wrap">
          <div className="split" style={{ alignItems: 'center' }}>
            <div className="section-head" style={{ margin: 0 }}>
              <span className="eyebrow">Отзиви</span>
              <h2 style={{ marginTop: 8 }}>Какво казват клиентите</h2>
              <p>Истински мнения от хора, които поръчват от нас.</p>
            </div>
            {data.count > 0 && (
              <div
                style={{
                  display: 'flex',
                  gap: 28,
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  flexWrap: 'wrap',
                }}
              >
                <div className="center">
                  <div
                    style={{ fontSize: 64, lineHeight: 1, fontFamily: 'var(--font-head)', fontWeight: 700 }}
                  >
                    {avgText}
                  </div>
                  <Stars value={Math.round(data.average)} />
                </div>
                <div style={{ fontSize: 14.5, color: 'var(--muted)', maxWidth: '18ch' }}>
                  от {data.count} {data.count === 1 ? 'оценка' : 'оценки'}
                </div>
              </div>
            )}
          </div>

          {failed ? (
            <p className="muted" style={{ marginTop: 28 }}>
              Отзивите са временно недостъпни. Опитайте отново по-късно.
            </p>
          ) : data.reviews.length === 0 ? (
            <p className="muted" style={{ marginTop: 28 }}>
              Все още няма отзиви — бъди първият!
            </p>
          ) : (
            <div className="grid grid--3" style={{ marginTop: 34 }}>
              {data.reviews.map((r) => (
                <article className="card review-card" key={r.id}>
                  <Stars value={r.rating} />
                  <p>„{r.body}“</p>
                  <div className="who">
                    <div className="ph avatar"></div>
                    <div>
                      <b>{r.authorName}</b>
                      {r.authorLocation && <span>{r.authorLocation}</span>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* leave a review */}
      <section className="section--tight">
        <div className="wrap">
          <div
            className="card"
            style={{ padding: 'clamp(24px,4vw,40px)', maxWidth: 720, marginInline: 'auto' }}
          >
            <h3 style={{ fontSize: 26, marginBottom: 6 }}>Остави ревю</h3>
            <p className="muted" style={{ marginBottom: 22 }}>
              Поръчвал/а си от нас? Сподели впечатленията си — помага на други да
              изберат. Ревюто се появява след одобрение.
            </p>
            <ReviewForm />
          </div>
        </div>
      </section>
    </main>
  );
}
