import { slugify, sanitizeArticleHtml, sanitizeInlineHtml, stripHtml } from './articles.util';

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

describe('stripHtml', () => {
  it('drops tags and collapses whitespace', () => {
    expect(stripHtml('Ягоди <strong>узряха</strong>')).toBe('Ягоди узряха');
    expect(stripHtml('<p>a</p>\n<p>b</p>')).toBe('a b');
  });
  it('returns empty for nullish', () => {
    expect(stripHtml('')).toBe('');
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
  });
});

describe('sanitizeInlineHtml (title / excerpt — text marks only)', () => {
  it('keeps bold/italic/underline/strike', () => {
    expect(sanitizeInlineHtml('<strong>a</strong> <em>b</em> <u>c</u> <s>d</s>')).toBe(
      '<strong>a</strong> <em>b</em> <u>c</u> <s>d</s>',
    );
  });

  it('strips blocks, headings, links, images, colour and alignment to plain text', () => {
    expect(sanitizeInlineHtml('<h2>Big</h2>')).toBe('Big');
    expect(sanitizeInlineHtml('<a href="https://x">l</a>')).toBe('l');
    expect(sanitizeInlineHtml('<img src="https://x/y.jpg">')).toBe('');
    expect(sanitizeInlineHtml('<span style="color:#f00">c</span>')).toBe('c');
    expect(sanitizeInlineHtml('<p style="text-align:center">c</p>')).toBe('c');
    expect(sanitizeInlineHtml('<ul><li>a</li></ul>')).toBe('a');
  });

  it('strips scripts and event handlers', () => {
    expect(sanitizeInlineHtml('hi<script>alert(1)</script>')).toBe('hi');
    expect(sanitizeInlineHtml('<b onclick="evil()">x</b>')).toBe('<b>x</b>');
  });

  it('flattens paragraph + line breaks to spaces (no word-join)', () => {
    expect(sanitizeInlineHtml('<p>Едно</p><p>две</p>')).toBe('Едно две');
    expect(sanitizeInlineHtml('a<br>b')).toBe('a b');
  });

  it('collapses empty editor output to an empty string', () => {
    expect(sanitizeInlineHtml('<p><br></p>')).toBe('');
    expect(sanitizeInlineHtml('   ')).toBe('');
    expect(sanitizeInlineHtml('')).toBe('');
    expect(sanitizeInlineHtml(null)).toBe('');
  });
});
