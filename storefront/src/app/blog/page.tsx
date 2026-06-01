import type { Metadata } from 'next';
import Link from 'next/link';
import { getArticles, resolveSlug, type PublicArticle } from '@/lib/api';
import { formatDate, readingTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Влог' };

export default async function BlogPage({
  searchParams,
}: {
  searchParams: { slug?: string };
}) {
  const slug = resolveSlug(searchParams?.slug);

  let posts: PublicArticle[] = [];
  let failed = false;
  try {
    posts = await getArticles(slug);
  } catch {
    failed = true;
  }

  const [featured, ...rest] = posts;

  return (
    <main data-screen-label="Blog list">
      <div className="wrap">
        <nav className="breadcrumb">
          <Link href="/">Начало</Link> / <span>Влог</span>
        </nav>
      </div>

      <section className="section--tight">
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">Влог</span>
            <h2 style={{ marginTop: 8 }}>Рецепти, съвети и истории от полето</h2>
            <p>
              Пишем за това, което знаем най-добре — плодове, сезони и малки
              кухненски тайни.
            </p>
          </div>

          {failed ? (
            <p className="muted" style={{ marginTop: 28 }}>
              Влогът е временно недостъпен. Опитайте отново по-късно.
            </p>
          ) : posts.length === 0 ? (
            <p className="muted" style={{ marginTop: 28 }}>
              Все още няма публикувани статии.
            </p>
          ) : (
            <>
              {/* featured first post */}
              <Link
                href={`/article/${featured.slug}`}
                className="card"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.1fr 1fr',
                  overflow: 'hidden',
                  marginBottom: 26,
                  marginTop: 26,
                }}
              >
                {featured.coverImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={featured.coverImageUrl}
                    alt={featured.title}
                    style={{ width: '100%', height: '100%', minHeight: 280, objectFit: 'cover' }}
                  />
                ) : (
                  <div className="ph" style={{ minHeight: 280, borderRadius: 0 }}>
                    <span className="ph__label">Голяма корица</span>
                  </div>
                )}
                <div
                  style={{
                    padding: 'clamp(22px,3vw,40px)',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                  }}
                >
                  <span className="tag" style={{ alignSelf: 'flex-start' }}>
                    Препоръчано
                  </span>
                  <h3 style={{ fontSize: 'clamp(24px,3vw,34px)', margin: '14px 0 12px' }}>
                    {featured.title}
                  </h3>
                  {featured.excerpt && <p className="muted">{featured.excerpt}</p>}
                  <div className="muted" style={{ fontSize: 13.5, marginTop: 16 }}>
                    {formatDate(featured.publishedAt)} · {readingTime(featured.body)}
                  </div>
                </div>
              </Link>

              {rest.length > 0 && (
                <div className="grid grid--3">
                  {rest.map((p) => (
                    <Link href={`/article/${p.slug}`} className="card" key={p.id}>
                      {p.coverImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.coverImageUrl}
                          alt={p.title}
                          style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'cover' }}
                        />
                      ) : (
                        <div className="ph" style={{ aspectRatio: '16 / 10' }}>
                          <span className="ph__label">Корица · 16:10</span>
                        </div>
                      )}
                      <div
                        style={{
                          padding: '20px 20px 24px',
                          display: 'flex',
                          flexDirection: 'column',
                          flex: 1,
                        }}
                      >
                        <h3 style={{ fontSize: 20, margin: '0 0 10px' }}>{p.title}</h3>
                        {p.excerpt && (
                          <p className="muted" style={{ fontSize: 14.5 }}>
                            {p.excerpt}
                          </p>
                        )}
                        <div className="muted" style={{ fontSize: 13, marginTop: 14 }}>
                          {formatDate(p.publishedAt)} · {readingTime(p.body)}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
