/** Small formatting helpers for article/blog rendering. */

const MONTHS_FULL = [
  'януари', 'февруари', 'март', 'април', 'май', 'юни',
  'юли', 'август', 'септември', 'октомври', 'ноември', 'декември',
];

/** ISO timestamp → `"28 май 2026"` (UTC, BG month). Empty string for null.
 *  Accepts `Date` too: Drizzle types timestamps as `Date`, but the public API
 *  serializes them to ISO strings over HTTP. */
export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Rough reading time in minutes from a body (≈200 wpm, min 1). Strips HTML tags. */
export function readingMinutes(body: string | null | undefined): number {
  const text = (body ?? '').replace(/<[^>]*>/g, ' ');
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** Body → render-ready HTML (HTML passthrough; legacy plain text → <p>). */
export function bodyToHtml(body: string | null | undefined): string {
  if (!body) return '';
  // HTML only when it BEGINS with a tag (server-sanitized bodies always do).
  // Legacy plain text containing a stray "<tag" mid-string is escaped below.
  if (/^\s*<[a-z]/i.test(body)) return body;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');
}

/** `"4 мин четене"` meta string. */
export function readingTime(body: string | null | undefined): string {
  return `${readingMinutes(body)} мин четене`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

/** Inline rich field (article title / excerpt) → render-ready HTML. Sanitized
 *  values (with safe inline tags) pass through; legacy plain text is escaped. */
export function inlineToHtml(value: string | null | undefined): string {
  if (!value) return '';
  return /<[a-z][\s\S]*>/i.test(value) ? value : escapeHtml(value);
}

/** Inline rich field → plain text. For <title>/meta, alt text and aria labels. */
export function stripHtml(value: string | null | undefined): string {
  if (!value) return '';
  return decodeEntities(value.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}
