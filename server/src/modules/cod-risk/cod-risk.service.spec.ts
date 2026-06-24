import { Test } from '@nestjs/testing';
import { CodRiskService } from './cod-risk.service';
import { NekorektenClient } from './nekorekten.client';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';

// Chainable mock: select→from→where→orderBy return `this`; the terminal `.limit()`
// resolves. check() runs two queries, both ending in .limit → two mockResolvedValueOnce.
function makeDb() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(),
  };
}

describe('CodRiskService.check', () => {
  let svc: CodRiskService;
  let db: ReturnType<typeof makeDb>;
  let nk: { configured: boolean; checkPhone: jest.Mock };
  let cache: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    db = makeDb();
    nk = {
      configured: true,
      checkPhone: jest.fn().mockResolvedValue({ configured: true, found: false, count: 0, reports: [] }),
    };
    cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
    const mod = await Test.createTestingModule({
      providers: [
        CodRiskService,
        { provide: DB_TOKEN, useValue: db },
        { provide: NekorektenClient, useValue: nk },
        { provide: PublicCacheService, useValue: cache },
      ],
    }).compile();
    svc = mod.get(CodRiskService);
  });

  it('returns empty/ok for an unparseable phone (no DB, no API)', async () => {
    const r = await svc.check('abc');
    expect(r.phone).toBeNull();
    expect(r.verdict).toBe('ok');
    expect(nk.checkPhone).not.toHaveBeenCalled();
  });

  it('short-circuits nekorekten when our strikes already flag high', async () => {
    db.limit
      .mockResolvedValueOnce([{ strikes: 2 }])
      .mockResolvedValueOnce([{ createdAt: new Date('2026-06-01T00:00:00.000Z'), phone: '+359888111222', type: 'returned' }]);
    const r = await svc.check('0888111222');
    expect(nk.checkPhone).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(r.verdict).toBe('high');
    expect(r.cached).toBe(true);
    expect(r.reports.every((x) => x.source === 'internal')).toBe(true);
    expect(r.reports).toHaveLength(1);
  });

  it('serves nekorekten from cache without calling the API', async () => {
    db.limit.mockResolvedValueOnce([{ strikes: 0 }]).mockResolvedValueOnce([]);
    cache.get.mockResolvedValueOnce({
      configured: true,
      found: true,
      count: 1,
      reports: [{ date: '2026-05-01', phone: '+359888111222', description: 'лош' }],
    });
    const r = await svc.check('0888111222');
    expect(nk.checkPhone).not.toHaveBeenCalled();
    expect(r.cached).toBe(true);
    expect(r.nekorektenCount).toBe(1);
    expect(r.reports).toEqual([{ source: 'nekorekten', date: '2026-05-01', phone: '+359888111222', description: 'лош' }]);
  });

  it('calls + caches nekorekten on a cache miss', async () => {
    db.limit.mockResolvedValueOnce([{ strikes: 0 }]).mockResolvedValueOnce([]);
    cache.get.mockResolvedValueOnce(null);
    nk.checkPhone.mockResolvedValueOnce({
      configured: true,
      found: true,
      count: 1,
      reports: [{ date: '2026-05-02', phone: '+359888111222', description: 'x' }],
    });
    const r = await svc.check('0888111222');
    expect(nk.checkPhone).toHaveBeenCalledWith('+359888111222');
    expect(cache.set).toHaveBeenCalled();
    expect(r.cached).toBe(false);
    expect(r.verdict).toBe('caution');
  });

  it('falls through to a live call when Redis is down (cache.get rejects)', async () => {
    db.limit.mockResolvedValueOnce([{ strikes: 0 }]).mockResolvedValueOnce([]);
    cache.get.mockRejectedValueOnce(new Error('redis down'));
    nk.checkPhone.mockResolvedValueOnce({ configured: true, found: false, count: 0, reports: [] });
    const r = await svc.check('0888111222');
    expect(nk.checkPhone).toHaveBeenCalledWith('+359888111222');
    expect(r.verdict).toBe('ok');
  });

  it('does not cache an unconfigured nekorekten result', async () => {
    db.limit.mockResolvedValueOnce([{ strikes: 0 }]).mockResolvedValueOnce([]);
    cache.get.mockResolvedValueOnce(null);
    nk.checkPhone.mockResolvedValueOnce({ configured: false, found: false, count: 0, reports: [] });
    const r = await svc.check('0888111222');
    expect(cache.set).not.toHaveBeenCalled();
    expect(r.nekorektenConfigured).toBe(false);
    expect(r.reports).toEqual([]);
  });
});
