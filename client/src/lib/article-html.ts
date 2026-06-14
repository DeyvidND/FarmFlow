/**
 * Normalize an article body to render-ready HTML.
 *  - New bodies are already sanitized HTML (contain tags) → passthrough.
 *  - Legacy bodies are plain text → escape + split blank lines into <p>.
 * Kept tiny + dependency-free so the storefront + chaika can mirror it.
 */
export function bodyToHtml(body: string | null | undefined): string {
  if (!body) return '';
  // Collapse non-breaking spaces to normal ones. WYSIWYG paste (Word/PDF) often
  // joins whole paragraphs with &nbsp;, which can't wrap → the text overflows the
  // column and scrolls the page sideways on phones. In prose nbsp is never meant
  // as a word separator, so this only fixes the paste artifact.
  const denbsp = (s: string) => s.replace(/&nbsp;/gi, ' ').replace(/ /g, ' ');
  body = denbsp(body);
  // Treat as HTML only when it BEGINS with a tag (server-sanitized bodies always
  // do). Legacy plain text — even if it contains a stray "<tag" mid-string — falls
  // through to the escape path below, so old un-sanitized bodies can't inject HTML.
  if (/^\s*<[a-z]/i.test(body)) return body;
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');
}
