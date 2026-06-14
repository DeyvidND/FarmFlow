import { ForbiddenException } from '@nestjs/common';
import { effectiveFarmerId } from './farmer-scope.util';

describe('effectiveFarmerId', () => {
  it('forces a producer to their own token id, ignoring any query override', () => {
    expect(effectiveFarmerId('farmer', 'farmer-1', 'farmer-9')).toBe('farmer-1');
    expect(effectiveFarmerId('farmer', 'farmer-1', undefined)).toBe('farmer-1');
  });

  it('throws when a farmer token has no farmerId (malformed)', () => {
    expect(() => effectiveFarmerId('farmer', undefined, undefined)).toThrow(ForbiddenException);
  });

  it('lets an owner pick a producer or see the whole tenant', () => {
    expect(effectiveFarmerId('admin', undefined, 'farmer-3')).toBe('farmer-3');
    expect(effectiveFarmerId('admin', undefined, undefined)).toBeNull();
  });
});
