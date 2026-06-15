import sanitizeHtml from 'sanitize-html';

// Bulgarian Cyrillic → Latin for URL slugs (BDS / common transliteration).
const BG_TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};

/**
 * URL-safe slug from a (possibly Cyrillic) title. Returns an empty string when
 * the input has no transliterable characters — callers supply their own neutral
 * fallback (e.g. 'produkt', 'article') so each resource gets a sensible default
 * instead of every module inheriting the same hardcoded word.
 */
export function slugify(input: string): string {
  const lower = (input ?? '').toLowerCase().trim();
  let out = '';
  for (const ch of lower) out += BG_TRANSLIT[ch] ?? ch;
  out = out
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out;
}

/**
 * Sanitize WYSIWYG article HTML for safe storage + render. Allowlist matches the
 * Quill toolbar (bold/italic/underline/strike, h2/h3, color, align, lists, link,
 * inline image). Strips scripts, iframes, video, event handlers, and unsafe URLs.
 */
export function sanitizeArticleHtml(html: string): string {
  if (!html) return '';
  const clean = sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
      'h2', 'h3', 'ul', 'ol', 'li', 'a', 'img', 'span', 'blockquote',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt'],
      '*': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['https'] },
    allowedStyles: {
      '*': {
        'text-align': [/^(left|center|right|justify)$/],
        color: [/^#(0x)?[0-9a-fA-F]+$/, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/],
      },
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
    },
    // Inline images are uploaded to our R2 bucket (https). Drop any <img> whose
    // src isn't an absolute https URL — this also removes relative/data/http srcs
    // that scheme filtering alone would leave as a broken tag.
    exclusiveFilter: (frame) =>
      frame.tag === 'img' && !/^https:\/\//i.test(frame.attribs.src ?? ''),
  });

  // Collapse "empty" editor output (e.g. Quill's <p><br></p>) to '' so a blank
  // body is stored as empty rather than a stray empty paragraph.
  const hasText = clean.replace(/<[^>]*>/g, '').trim().length > 0;
  const hasImg = /<img\b/i.test(clean);
  return hasText || hasImg ? clean : '';
}

/**
 * Plain text from inline article HTML (title / excerpt) — used for slug bases and
 * anywhere a tag-free string is needed. Drops tags, collapses whitespace.
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Sanitize a single-line rich field (article title / excerpt). The allowlist is
 * the lightweight toolbar — bold/italic/underline/strike only. No blocks, links,
 * images, colours or alignment. Paragraph + line breaks collapse to spaces so the
 * result is always inline-safe (e.g. injected inside an <h1>).
 */
export function sanitizeInlineHtml(html: string | null | undefined): string {
  if (!html) return '';
  const flattened = html
    .replace(/<\/p>\s*<p[^>]*>/gi, ' ') // paragraph breaks → space (no word-join)
    .replace(/<br\s*\/?>/gi, ' ');
  const clean = sanitizeHtml(flattened, {
    allowedTags: ['b', 'strong', 'i', 'em', 'u', 's'],
    allowedAttributes: {},
    allowedSchemes: [],
  }).replace(/\s+/g, ' ').trim();
  // Drop to '' when no visible text survives (e.g. Quill's empty <p><br></p>).
  return stripHtml(clean) ? clean : '';
}
