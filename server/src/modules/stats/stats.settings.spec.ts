import { readInfoCommissionBps, MAX_COMMISSION_BPS } from './stats.settings';

describe('readInfoCommissionBps', () => {
  it('чете запазената стойност', () => {
    expect(readInfoCommissionBps({ stats: { infoCommissionBps: 1250 } })).toBe(1250);
  });

  it('липсваща/повредена настройка дава 0, не NaN', () => {
    expect(readInfoCommissionBps(null)).toBe(0);
    expect(readInfoCommissionBps({})).toBe(0);
    expect(readInfoCommissionBps({ stats: {} })).toBe(0);
    expect(readInfoCommissionBps({ stats: { infoCommissionBps: 'десет' } })).toBe(0);
    expect(readInfoCommissionBps('не е обект')).toBe(0);
  });

  it('отрицателна стойност се приравнява на 0, а прекомерна се реже на тавана', () => {
    expect(readInfoCommissionBps({ stats: { infoCommissionBps: -500 } })).toBe(0);
    expect(readInfoCommissionBps({ stats: { infoCommissionBps: 99999 } })).toBe(MAX_COMMISSION_BPS);
  });

  it('дробна стойност се закръгля до цяла базисна точка', () => {
    expect(readInfoCommissionBps({ stats: { infoCommissionBps: 1000.6 } })).toBe(1001);
  });
});
