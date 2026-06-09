import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getArticles, getStorefront, resolveSlug, type PublicArticle } from '@/lib/api';
import { formatDate, readingTime } from '@/lib/format';
import { BlogGrid } from '@/components/blog-grid';

export const metadata: Metadata = { title: 'Влог' };

export default async function BlogPage({
  searchParams,
}: {
  searchParams: { slug?: string };
}) {
  const slug = resolveSlug(searchParams?.slug);

  // The «Статии» section can be switched off by the farm — then this route 404s
  // back home rather than showing an orphan page.
  const profile = await getStorefront(slug).catch(() => null);
  if (profile && profile.articlesEnabled === false) redirect('/');

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
                    Препоръчано{featured.category ? ` · ${featured.category}` : ''}
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

              {rest.length > 0 && <BlogGrid posts={rest} />}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
