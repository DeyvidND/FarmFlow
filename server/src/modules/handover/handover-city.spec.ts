import { cityFromAddress } from './handover-city';

describe('cityFromAddress', () => {
  it('extracts гр.', () => {
    expect(cityFromAddress('гр. Варна, ул. Приморска 12')).toEqual({ prefix: 'гр.', name: 'Варна' });
  });
  it('extracts a two-word settlement', () => {
    expect(cityFromAddress('гр. Велико Търново, пл. Майка България 1')).toEqual({ prefix: 'гр.', name: 'Велико Търново' });
  });
  it('extracts село', () => {
    expect(cityFromAddress('с. Кранево, общ. Балчик')).toEqual({ prefix: 'с.', name: 'Кранево' });
  });
  it('returns null when no settlement token', () => {
    expect(cityFromAddress('ул. Приморска 12')).toBeNull();
    expect(cityFromAddress('')).toBeNull();
    expect(cityFromAddress(null)).toBeNull();
  });
});
