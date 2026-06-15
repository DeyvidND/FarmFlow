import type { NewsletterBlock } from '@/lib/api-client';

/**
 * Starter layouts for a new campaign. Each template just pre-fills the existing
 * block model (rendered server-side by renderEmail) — picking one drops the
 * farmer straight into a ready-to-edit email instead of a blank canvas. The
 * `blank` template seeds a single rich-text body so the editor opens as one
 * write-here field rather than an empty "Добави блок" prompt.
 */
export interface NewsletterTemplate {
  id: string;
  name: string;
  description: string;
  blocks: NewsletterBlock[];
}

export const NEWSLETTER_TEMPLATES: NewsletterTemplate[] = [
  {
    id: 'blank',
    name: 'Празно',
    description: 'Започни от чисто — едно голямо поле, пишеш като в имейл.',
    blocks: [{ type: 'text', html: '' }],
  },
  {
    id: 'news',
    name: 'Новина от фермата',
    description: 'Заглавие, снимка и текст — за новини и истории.',
    blocks: [
      {
        type: 'text',
        html: '<h2>Заглавие на новината</h2><p>Разкажи накратко какво ново се случва във фермата…</p>',
      },
      { type: 'image', image: '', alt: '', caption: '', href: '' },
      { type: 'text', html: '<p>Продължи разказа тук.</p>' },
    ],
  },
  {
    id: 'promo',
    name: 'Промоция',
    description: 'Голяма снимка, оферта и бутон към магазина.',
    blocks: [
      { type: 'hero', image: '', alt: '', href: '' },
      {
        type: 'text',
        html: '<h2>Специална оферта</h2><p>Опиши промоцията — какво, на каква цена и докога важи.</p>',
      },
      { type: 'button', label: 'Виж в магазина', href: '' },
    ],
  },
];
