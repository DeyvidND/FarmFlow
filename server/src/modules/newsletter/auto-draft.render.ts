import type { NewsletterBlock } from '@fermeribg/types';

/** A product chosen to feature in an auto-draft. */
export interface DraftProduct {
  id: string;
  name: string;
  priceStotinki: number;
  imageUrl: string | null;
}

/** AI- (or fallback-) generated copy for an auto-draft. blurbs keyed by product name. */
export interface DraftCopy {
  subject: string;
  intro: string;
  blurbs: Record<string, string>;
}

function eur(stotinki: number): string {
  return (stotinki / 100).toFixed(2).replace('.', ',') + ' €';
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the newsletter body blocks from copy + featured products. Pure — the
 * caller passes the resolved shop URL (omitted → no links/button). The text
 * blocks are HTML-escaped here AND re-sanitized by createCampaign on save.
 */
export function assembleNewsletterBlocks(
  copy: DraftCopy,
  products: DraftProduct[],
  shopUrl?: string,
): NewsletterBlock[] {
  const blocks: NewsletterBlock[] = [];
  blocks.push({ type: 'heading', text: copy.subject, level: 1 });
  if (copy.intro.trim()) blocks.push({ type: 'text', html: `<p>${esc(copy.intro)}</p>` });

  products.forEach((p, i) => {
    if (i > 0) blocks.push({ type: 'divider' });
    if (p.imageUrl) {
      blocks.push({ type: 'image', image: p.imageUrl, alt: p.name, ...(shopUrl ? { href: shopUrl } : {}) });
    }
    const blurb = copy.blurbs[p.name]?.trim();
    blocks.push({
      type: 'text',
      html: `<p><b>${esc(p.name)}</b> — ${esc(eur(p.priceStotinki))}${blurb ? `<br>${esc(blurb)}` : ''}</p>`,
    });
  });

  if (shopUrl) blocks.push({ type: 'button', label: 'Виж всички продукти', href: shopUrl });
  return blocks;
}
