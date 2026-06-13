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

export type ParsedEmbed = { type: 'youtube' | 'instagram'; embedId: string };

const YOUTUBE_PATTERNS = [
  /(?:youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/,
  /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
  /(?:youtube\.com\/(?:embed|shorts)\/)([A-Za-z0-9_-]{11})/,
];

const INSTAGRAM_PATTERN = /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/;

/**
 * Parse a YouTube or Instagram URL into a provider + id (keyless). Returns null
 * when the URL is neither — the caller turns that into a 400.
 */
export function parseEmbed(url: string): ParsedEmbed | null {
  for (const re of YOUTUBE_PATTERNS) {
    const m = url.match(re);
    if (m) return { type: 'youtube', embedId: m[1] };
  }
  const ig = url.match(INSTAGRAM_PATTERN);
  if (ig) return { type: 'instagram', embedId: ig[1] };
  return null;
}

/**
 * Sanitize WYSIWYG article HTML for safe storage + render. Allowlist matches the
 * Quill toolbar (bold/italic/underline/strike, h2/h3, color, align, lists, link,
 * inline image). Strips scripts, iframes, video, event handlers, and unsafe URLs.
 */
export function sanitizeArticleHtml(html: string): string {
  if (!html) return '';
  return sanitizeHtml(html, {
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
    // Drop <img> with no surviving (https) src instead of leaving an empty tag.
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });
}
