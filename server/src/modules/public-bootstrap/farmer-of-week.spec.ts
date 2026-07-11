import { resolveFarmerOfWeek } from './farmer-of-week';

describe('resolveFarmerOfWeek', () => {
  const farmers = [{ id: 'a' }, { id: 'b' }];
  it('returns null when config is missing', () => {
    expect(resolveFarmerOfWeek(null, farmers)).toBeNull();
    expect(resolveFarmerOfWeek({}, farmers)).toBeNull();
  });
  it('returns null when the pointed farmer is not in the public list', () => {
    expect(resolveFarmerOfWeek({ farmerId: 'zzz' }, farmers)).toBeNull();
  });
  it('resolves a valid pointer with its note', () => {
    expect(resolveFarmerOfWeek({ farmerId: 'b', note: 'Пчелар' }, farmers)).toEqual({
      id: 'b',
      note: 'Пчелар',
    });
  });
  it('defaults note to null', () => {
    expect(resolveFarmerOfWeek({ farmerId: 'a' }, farmers)).toEqual({ id: 'a', note: null });
  });
});
