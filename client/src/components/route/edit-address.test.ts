import { describe, it, expect } from 'vitest';
import { mergedPayload } from './edit-address';

describe('mergedPayload', () => {
  it('address only (no pin) — trims and omits coords', () => {
    expect(mergedPayload('  ул. Иван Вазов 12  ', null)).toEqual({
      address: 'ул. Иван Вазов 12',
    });
  });

  it('address + pin — includes both', () => {
    expect(mergedPayload('Варна Център', { lat: 43.2, lng: 27.9 })).toEqual({
      address: 'Варна Център',
      lat: 43.2,
      lng: 27.9,
    });
  });

  it('pin only (empty address) — omits the address key entirely', () => {
    expect(mergedPayload('   ', { lat: 43.2, lng: 27.9 })).toEqual({
      lat: 43.2,
      lng: 27.9,
    });
  });
});
