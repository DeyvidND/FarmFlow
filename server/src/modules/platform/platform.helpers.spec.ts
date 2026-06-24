import { farmDefaultSettings } from './platform.helpers';

describe('farmDefaultSettings', () => {
  it('returns the sellable-by-default farm settings (pickup + cod + card on, econt off)', () => {
    expect(farmDefaultSettings()).toEqual({
      delivery: {
        methods: {
          pickup: { enabled: true },
          ownSlots: { enabled: false },
          econtOffice: { enabled: false },
          econtAddress: { enabled: false },
        },
        cod: { enabled: true },
        card: { enabled: true },
        econt: { mode: 'off' },
      },
    });
  });
  it('adds the brand theme colour when provided', () => {
    expect(farmDefaultSettings('#3a7d2c').brand).toEqual({ themeColor: '#3a7d2c' });
  });
});
