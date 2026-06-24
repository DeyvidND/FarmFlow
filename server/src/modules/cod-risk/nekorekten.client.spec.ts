import { NekorektenClient } from './nekorekten.client';

const cfg = (key: string) => ({ get: () => key }) as never;

describe('NekorektenClient (no key)', () => {
  it('checkPhone returns unconfigured + empty, never throws', async () => {
    const c = new NekorektenClient(cfg(''));
    const out = await c.checkPhone('+359888123456');
    expect(out).toEqual({ configured: false, found: false, count: 0, reports: [] });
  });
  it('reportPhone throws a clear error when unconfigured', async () => {
    const c = new NekorektenClient(cfg(''));
    await expect(c.reportPhone({ phone: '+359888123456', text: 'x' })).rejects.toThrow('nekorekten');
  });
});
