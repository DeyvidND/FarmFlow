import { BadRequestException } from '@nestjs/common';
import { requireLegal } from './legal.util';

describe('requireLegal', () => {
  it('returns the identity when name is present', () => {
    const l = { kind: 'sole_trader' as const, name: 'ЕТ Васил', eik: '203912345' };
    expect(requireLegal(l, 'фермер')).toBe(l);
  });
  it('throws when null', () => {
    expect(() => requireLegal(null, 'фермер')).toThrow(BadRequestException);
  });
  it('throws when name is blank', () => {
    expect(() => requireLegal({ name: '  ' }, 'оператор')).toThrow(/оператор/);
  });
});
