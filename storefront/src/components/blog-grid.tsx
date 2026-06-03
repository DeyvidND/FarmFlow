'use client';

/**
 * Blog grid + category filter tabs — React port of `blog.html`'s `data-tabs`.
 * Tabs are built from the categories actually present in the posts (plus
 * "Всички"); filtering is client-side over the already-fetched list. The
 * featured first post lives in the server page above this; this renders the rest.
 */
import { useState } from 'react';
import Link from 'next/link';
import type { PublicArticle } from '@/lib/api';
import { formatDate, readingTime } from '@/lib/format';

const ALL = 'Всички';

export function BlogGrid({ posts }: { posts: PublicArticle[] }) {
  const categories = Array.from(
    new Set(posts.map((p) => p.category).filter((c): c is string => !!c)),
  );
  const [active, setActive] = useState<string>(ALL);
  const shown = active === ALL ? posts : posts.filter((p) => p.category === active);

  return (
    <>
      {categories.length > 0 && (
        <div className="chips-row" style={{ margin: '26px 0' }}>
          {[ALL, ...categories].map((c) => (
            <button
              key={c}
              type="button"
              className={`chip${active === c ? ' is-active' : ''}`}
              onClick={() => setActive(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {shown.length > 0 ? (
        <div className="grid grid--3">
          {shown.map((p) => (
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
              <div
                style={{
                  padding: '20px 20px 24px',
                  display: 'flex',
                  flexDirection: 'column',
                  flex: 1,
                }}
              >
                {p.category && (
                  <span className="tag" style={{ alignSelf: 'flex-start' }}>
                    {p.category}
                  </span>
                )}
                <h3 style={{ fontSize: 20, margin: p.category ? '12px 0 10px' : '0 0 10px' }}>
                  {p.title}
                </h3>
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
      ) : (
        <p className="muted" style={{ marginTop: 8 }}>
          Няма статии в тази категория.
        </p>
      )}
    </>
  );
}
