import { farmDefaultSettings, farmerSellerReadiness } from './platform.helpers';

describe('farmerSellerReadiness', () => {
  const fullLegal = { name: 'ЕТ Димка', eik: '203912345', address: 'Варна, ул. Х 1' };

  it('ready = legal identity complete AND own carrier connected', () => {
    const r = farmerSellerReadiness(fullLegal, true);
    expect(r).toEqual({ ready: true, hasLegalIdentity: true, hasOwnCarrier: true, missing: [] });
  });

  it('accepts рег. № instead of ЕИК (физическо лице / земеделски производител)', () => {
    const r = farmerSellerReadiness({ name: 'Димка Иванова', regNo: '123456', address: 'Варна' }, true);
    expect(r.hasLegalIdentity).toBe(true);
    expect(r.ready).toBe(true);
  });

  it('not ready when the carrier is not connected — flags the missing account', () => {
    const r = farmerSellerReadiness(fullLegal, false);
    expect(r).toMatchObject({ ready: false, hasLegalIdentity: true, hasOwnCarrier: false });
    expect(r.missing).toEqual(['свой куриерски акаунт']);
  });

  it('lists every missing legal field when legal is null', () => {
    const r = farmerSellerReadiness(null, false);
    expect(r.ready).toBe(false);
    expect(r.hasLegalIdentity).toBe(false);
    expect(r.missing).toEqual(['юридическо име', 'ЕИК/рег. номер', 'адрес на продавача', 'свой куриерски акаунт']);
  });

  it('treats whitespace-only fields as missing', () => {
    const r = farmerSellerReadiness({ name: '  ', eik: ' ', address: '' }, true);
    expect(r.hasLegalIdentity).toBe(false);
    expect(r.missing).toEqual(['юридическо име', 'ЕИК/рег. номер', 'адрес на продавача']);
  });
});

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
