import { isEcontLabelUrl } from './econt-label-url';

describe('isEcontLabelUrl', () => {
  it('allows prod and demo Econt hosts over https', () => {
    expect(isEcontLabelUrl('https://ee.econt.com/services/label/123.pdf')).toBe(true);
    expect(isEcontLabelUrl('https://demo.econt.com/ee/services/label/9.pdf')).toBe(true);
    expect(isEcontLabelUrl('https://econt.com/x.pdf')).toBe(true);
  });

  it('rejects non-econt hosts', () => {
    expect(isEcontLabelUrl('https://evil.example.com/x.pdf')).toBe(false);
    expect(isEcontLabelUrl('https://ee.econt.com.evil.com/x.pdf')).toBe(false);
  });

  it('rejects non-https and garbage', () => {
    expect(isEcontLabelUrl('http://ee.econt.com/x.pdf')).toBe(false);
    expect(isEcontLabelUrl('file:///etc/passwd')).toBe(false);
    expect(isEcontLabelUrl('not a url')).toBe(false);
    expect(isEcontLabelUrl('')).toBe(false);
  });
});
