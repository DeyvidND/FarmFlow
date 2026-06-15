import type { NewsletterBlock, NewsletterColumn } from '@farmflow/types';
import { sanitizeNewsletterHtml } from './newsletter.util';

export interface RenderOpts {
  subject: string;
  brand: { logoUrl?: string; themeColor: string; farmName: string };
  /** Optional one-line contact string shown in the footer. */
  contact?: { line?: string } | null;
  /** Absolute unsubscribe URL (or the `{{UNSUB}}` placeholder for the send path). */
  unsubscribeUrl: string;
}

const esc = (s: string): string =>
  (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const isHttps = (u: string): boolean => /^https:\/\//i.test(u ?? '');

/**
 * Quill inline images carry no width — the sanitizer's allowlist drops the
 * width/height attributes and only keeps `text-align`/`color` styles. Left
 * alone, an embedded photo renders at its natural pixel size and overflows the
 * 600px email column (and breaks badly on phones). Force every body <img> to
 * fit its container. Applied to the rich-text (text block + column text) paths
 * where users embed images directly; the dedicated image/hero blocks already
 * set width:100% themselves.
 */
function clampBodyImgs(html: string): string {
  return html.replace(/<img\b([^>]*?)\/?>/gi, (_m, raw: string) => {
    const attrs = raw.replace(/\s+$/, '');
    if (/\bstyle\s*=/i.test(attrs)) {
      return `<img${attrs.replace(
        /style\s*=\s*"([^"]*)"/i,
        (_x, css: string) => `style="${css};max-width:100%;height:auto"`,
      )} />`;
    }
    return `<img${attrs} style="max-width:100%;height:auto;display:block" />`;
  });
}

const SPACER = { sm: 12, md: 24, lg: 40 } as const;

function img(src: string, alt = '', href?: string, caption?: string): string {
  if (!isHttps(src)) return '';
  const tag = `<img src="${esc(src)}" alt="${esc(alt)}" width="600" style="width:100%;max-width:100%;height:auto;display:block;border:0" />`;
  const wrapped = href ? `<a href="${esc(href)}" target="_blank">${tag}</a>` : tag;
  const cap = caption
    ? `<div style="padding:6px 0 0;font-family:Arial,sans-serif;font-size:12px;color:#888">${esc(caption)}</div>`
    : '';
  return `<tr><td style="padding:8px 24px">${wrapped}${cap}</td></tr>`;
}

function col(c: NewsletterColumn): string {
  if (c.kind === 'text') {
    return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333">${clampBodyImgs(
      sanitizeNewsletterHtml(c.html),
    )}</div>`;
  }
  return isHttps(c.image)
    ? `<img src="${esc(c.image)}" alt="${esc(c.alt ?? '')}" style="width:100%;height:auto;display:block;border:0" />`
    : '';
}

function block(b: NewsletterBlock, theme: string): string {
  switch (b.type) {
    case 'hero':
      return img(b.image, b.alt, b.href);
    case 'heading': {
      const size = b.level === 2 ? 20 : 26;
      return `<tr><td style="padding:8px 24px;font-family:Arial,sans-serif;font-size:${size}px;font-weight:700;color:#1a1a1a;line-height:1.3">${esc(
        b.text,
      )}</td></tr>`;
    }
    case 'text':
      return `<tr><td style="padding:8px 24px;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#333">${clampBodyImgs(
        sanitizeNewsletterHtml(b.html),
      )}</td></tr>`;
    case 'image':
      return img(b.image, b.alt, b.href, b.caption);
    case 'button':
      return `<tr><td style="padding:16px 24px" align="left"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:8px;background:${theme}"><a href="${esc(
        b.href,
      )}" target="_blank" style="display:inline-block;padding:12px 28px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none">${esc(
        b.label,
      )}</a></td></tr></table></td></tr>`;
    case 'columns':
      return (
        `<tr><td style="padding:8px 24px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>` +
        `<td class="ff-col" width="50%" valign="top" style="padding-right:8px">${col(b.left)}</td>` +
        `<td class="ff-col" width="50%" valign="top" style="padding-left:8px">${col(b.right)}</td>` +
        `</tr></table></td></tr>`
      );
    case 'divider':
      return `<tr><td style="padding:8px 24px"><div style="border-top:1px solid #e5e5e5"></div></td></tr>`;
    case 'spacer':
      return `<tr><td style="height:${SPACER[b.size ?? 'md']}px;line-height:0">&nbsp;</td></tr>`;
    default:
      return '';
  }
}

/**
 * Render a campaign's blocks to email-safe HTML: one centred 600px presentation
 * table, all styling inline (clients strip <style>/classes), with a single
 * @media rule for column-stacking on phones. The footer (contacts + unsubscribe)
 * is always appended so the unsub link can never be removed.
 *
 * The same function feeds the live preview and the actual send → true WYSIWYG.
 */
export function renderEmail(blocks: NewsletterBlock[], opts: RenderOpts): string {
  const theme = opts.brand.themeColor || '#2d6a4f';
  const header = opts.brand.logoUrl && isHttps(opts.brand.logoUrl)
    ? `<img src="${esc(opts.brand.logoUrl)}" alt="${esc(opts.brand.farmName)}" height="40" style="height:40px;width:auto;display:block;border:0" />`
    : `<span style="font-family:Arial,sans-serif;font-size:20px;font-weight:800;color:${theme}">${esc(
        opts.brand.farmName,
      )}</span>`;
  const body = blocks.map((b) => block(b, theme)).join('');
  const contactLine = opts.contact?.line
    ? `<p style="margin:0 0 8px">${esc(opts.contact.line)}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="bg"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.subject)}</title>
<style>@media (max-width:600px){.ff-col{display:block!important;width:100%!important;padding:8px 0!important}}</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f2">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:12px;overflow:hidden">
  <tr><td style="padding:20px 24px;border-bottom:3px solid ${theme}">${header}</td></tr>
  ${body}
  <tr><td style="padding:24px;border-top:1px solid #eee;font-family:Arial,sans-serif;font-size:12px;color:#999;line-height:1.5">
    ${contactLine}
    <p style="margin:0 0 8px">Получавате този имейл, защото сте се абонирали за новини от фермата.</p>
    <p style="margin:0"><a href="${esc(opts.unsubscribeUrl)}" style="color:#999">Отпиши се от абонамента</a></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
