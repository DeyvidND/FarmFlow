import { deriveSenderFromFarm } from './econt.sender';

describe('deriveSenderFromFarm', () => {
  it('prefers the carrier profile name/phone', () => {
    const out = deriveSenderFromFarm('Ферма Х', { phone: '0700', address: 'ул. 1' },
      [{ name: 'Регистрирано Име', phone: '0888111', clientNumber: '5' }]);
    expect(out).toEqual({ name: 'Регистрирано Име', phone: '0888111', mode: 'office' });
  });

  it('falls back to farm name + contact phone when no profile', () => {
    const out = deriveSenderFromFarm('Ферма Х', { phone: '0700', address: 'ул. 1' }, []);
    expect(out).toEqual({ name: 'Ферма Х', phone: '0700', mode: 'office' });
  });

  it('falls back to farm name + empty phone when nothing available', () => {
    const out = deriveSenderFromFarm('Ферма Х', null, []);
    expect(out).toEqual({ name: 'Ферма Х', phone: '', mode: 'office' });
  });

  it('ignores a blank profile name/phone and uses the fallbacks', () => {
    const out = deriveSenderFromFarm('Ферма Х', { phone: '0700' },
      [{ name: '  ', phone: '', clientNumber: null }]);
    expect(out).toEqual({ name: 'Ферма Х', phone: '0700', mode: 'office' });
  });
});
