import { describe, it, expect } from 'vitest';
import { isMajorRoadAddress } from './major-road';

describe('isMajorRoadAddress', () => {
  it('flags a boulevard', () => {
    expect(isMajorRoadAddress('бул. Христо Ботев 104, Варна')).toBe(true);
    expect(isMajorRoadAddress('булевард Сливница 12')).toBe(true);
  });
  it('flags шосе / магистрала', () => {
    expect(isMajorRoadAddress('Аспарухово шосе 5')).toBe(true);
    expect(isMajorRoadAddress('Магистрала Тракия, изход 3')).toBe(true);
  });
  it('flags a European route token', () => {
    expect(isMajorRoadAddress('E87, до бензиностанцията')).toBe(true);
    expect(isMajorRoadAddress('Е-85 km 12')).toBe(true);
  });
  it('does not flag a normal street', () => {
    expect(isMajorRoadAddress('ул. Иван Вазов 12, Варна')).toBe(false);
    expect(isMajorRoadAddress('с. Звездица, общ. Варна')).toBe(false);
  });
  it('handles null / empty', () => {
    expect(isMajorRoadAddress(null)).toBe(false);
    expect(isMajorRoadAddress('')).toBe(false);
  });
});
