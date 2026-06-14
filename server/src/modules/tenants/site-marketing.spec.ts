import { buildPublicMarketing, normalizeMarketing } from './site-marketing';

const ALL_NULL = {
  ga4: null,
  googleAds: null,
  googleAdsLabel: null,
  metaPixel: null,
  gtm: null,
  tiktok: null,
};

describe('buildPublicMarketing', () => {
  it('returns all-null for garbage input', () => {
    expect(buildPublicMarketing(null)).toEqual(ALL_NULL);
    expect(buildPublicMarketing('nope')).toEqual(ALL_NULL);
    expect(buildPublicMarketing([])).toEqual(ALL_NULL);
    expect(buildPublicMarketing({})).toEqual(ALL_NULL);
  });

  it('keeps well-formed ids per vendor', () => {
    const out = buildPublicMarketing({
      ga4: 'G-ABC123XYZ',
      googleAds: 'AW-12345678',
      googleAdsLabel: 'aB_3-xZ99',
      metaPixel: '1234567890123',
      gtm: 'GTM-AB12CD',
      tiktok: 'C9ABCDEFGH1234',
    });
    expect(out).toEqual({
      ga4: 'G-ABC123XYZ',
      googleAds: 'AW-12345678',
      googleAdsLabel: 'aB_3-xZ99',
      metaPixel: '1234567890123',
      gtm: 'GTM-AB12CD',
      tiktok: 'C9ABCDEFGH1234',
    });
  });

  it('drops malformed ids to null (typo can never reach the storefront head)', () => {
    const out = buildPublicMarketing({
      ga4: 'UA-000000', // old Universal Analytics, not GA4
      googleAds: 'AW-abc', // letters where digits required
      metaPixel: '123', // too short
      gtm: 'container', // missing GTM- prefix
      tiktok: '<script>', // breakout attempt
    });
    expect(out).toEqual(ALL_NULL);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(buildPublicMarketing({ ga4: '  G-ABC123  ' }).ga4).toBe('G-ABC123');
  });

  it('ignores non-string values', () => {
    expect(buildPublicMarketing({ ga4: 12345, metaPixel: { x: 1 } })).toEqual(ALL_NULL);
  });
});

describe('normalizeMarketing', () => {
  it('keeps only valid non-empty ids and trims', () => {
    expect(
      normalizeMarketing({ ga4: ' G-ABC123 ', googleAds: '', metaPixel: 'bad' }),
    ).toEqual({ ga4: 'G-ABC123' });
  });

  it('returns {} when everything is empty or invalid (clears the block)', () => {
    expect(normalizeMarketing({ ga4: '', metaPixel: '12' })).toEqual({});
  });

  it('drops a lone Ads conversion label with no Ads id', () => {
    expect(normalizeMarketing({ googleAdsLabel: 'abc123' })).toEqual({});
  });

  it('keeps the Ads label when the Ads id is present', () => {
    expect(normalizeMarketing({ googleAds: 'AW-12345678', googleAdsLabel: 'abc123' })).toEqual({
      googleAds: 'AW-12345678',
      googleAdsLabel: 'abc123',
    });
  });
});
