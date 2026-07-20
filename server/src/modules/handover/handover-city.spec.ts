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

  it('handles the no-space form (гр.Варна) — common in real addresses', () => {
    expect(cityFromAddress('гр.Варна, ул. Приморска 12')).toEqual({ prefix: 'гр.', name: 'Варна' });
    expect(cityFromAddress('с.Кранево')).toEqual({ prefix: 'с.', name: 'Кранево' });
  });

  it('handles the dotless full words', () => {
    expect(cityFromAddress('град Варна, ул. Приморска 12')).toEqual({ prefix: 'гр.', name: 'Варна' });
    expect(cityFromAddress('село Кранево, общ. Балчик')).toEqual({ prefix: 'с.', name: 'Кранево' });
  });

  it('does NOT mistake the preposition „с" for a village', () => {
    // The lone „с" only counts as a settlement when it carries its dot. Otherwise
    // „с ЕГН…" would confidently render „в с. ЕГН" on a legal document — worse than
    // dropping the clause.
    expect(cityFromAddress('Иван Петров, с ЕГН 1234567890')).toBeNull();
    expect(cityFromAddress('до сграда с Магазин Билла')).toBeNull();
  });
});
