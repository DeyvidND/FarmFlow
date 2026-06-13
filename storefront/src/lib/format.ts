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
  if (/<[a-z][\s\S]*>/i.test(body)) return body;
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

/** Split an article body into paragraphs on blank lines. */
export function paragraphs(body: string | null | undefined): string[] {
  return (body ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
