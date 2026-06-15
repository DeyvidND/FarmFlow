import { PublicCacheService } from './public-cache.service';

/** Minimal Redis stub — returns null (cache miss) so resolveTenant always hits DB. */
function makeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
}

/** Build a DB stub whose .select().from().where().limit() returns the given rows. */
function makeDb(rows: unknown[]) {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  } as never;
}

const BASE_ROW = {
  id: 'tid-1',
  name: 'Ferma Test',
  slug: 'ferma-test',
  phone: null,
  email: null,
  deliveryEnabled: false,
  multiFarmer: false,
  multiSubcat: false,
  articlesEnabled: false,
  reviewsEnabled: false,
  availabilitySectionEnabled: false,
  availabilityTitle: null,
  productOfWeekEnabled: false,
  productOfWeekMode: 'off',
  productOfWeekId: null,
  productOfWeekNote: null,
  productOfWeekPlacement: 'section',
  stripeAccountId: null,
  settings: null,
};

describe('PublicCacheService.resolveTenant — copy/faq projection', () => {
  it('derives cleaned copy + faq from settings', async () => {
    const row = {
      ...BASE_ROW,
      settings: {
        siteTheme: 'pazar',
        copy: { 'home.hero.title': ' Hi ', bogus: 'x' },
        faq: [{ q: 'Q', a: 'A' }, { q: '', a: '' }],
      },
    };
    const svc = new PublicCacheService(makeRedis() as never);
    const meta = await svc.resolveTenant(makeDb([row]), 'ferma-test');

    // Only known pazar slot key kept; trimmed; bogus key dropped.
    expect(meta.copy).toEqual({ 'home.hero.title': 'Hi' });
    // Empty row dropped.
    expect(meta.faq).toEqual([{ q: 'Q', a: 'A' }]);
  });

  it('returns empty copy + faq when settings is null', async () => {
    const svc = new PublicCacheService(makeRedis() as never);
    const meta = await svc.resolveTenant(makeDb([{ ...BASE_ROW, settings: null }]), 'ferma-test');
    expect(meta.copy).toEqual({});
    expect(meta.faq).toEqual([]);
  });
});
