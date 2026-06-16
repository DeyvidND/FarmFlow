import { buildPublicContact, normalizeSiteContact } from './site-contact';

describe('buildPublicContact', () => {
  it('returns all-null / empty for garbage input', () => {
    expect(buildPublicContact(null)).toEqual({
      address: null, hours: null, tagline: null, phone: null, email: null, social: [], custom: [], mapLat: null, mapLng: null,
    });
    expect(buildPublicContact('nope')).toEqual({
      address: null, hours: null, tagline: null, phone: null, email: null, social: [], custom: [], mapLat: null, mapLng: null,
    });
  });

  it('keeps non-empty fields and drops social rows without a url, capping at 8', () => {
    const social = Array.from({ length: 10 }, (_, i) => ({ label: `L${i}`, url: `https://x/${i}` }));
    social.push({ label: 'bad', url: '' } as never);
    const out = buildPublicContact({ address: ' кв. Чайка ', tagline: '', social });
    expect(out.address).toBe(' кв. Чайка ');
    expect(out.tagline).toBeNull();
    expect(out.social).toHaveLength(8);
    expect(out.social.every((s) => s.url)).toBe(true);
  });

  it('carries the social network key and drops custom rows without a value', () => {
    const out = buildPublicContact({
      social: [{ network: 'whatsapp', label: '', url: 'https://wa.me/359' }],
      custom: [
        { label: 'WhatsApp', value: '+359 88 000 000' },
        { label: 'празно', value: '' },
        { label: 'x', value: 'y' },
      ],
    });
    expect(out.social[0].network).toBe('whatsapp');
    expect(out.custom).toEqual([
      { label: 'WhatsApp', value: '+359 88 000 000' },
      { label: 'x', value: 'y' },
    ]);
  });

  it('caps custom rows at 12', () => {
    const out = buildPublicContact({
      custom: Array.from({ length: 14 }, (_, i) => ({ label: `L${i}`, value: `v${i}` })),
    });
    expect(out.custom).toHaveLength(12);
  });

  it('drops social rows with an active-content scheme but keeps tel/viber/http', () => {
    const out = buildPublicContact({
      social: [
        { network: 'x', label: 'evil', url: 'javascript:alert(1)' },
        { network: 'x', label: 'evil2', url: 'JavaScript:alert(1)' },
        { network: 'x', label: 'evil3', url: ' data:text/html,x' },
        { network: 'fb', label: 'ok', url: 'https://fb.com/x' },
        { network: 'viber', label: 'v', url: 'viber://chat?number=1' },
        { network: 'phone', label: 't', url: 'tel:+359' },
      ],
    });
    expect(out.social.map((s) => s.url)).toEqual([
      'https://fb.com/x',
      'viber://chat?number=1',
      'tel:+359',
    ]);
  });
});

describe('normalizeSiteContact', () => {
  it('trims, drops empty social rows, leaves themeColor undefined when absent', () => {
    const { contact, themeColor } = normalizeSiteContact({
      address: '  кв. Чайка  ',
      social: [{ label: ' FB ', url: ' https://fb.com/x ' }, { url: '' }],
    });
    expect(contact.address).toBe('кв. Чайка');
    expect(contact.social).toEqual([{ network: '', label: 'FB', url: 'https://fb.com/x' }]);
    expect(themeColor).toBeUndefined();
  });

  it('maps empty themeColor string to null (clear)', () => {
    expect(normalizeSiteContact({ themeColor: '' }).themeColor).toBeNull();
    expect(normalizeSiteContact({ themeColor: '#abcdef' }).themeColor).toBe('#abcdef');
  });

  it('strips social rows with a javascript:/data: scheme on write', () => {
    const { contact } = normalizeSiteContact({
      social: [
        { label: 'evil', url: 'javascript:alert(1)' },
        { label: 'ok', url: 'https://ig.com/x' },
      ],
    });
    expect(contact.social).toEqual([{ network: '', label: 'ok', url: 'https://ig.com/x' }]);
  });
});
