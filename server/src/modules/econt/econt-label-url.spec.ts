import { normalizeEcontLabelUrl } from './econt-label-url';

describe('normalizeEcontLabelUrl', () => {
  it('passes through prod and demo Econt hosts over https', () => {
    expect(normalizeEcontLabelUrl('https://ee.econt.com/services/label/123.pdf'))
      .toBe('https://ee.econt.com/services/label/123.pdf');
    expect(normalizeEcontLabelUrl('https://demo.econt.com/ee/services/label/9.pdf'))
      .toBe('https://demo.econt.com/ee/services/label/9.pdf');
    expect(normalizeEcontLabelUrl('https://econt.com/x.pdf')).toBe('https://econt.com/x.pdf');
  });

  it('upgrades http to https for Econt hosts (demo returns http label urls)', () => {
    expect(
      normalizeEcontLabelUrl(
        'http://demo.econt.com/ee/api_export.php?exportMethod=printLoading&loading_num=1&_key=abc',
      ),
    ).toBe('https://demo.econt.com/ee/api_export.php?exportMethod=printLoading&loading_num=1&_key=abc');
    expect(normalizeEcontLabelUrl('http://ee.econt.com/x.pdf')).toBe('https://ee.econt.com/x.pdf');
  });

  it('rejects non-econt hosts (creds must never leave Econt)', () => {
    expect(normalizeEcontLabelUrl('https://evil.example.com/x.pdf')).toBeNull();
    expect(normalizeEcontLabelUrl('https://ee.econt.com.evil.com/x.pdf')).toBeNull();
    expect(normalizeEcontLabelUrl('http://evil.example.com/x.pdf')).toBeNull();
  });

  it('rejects non-http(s) schemes and garbage', () => {
    expect(normalizeEcontLabelUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeEcontLabelUrl('ftp://ee.econt.com/x.pdf')).toBeNull();
    expect(normalizeEcontLabelUrl('not a url')).toBeNull();
    expect(normalizeEcontLabelUrl('')).toBeNull();
  });
});
