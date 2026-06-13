'use client';

import type { Article, ArticleMedia } from '@/lib/types';
import { bodyToHtml } from '@/lib/article-html';

/**
 * Renders an article + its ordered media exactly as the storefront does — the
 * panel Преглед tab and the boilerplate storefront share this component, so
 * preview == live (WYSIWYG). Media is assumed pre-ordered by `position`.
 *
 * Render rules (the storefront contract, 8.4):
 *   image     → <img>            video     → <video controls>
 *   youtube   → /embed/{id}      instagram → /p/{shortcode}/embed
 */
export function ArticleRenderer({ article }: { article: Article }) {
  const html = bodyToHtml(article.body);

  return (
    <article className="mx-auto max-w-[680px]">
      {article.coverImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={article.coverImageUrl}
          alt=""
          className="mb-6 h-[300px] w-full rounded-2xl border border-ff-border object-cover max-sm:h-[200px]"
        />
      )}

      <h1 className="font-display text-[30px] font-extrabold leading-[1.15] tracking-[-0.02em] max-sm:text-[24px]">
        {article.title || 'Без заглавие'}
      </h1>

      {article.excerpt && (
        <p className="mt-3 text-[17px] leading-[1.55] text-ff-ink-2">{article.excerpt}</p>
      )}

      {html && (
        <div
          className="article-content mt-5"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}

      {article.media.length > 0 && (
        <div className="mt-7 flex flex-col gap-6">
          {article.media.map((m) => (
            <MediaBlock key={m.id} media={m} />
          ))}
        </div>
      )}
    </article>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  // 16:9 responsive container for iframes/video.
  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-ff-border bg-black/5 pt-[56.25%]">
      <div className="absolute inset-0">{children}</div>
    </div>
  );
}

function Caption({ text }: { text: string | null }) {
  if (!text) return null;
  return <figcaption className="mt-2 text-[13px] text-ff-muted">{text}</figcaption>;
}

function MediaBlock({ media }: { media: ArticleMedia }) {
  return (
    <figure>
      {media.type === 'image' && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={media.url}
          alt={media.caption ?? ''}
          className="w-full rounded-xl border border-ff-border object-cover"
        />
      )}

      {media.type === 'video' && (
        <Frame>
          <video src={media.url} controls className="h-full w-full" />
        </Frame>
      )}

      {media.type === 'youtube' && media.embedId && (
        <Frame>
          <iframe
            src={`https://www.youtube.com/embed/${media.embedId}`}
            title={media.caption ?? 'YouTube видео'}
            className="h-full w-full border-0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            loading="lazy"
          />
        </Frame>
      )}

      {media.type === 'instagram' && media.embedId && (
        <Frame>
          <iframe
            src={`https://www.instagram.com/p/${media.embedId}/embed`}
            title={media.caption ?? 'Instagram публикация'}
            className="h-full w-full border-0"
            loading="lazy"
            scrolling="no"
          />
        </Frame>
      )}

      <Caption text={media.caption} />
    </figure>
  );
}
