import { stripTags } from './reviews.service';

describe('stripTags (review plain-text hardening)', () => {
  it('removes script tags and their angle brackets', () => {
    expect(stripTags('hi <script>alert(1)</script> there')).toBe('hi alert(1) there');
  });

  it('removes an img onerror payload, leaving inert text', () => {
    const out = stripTags('<img src=x onerror="alert(1)">nice');
    expect(out).toBe('nice');
    expect(out).not.toMatch(/</);
  });

  it('keeps plain prose and inner line breaks intact', () => {
    expect(stripTags('  Great farm.\nFresh veg.  ')).toBe('Great farm.\nFresh veg.');
  });

  it('keeps a lone < that is not part of a tag (no closing >)', () => {
    expect(stripTags('price 5 < 10 lv')).toBe('price 5 < 10 lv');
  });

  it('handles null/undefined as empty string', () => {
    expect(stripTags(null)).toBe('');
    expect(stripTags(undefined)).toBe('');
  });
});
