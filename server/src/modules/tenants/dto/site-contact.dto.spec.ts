import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';
import { SiteContactDto } from './site-contact.dto';

// Nested array errors (social[i].url) nest two levels deep — the constraint
// lives in children[].children[]. Recurse to any depth to detect them.
function hasConstraint(e: ValidationError): boolean {
  if (Object.keys(e.constraints ?? {}).length) return true;
  return (e.children ?? []).some(hasConstraint);
}

function errorsFor(obj: unknown): string[] {
  const dto = plainToInstance(SiteContactDto, obj);
  return validateSync(dto, { whitelist: true }).flatMap((e) =>
    hasConstraint(e) ? [e.property] : [],
  );
}

describe('SiteContactDto', () => {
  it('accepts a full valid payload', () => {
    expect(
      errorsFor({
        address: 'кв. Чайка, Варна',
        hours: 'Петък 11:00–18:00',
        tagline: 'Местни стопани на едно място.',
        social: [{ label: 'Facebook', url: 'https://facebook.com/ferma' }],
        mapLat: '43.21',
        mapLng: '27.91',
        themeColor: '#3F7D43',
      }),
    ).toEqual([]);
  });

  it('accepts empty strings (clearing) and an empty social list', () => {
    expect(
      errorsFor({ address: '', mapLat: '', mapLng: '', themeColor: '', social: [] }),
    ).toEqual([]);
  });

  it('rejects a non-url social link', () => {
    expect(errorsFor({ social: [{ url: 'not a url' }] })).toContain('social');
  });

  it('rejects more than 8 social links', () => {
    const social = Array.from({ length: 9 }, (_, i) => ({ url: `https://x.com/${i}` }));
    expect(errorsFor({ social })).toContain('social');
  });

  it('rejects a malformed theme color', () => {
    expect(errorsFor({ themeColor: 'red' })).toContain('themeColor');
  });

  it('accepts a social row with a known network and custom fields', () => {
    expect(
      errorsFor({
        social: [{ network: 'whatsapp', url: 'https://wa.me/359' }],
        custom: [{ label: 'WhatsApp', value: '+359 88 000 000' }, { value: 'само стойност' }],
      }),
    ).toEqual([]);
  });

  it('rejects an unknown social network', () => {
    expect(errorsFor({ social: [{ network: 'myspace', url: 'https://x.com/a' }] })).toContain('social');
  });

  it('rejects a custom field without a value and a too-long custom list', () => {
    expect(errorsFor({ custom: [{ label: 'no value' }] })).toContain('custom');
    const custom = Array.from({ length: 13 }, (_, i) => ({ value: `v${i}` }));
    expect(errorsFor({ custom })).toContain('custom');
  });
});
