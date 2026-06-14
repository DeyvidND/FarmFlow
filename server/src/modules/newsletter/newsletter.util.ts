import { sanitizeArticleHtml } from '../articles/articles.util';

/**
 * Newsletter text-block HTML uses the same Quill toolbar + allowlist as articles
 * (bold/italic/lists/links/inline https images, scripts stripped). Centralised so
 * the editor, the save path, and the renderer all sanitize identically.
 */
export function sanitizeNewsletterHtml(html: string): string {
  return sanitizeArticleHtml(html);
}
