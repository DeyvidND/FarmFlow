/**
 * Normalize an article body to render-ready HTML.
 *  - New bodies are already sanitized HTML (contain tags) → passthrough.
 *  - Legacy bodies are plain text → escape + split blank lines into <p>.
 * Kept tiny + dependency-free so the storefront + chaika can mirror it.
 */
export function bodyToHtml(body: string | null | undefined): string {
  if (!body) return '';
  if (/<[a-z][\s\S]*>/i.test(body)) return body; // already HTML
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');
}
