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

  it('neutralizes a javascript: button href to "#"', () => {
    const html = renderEmail([{ type: 'button', label: 'X', href: 'javascript:alert(1)' }], opts);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
  });

  it('drops the link wrapper around an image when its href uses an unsafe scheme', () => {
    const html = renderEmail(
      [{ type: 'image', image: 'https://cdn.x/a.png', alt: 'a', href: 'javascript:alert(1)' }],
      opts,
    );
    expect(html).not.toContain('javascript:');
    // image still rendered, just not wrapped in an <a>
    expect(html).toContain('https://cdn.x/a.png');
    expect(html).not.toMatch(/<a [^>]*href="javascript/i);
  });

  it('keeps a mailto: link on a button', () => {
    const html = renderEmail([{ type: 'button', label: 'Пиши', href: 'mailto:a@b.bg' }], opts);
    expect(html).toContain('mailto:a@b.bg');
  });

  it('uses farm-name text header when no logo', () => {
    const html = renderEmail([], { ...opts, brand: { ...opts.brand, logoUrl: undefined } });
    expect(html).toContain('Ферма Х');
  });

  it('drops a non-https image', () => {
    const html = renderEmail([{ type: 'image', image: 'http://x/a.png', alt: 'a' }], opts);
    expect(html).not.toContain('http://x/a.png');
  });

  it('clamps inline images inside a text block so they cannot overflow the 600px column', () => {
    const html = renderEmail(
      [{ type: 'text', html: '<p>Виж <img src="https://cdn.x/inline.jpg" alt="x"></p>' }],
      opts,
    );
    expect(html).toContain('https://cdn.x/inline.jpg');
    // the rendered <img> must carry a fit-to-container style
    const tag = html.match(/<img[^>]*cdn\.x\/inline\.jpg[^>]*>/i)?.[0] ?? '';
    expect(tag).toMatch(/max-width:\s*100%/);
    expect(tag).toMatch(/height:\s*auto/);
  });

  it('clamps inline images inside column text too', () => {
    const html = renderEmail(
      [
        {
          type: 'columns',
          left: { kind: 'text', html: '<img src="https://cdn.x/c.jpg" alt="">' },
          right: { kind: 'text', html: '<p>ok</p>' },
        },
      ],
      opts,
    );
    const tag = html.match(/<img[^>]*cdn\.x\/c\.jpg[^>]*>/i)?.[0] ?? '';
    expect(tag).toMatch(/max-width:\s*100%/);
  });
});
