import Link from 'next/link';
import { getArticles, resolveSlug, type PublicArticle } from '@/lib/api';
import { formatDate, readingTime } from '@/lib/format';

/**
 * Temporary home placeholder. The full hero/home lands in a later feature; for
 * now it routes into the live catalog (S2) and teases the latest blog posts (S8).
 */
export default async function HomePage() {
  const slug = resolveSlug();
  let posts: PublicArticle[] = [];
  try {
    posts = (await getArticles(slug)).slice(0, 3);
  } catch {
    posts = [];
  }

  return (
    <main>
      <section className="wrap section center">
        <span className="eyebrow">FarmFlow storefront</span>
        <h1 style={{ marginTop: 14 }}>Магазинът се изгражда.</h1>
        <p className="lead" style={{ marginTop: 16, maxWidth: '48ch', marginInline: 'auto' }}>
          Каталогът е на линия. Разгледай продуктите ни.
        </p>
        <div className="cta-row" style={{ justifyContent: 'center', marginTop: 28 }}>
          <Link href="/products" className="btn btn--primary btn--lg">
            Към продуктите
          </Link>
        </div>
      </section>

      {posts.length > 0 && (
        <section className="section--tight">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">От влога</span>
              <h2 style={{ marginTop: 8 }}>Последно от полето</h2>
            </div>
            <div className="grid grid--3" style={{ marginTop: 26 }}>
              {posts.map((p) => (
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
                  <div style={{ padding: '18px 18px 22px', display: 'flex', flexDirection: 'column', flex: 1 }}>
                    <h3 style={{ fontSize: 19, margin: '0 0 10px' }}>{p.title}</h3>
                    {p.excerpt && (
                      <p className="muted" style={{ fontSize: 14 }}>
                        {p.excerpt}
                      </p>
                    )}
                    <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>
                      {formatDate(p.publishedAt)} · {readingTime(p.body)}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
            <div className="center" style={{ marginTop: 24 }}>
              <Link href="/blog" className="btn btn--ghost">
                Към влога
              </Link>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
