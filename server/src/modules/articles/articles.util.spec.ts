import { slugify, sanitizeArticleHtml } from './articles.util';

describe('slugify', () => {
  it('transliterates Bulgarian Cyrillic to a Latin slug', () => {
    expect(slugify('Ябълки')).toBe('yabalki');
    expect(slugify('Череши')).toBe('chereshi');
    expect(slugify('Домашно сладко малина')).toBe('domashno-sladko-malina');
  });

  it('lowercases, trims and collapses separators', () => {
    expect(slugify('  Hello   World!! ')).toBe('hello-world');
  });

  it('returns an empty string when nothing is transliterable (callers add their own fallback)', () => {
    // Regression: this used to return the hardcoded 'article', which made
    // every module's own fallback (e.g. products' 'produkt') dead code.
    expect(slugify('????')).toBe('');
    expect(slugify('   ')).toBe('');
    expect(slugify('')).toBe('');
    expect(slugify('!@#$%')).toBe('');
  });
});

describe('sanitizeArticleHtml', () => {
  it('keeps allowed formatting tags', () => {
    const html = '<h2>Заглавие</h2><p><strong>bold</strong> <em>i</em> <u>u</u> <s>s</s></p><ul><li>a</li></ul>';
    expect(sanitizeArticleHtml(html)).toBe(html);
  });

  it('strips script tags and their content', () => {
    expect(sanitizeArticleHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });

  it('strips event handlers', () => {
    expect(sanitizeArticleHtml('<p onclick="evil()">hi</p>')).toBe('<p>hi</p>');
  });

  it('drops javascript: and data: links (no unsafe href survives)', () => {
    const js = sanitizeArticleHtml('<a href="javascript:alert(1)">x</a>');
    expect(js).not.toContain('javascript:');
    expect(js).not.toContain('href');
    const data = sanitizeArticleHtml('<a href="data:text/html,x">x</a>');
    expect(data).not.toContain('data:');
    expect(data).not.toContain('href');
  });

  it('keeps http/https/mailto links and forces rel+target', () => {
    const out = sanitizeArticleHtml('<a href="https://example.com">x</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('keeps https images, drops data: images', () => {
    expect(sanitizeArticleHtml('<img src="https://cdn.x/y.jpg" alt="a">')).toContain('src="https://cdn.x/y.jpg"');
    expect(sanitizeArticleHtml('<img src="data:image/png;base64,AAAA">')).toBe('');
  });

  it('drops images whose src is not absolute https (relative / http)', () => {
    expect(sanitizeArticleHtml('<img src="x">')).toBe('');
    expect(sanitizeArticleHtml('<img src="/local.jpg">')).toBe('');
    expect(sanitizeArticleHtml('<img src="http://cdn.x/y.jpg">')).toBe('');
  });

  it('collapses empty editor output to an empty string', () => {
    expect(sanitizeArticleHtml('<p><br></p>')).toBe('');
    expect(sanitizeArticleHtml('<p></p>')).toBe('');
    expect(sanitizeArticleHtml('<p>   </p>')).toBe('');
    expect(sanitizeArticleHtml('<h2></h2><p><br></p>')).toBe('');
  });

  it('strips iframe and video', () => {
    expect(sanitizeArticleHtml('<iframe src="https://x"></iframe>')).toBe('');
    expect(sanitizeArticleHtml('<video src="https://x"></video>')).toBe('');
  });

  it('keeps allowed inline styles, drops others', () => {
    const out = sanitizeArticleHtml('<p style="text-align:center;color:#ff0000;position:fixed">x</p>');
    expect(out).toContain('text-align:center');
    expect(out).toContain('color:#ff0000');
    expect(out).not.toContain('position');
  });

  it('returns empty string for nullish/empty', () => {
    expect(sanitizeArticleHtml('')).toBe('');
    expect(sanitizeArticleHtml(null as unknown as string)).toBe('');
  });
});
