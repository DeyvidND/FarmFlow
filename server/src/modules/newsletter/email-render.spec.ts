import { renderEmail, type RenderOpts } from './email-render';
import type { NewsletterBlock } from '@farmflow/types';

const opts: RenderOpts = {
  subject: 'Новини',
  brand: { logoUrl: 'https://cdn.x/logo.png', themeColor: '#2d6a4f', farmName: 'Ферма Х' },
  unsubscribeUrl: 'https://api.x/unsubscribe?token=abc',
};

describe('renderEmail', () => {
  it('renders each block type and always includes the unsubscribe footer', () => {
    const blocks: NewsletterBlock[] = [
      { type: 'hero', image: 'https://cdn.x/h.jpg', alt: 'hero' },
      { type: 'heading', text: 'Здравей', level: 1 },
      { type: 'text', html: '<p>Текст</p>' },
      { type: 'button', label: 'Виж', href: 'https://shop.x' },
      { type: 'divider' },
    ];
    const html = renderEmail(blocks, opts);
    expect(html).toContain('https://cdn.x/h.jpg');
    expect(html).toContain('Здравей');
    expect(html).toContain('Текст');
    expect(html).toContain('https://shop.x');
    expect(html).toContain('https://api.x/unsubscribe?token=abc');
    expect(html).toContain('Отпиши се');
  });

  it('produces no <script> and strips disallowed tags in text blocks', () => {
    const html = renderEmail([{ type: 'text', html: '<p>ok</p><script>bad()</script>' }], opts);
    expect(html).not.toContain('<script>');
    expect(html).toContain('ok');
  });

  it('applies the brand theme colour to buttons', () => {
    const html = renderEmail([{ type: 'button', label: 'X', href: 'https://x' }], opts);
    expect(html).toContain('#2d6a4f');
  });

  it('uses farm-name text header when no logo', () => {
    const html = renderEmail([], { ...opts, brand: { ...opts.brand, logoUrl: undefined } });
    expect(html).toContain('Ферма Х');
  });

  it('drops a non-https image', () => {
    const html = renderEmail([{ type: 'image', image: 'http://x/a.png', alt: 'a' }], opts);
    expect(html).not.toContain('http://x/a.png');
  });
});
