import { assembleNewsletterBlocks, type DraftCopy, type DraftProduct } from './auto-draft.render';

const COPY: DraftCopy = { subject: 'Свежо тази седмица', intro: 'Здравейте!', blurbs: { Домати: 'Сладки и сочни' } };
const P = (over: Partial<DraftProduct> = {}): DraftProduct => ({ id: 'p1', name: 'Домати', priceStotinki: 250, imageUrl: null, ...over });

describe('assembleNewsletterBlocks', () => {
  it('starts with a heading from the subject and an intro text block', () => {
    const b = assembleNewsletterBlocks(COPY, [P()], 'https://shop.bg');
    expect(b[0]).toEqual({ type: 'heading', text: 'Свежо тази седмица', level: 1 });
    expect(b[1]).toEqual({ type: 'text', html: '<p>Здравейте!</p>' });
  });

  it('renders an image block (linked to the shop) when the product has an image', () => {
    const b = assembleNewsletterBlocks(COPY, [P({ imageUrl: 'https://cdn/x.jpg' })], 'https://shop.bg');
    expect(b).toContainEqual({ type: 'image', image: 'https://cdn/x.jpg', alt: 'Домати', href: 'https://shop.bg' });
  });

  it('omits the image block when there is no image, keeping the product text', () => {
    const b = assembleNewsletterBlocks(COPY, [P({ imageUrl: null })], 'https://shop.bg');
    expect(b.some((x) => x.type === 'image')).toBe(false);
    expect(b).toContainEqual({ type: 'text', html: '<p><b>Домати</b> — 2,50 €<br>Сладки и сочни</p>' });
  });

  it('shows just name + price when the blurb is missing', () => {
    const b = assembleNewsletterBlocks({ ...COPY, blurbs: {} }, [P()], 'https://shop.bg');
    expect(b).toContainEqual({ type: 'text', html: '<p><b>Домати</b> — 2,50 €</p>' });
  });

  it('puts a divider between products and a final shop button', () => {
    const b = assembleNewsletterBlocks(COPY, [P({ id: 'a', name: 'Домати' }), P({ id: 'b', name: 'Мед', priceStotinki: 1200 })], 'https://shop.bg');
    expect(b.some((x) => x.type === 'divider')).toBe(true);
    expect(b[b.length - 1]).toEqual({ type: 'button', label: 'Виж всички продукти', href: 'https://shop.bg' });
  });

  it('omits hrefs and the button when no shopUrl is given', () => {
    const b = assembleNewsletterBlocks(COPY, [P({ imageUrl: 'https://cdn/x.jpg' })]);
    expect(b).toContainEqual({ type: 'image', image: 'https://cdn/x.jpg', alt: 'Домати' });
    expect(b.some((x) => x.type === 'button')).toBe(false);
  });

  it('escapes HTML in names and blurbs', () => {
    const b = assembleNewsletterBlocks({ subject: 's', intro: '', blurbs: { 'A & B': '<x>' } }, [P({ name: 'A & B' })]);
    const txt = b.find((x) => x.type === 'text' && x.html.includes('A &amp; B'));
    expect(txt).toBeTruthy();
    expect(JSON.stringify(b)).not.toContain('<x>');
  });
});
