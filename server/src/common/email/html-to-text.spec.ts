import { htmlToText } from './email.service';

describe('htmlToText (email text/plain fallback)', () => {
  it('strips tags and keeps the visible text', () => {
    const t = htmlToText('<h1>Заглавие</h1><p>Ред едно</p><p>Ред две</p>');
    expect(t).toContain('Заглавие');
    expect(t).toContain('Ред едно');
    expect(t).not.toContain('<');
  });

  it('turns block boundaries into newlines', () => {
    const t = htmlToText('<p>a</p><p>b</p>');
    expect(t).toBe('a\nb');
  });

  it('decodes common entities and drops style/script', () => {
    const t = htmlToText('<style>.x{}</style><p>Tom &amp; Jerry &lt;3</p><script>x()</script>');
    expect(t).toBe('Tom & Jerry <3');
  });

  it('collapses runs of blank lines', () => {
    const t = htmlToText('<div>a</div><br><br><br><div>b</div>');
    expect(t).not.toMatch(/\n{3,}/);
  });
});
