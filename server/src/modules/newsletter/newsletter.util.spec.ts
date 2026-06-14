import { sanitizeNewsletterHtml } from './newsletter.util';

describe('sanitizeNewsletterHtml', () => {
  it('keeps allowed rich text, strips scripts', () => {
    expect(sanitizeNewsletterHtml('<p>hi <strong>x</strong></p><script>alert(1)</script>')).toBe(
      '<p>hi <strong>x</strong></p>',
    );
  });

  it('drops non-https img', () => {
    expect(sanitizeNewsletterHtml('<img src="http://x/a.png">')).toBe('');
  });

  it('returns empty for blank editor output', () => {
    expect(sanitizeNewsletterHtml('<p><br></p>')).toBe('');
  });
});
