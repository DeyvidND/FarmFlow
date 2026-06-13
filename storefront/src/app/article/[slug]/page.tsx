import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  getArticle,
  getArticles,
  getStorefront,
  resolveSlug,
  ApiError,
  type PublicArticle,
} from '@/lib/api';
import { SITE } from '@/lib/site';
import { formatDate, readingTime, bodyToHtml } from '@/lib/format';
import { Facebook, Instagram, TikTok } from '@/components/icons';

type MediaItem = PublicArticle['media'][number];

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  try {
    const a = await getArticle(resolveSlug(), params.slug);
    return { title: a.title, description: a.excerpt ?? undefined };
  } catch {
    return { title: 'Статия' };
  }
}

function ArticleMedia({ m }: { m: MediaItem }) {
  const caption = m.caption ? (
    <figcaption className="muted" style={{ fontSize: 13.5, marginTop: 8, textAlign: 'center' }}>
      {m.caption}
    </figcaption>
  ) : null;

  if (m.type === 'youtube' && m.embedId) {
    return (
      <figure style={{ margin: '28px 0' }}>
        <div style={{ aspectRatio: '16 / 9', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <iframe
            src={`https://www.youtube.com/embed/${m.embedId}`}
            title={m.caption ?? 'YouTube'}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            style={{ width: '100%', height: '100%', border: 0 }}
          />
        </div>
        {caption}
      </figure>
    );
  }

  if (m.type === 'instagram') {
    return (
      <figure style={{ margin: '28px 0' }}>
        <a
          href={m.url}
          target="_blank"
          rel="noopener noreferrer"
          className="embed-ig card"
          style={{
            padding: 0,
            display: 'block',
            maxWidth: 540,
            marginInline: 'auto',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '14px 16px',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <div className="ph" style={{ width: 36, height: 36, borderRadius: '50%' }} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>{SITE.name}</div>
            <span style={{ marginLeft: 'auto', color: 'var(--muted)', display: 'inline-flex' }}>
              <Instagram style={{ width: 20, height: 20 }} />
            </span>
          </div>
          <div className="ph" style={{ aspectRatio: '1', borderRadius: 0 }}>
            <span className="ph__label">Instagram пост · 1:1</span>
          </div>
          {m.caption && <div style={{ padding: '14px 16px', fontSize: 14 }}>{m.caption}</div>}
        </a>
      </figure>
    );
  }

  if (m.type === 'video') {
    return (
      <figure style={{ margin: '28px 0' }}>
        <video
          src={m.url}
          controls
          style={{ width: '100%', borderRadius: 'var(--radius)' }}
        />
        {caption}
      </figure>
    );
  }

  // image
  return (
    <figure style={{ margin: '28px 0' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={m.url}
        alt={m.caption ?? ''}
        style={{ width: '100%', borderRadius: 'var(--radius)', display: 'block' }}
      />
      {caption}
    </figure>
  );
}

export default async function ArticlePage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { slug?: string };
}) {
  const farmSlug = resolveSlug(searchParams?.slug);

  // Articles section switched off → no public article pages.
  const profile = await getStorefront(farmSlug).catch(() => null);
  if (profile && profile.articlesEnabled === false) redirect('/');

  let article: PublicArticle;
  try {
    article = await getArticle(farmSlug, params.slug);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  // Related = other published articles, up to 3.
  let related: PublicArticle[] = [];
  try {
    related = (await getArticles(farmSlug))
      .filter((a) => a.slug !== article.slug)
      .slice(0, 3);
  } catch {
    related = [];
  }

  const media = [...article.media].sort((a, b) => a.position - b.position);

  return (
    <main data-screen-label="Single article">
      <article>
        <div className="wrap" style={{ maxWidth: 820 }}>
          <nav className="breadcrumb">
            <Link href="/">Начало</Link> / <Link href="/blog">Влог</Link> / <span>Статия</span>
          </nav>
          <header style={{ margin: '8px 0 26px' }}>
            {article.category && <span className="tag">{article.category}</span>}
            <h1 style={{ fontSize: 'clamp(32px,5vw,56px)', margin: '14px 0 16px' }}>
              {article.title}
            </h1>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                color: 'var(--muted)',
                fontSize: 14.5,
              }}
            >
              <div className="ph" style={{ width: 40, height: 40, borderRadius: '50%' }} />
              <span>
                от екипа на {SITE.name} · {formatDate(article.publishedAt)} ·{' '}
                {readingTime(article.body)}
              </span>
            </div>
          </header>
        </div>

        {/* hero */}
        <div className="wrap" style={{ maxWidth: 1000 }}>
          {article.coverImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={article.coverImageUrl}
              alt={article.title}
              style={{
                width: '100%',
                aspectRatio: '16 / 8',
                objectFit: 'cover',
                borderRadius: 'var(--radius)',
                display: 'block',
              }}
            />
          ) : (
            <div className="ph ph--rounded" style={{ aspectRatio: '16 / 8' }}>
              <span className="ph__label">Корица · 16:8</span>
            </div>
          )}
        </div>

        {/* body */}
        <div className="wrap" style={{ maxWidth: 820 }}>
          <div
            className="article-content"
            style={{ maxWidth: 720, marginInline: 'auto', marginTop: 36 }}
            dangerouslySetInnerHTML={{ __html: bodyToHtml(article.body) }}
          />

          {/* media */}
          {media.map((m) => (
            <ArticleMedia key={m.id} m={m} />
          ))}

          {/* share */}
          <hr className="divider" style={{ margin: '36px 0 24px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>Сподели:</span>
            <div className="socials" style={{ margin: 0 }}>
              <a
                href={SITE.socials.facebook}
                aria-label="Сподели във Facebook"
                style={{ background: 'var(--primary-050)', color: 'var(--primary)' }}
              >
                <Facebook />
              </a>
              <a
                href={SITE.socials.instagram}
                aria-label="Instagram"
                style={{ background: 'var(--primary-050)', color: 'var(--primary)' }}
              >
                <Instagram />
              </a>
              <a
                href={SITE.socials.tiktok}
                aria-label="TikTok"
                style={{ background: 'var(--primary-050)', color: 'var(--primary)' }}
              >
                <TikTok />
              </a>
            </div>
            <Link href="/blog" className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }}>
              ← Обратно към влога
            </Link>
          </div>
        </div>
      </article>

      {related.length > 0 && (
        <section className="section--tight" style={{ marginTop: 30 }}>
          <div className="wrap">
            <h2 style={{ fontSize: 26, marginBottom: 22 }}>Прочети още</h2>
            <div className="grid grid--3">
              {related.map((p) => (
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
                  <div style={{ padding: '18px 18px 22px' }}>
                    {p.category && <span className="tag">{p.category}</span>}
                    <h3 style={{ fontSize: 19, marginTop: p.category ? 12 : 0 }}>{p.title}</h3>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
