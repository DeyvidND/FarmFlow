import { describe, it, expect } from 'vitest';
import { stopIsLocated, initialEditTab, addressPayload } from './edit-address';

describe('stopIsLocated', () => {
  it('true only when both coords present', () => {
    expect(stopIsLocated({ lat: 43.2, lng: 27.9 })).toBe(true);
    expect(stopIsLocated({ lat: 43.2, lng: null })).toBe(false);
    expect(stopIsLocated({ lat: null, lng: 27.9 })).toBe(false);
    expect(stopIsLocated({ lat: null, lng: null })).toBe(false);
  });
});

describe('initialEditTab', () => {
  it('map when the stop already has a pin', () => {
    expect(initialEditTab({ lat: 43.2, lng: 27.9 })).toBe('map');
  });
  it('address when the stop has no pin', () => {
    expect(initialEditTab({ lat: null, lng: null })).toBe('address');
  });
});

describe('addressPayload', () => {
  it('trims the address and omits coords when no pin', () => {
    expect(addressPayload('  ул. Иван Вазов 12  ', null)).toEqual({
      address: 'ул. Иван Вазов 12',
    });
  });
  it('includes exact coords when a suggestion was picked', () => {
    expect(addressPayload('Варна Център', { lat: 43.2, lng: 27.9 })).toEqual({
      address: 'Варна Център',
      lat: 43.2,
      lng: 27.9,
    });
  });
});
