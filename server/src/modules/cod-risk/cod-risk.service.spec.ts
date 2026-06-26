import { Test } from '@nestjs/testing';
import { CodRiskService } from './cod-risk.service';
import { NekorektenClient } from './nekorekten.client';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

// ---- DB mock helpers --------------------------------------------------------

/** A DB mock that covers two SELECT chains (risk row + events) and one INSERT
 *  chain (upsert). check() runs two queries ending in .limit(); the upsert ends
 *  in .onConflictDoUpdate. Exposed handles let tests assert on calls. */
function makeDb(opts: {
  riskRow?: Record<string, any> | null;
  events?: Record<string, any>[];
}) {
  const riskRowResult = opts.riskRow != null ? [opts.riskRow] : [];
  const eventsResult = opts.events ?? [];

  // Two SELECT .limit() calls in check(): first returns the risk row, second the events.
  const limitMock = jest.fn().mockResolvedValueOnce(riskRowResult).mockResolvedValueOnce(eventsResult);

  const insertOnConflict = jest.fn().mockResolvedValue([]);
  const insertValues = jest.fn().mockReturnValue({ onConflictDoUpdate: insertOnConflict });

  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: limitMock,
    insert: jest.fn().mockReturnValue({ values: insertValues }),
    // Exposed for assertions
    _insertValues: insertValues,
    _insertOnConflict: insertOnConflict,
  };
}

/** Minimal PublicCacheService mock — get returns null/0, set/del resolve. */
function makeCacheMock(getReturnValue: unknown = null) {
  return {
    get: jest.fn().mockResolvedValue(getReturnValue),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };
}

// ---- Shared helpers ---------------------------------------------------------

const CLEAN_PHONE = '0888111222';
const NORMALIZED = '+359888111222';
const TENANT_ID = 'tenant-1';

function freshRow(nkFound: boolean): Record<string, any> {
  return {
    strikes: 0,
    nkFound,
    nkCount: nkFound ? 1 : 0,
    nkReports: nkFound ? [{ date: '2026-05-01', phone: NORMALIZED, description: 'test' }] : [],
    // Very recent — well within any TTL
    nkCheckedAt: new Date(Date.now() - 1000),
  };
}

function staleRow(nkFound: boolean): Record<string, any> {
  const FLAGGED_TTL_MS = 90 * 24 * 3600 * 1000;
  const CLEAN_TTL_MS = 30 * 24 * 3600 * 1000;
  const ttl = nkFound ? FLAGGED_TTL_MS : CLEAN_TTL_MS;
  return {
    strikes: 0,
    nkFound,
    nkCount: nkFound ? 1 : 0,
    nkReports: nkFound ? [{ date: '2026-01-01', phone: NORMALIZED, description: 'old' }] : [],
    // Past the TTL
    nkCheckedAt: new Date(Date.now() - ttl - 5000),
  };
}

// ---- Tests: check() ---------------------------------------------------------

describe('CodRiskService.check — DB-backed adaptive TTL', () => {
  let svc: CodRiskService;
  let nkClient: { configured: boolean; checkPhone: jest.Mock };

  async function build(db: ReturnType<typeof makeDb>, nkOverride?: Partial<typeof nkClient>, cacheMock = makeCacheMock()) {
    nkClient = {
      configured: true,
      checkPhone: jest.fn().mockResolvedValue({ configured: true, found: false, count: 0, reports: [] }),
      ...nkOverride,
    };
    const mod = await Test.createTestingModule({
      providers: [
        CodRiskService,
        { provide: DB_TOKEN, useValue: db },
        { provide: NekorektenClient, useValue: nkClient },
        { provide: PublicCacheService, useValue: cacheMock },
      ],
    }).compile();
    svc = mod.get(CodRiskService);
    return db;
  }

  it('returns empty/ok for an unparseable phone (no DB, no API)', async () => {
    const db = makeDb({});
    await build(db);
    const r = await svc.check('abc');
    expect(r.phone).toBeNull();
    expect(r.verdict).toBe('ok');
    expect(nkClient.checkPhone).not.toHaveBeenCalled();
  });

  it('short-circuits nekorekten when our strikes already flag high', async () => {
    const db = makeDb({
      riskRow: { strikes: 2, nkFound: null, nkCount: null, nkReports: null, nkCheckedAt: null },
      events: [{ createdAt: new Date('2026-06-01'), phone: NORMALIZED, type: 'returned' }],
    });
    await build(db);
    const r = await svc.check(CLEAN_PHONE);
    expect(nkClient.checkPhone).not.toHaveBeenCalled();
    expect(r.verdict).toBe('high');
    expect(r.cached).toBe(true);
    expect(r.reports.every((x) => x.source === 'internal')).toBe(true);
    expect(r.reports).toHaveLength(1);
  });

  it('serves nekorekten from fresh DB row — no API call', async () => {
    const db = makeDb({ riskRow: freshRow(true), events: [] });
    await build(db);
    const r = await svc.check(CLEAN_PHONE);
    expect(nkClient.checkPhone).not.toHaveBeenCalled();
    expect(r.cached).toBe(true);
    expect(r.nekorektenCount).toBe(1);
    expect(r.verdict).toBe('caution');
  });

  it('calls API and upserts DB on stale clean row', async () => {
    const db = makeDb({ riskRow: staleRow(false), events: [] });
    await build(db);
    nkClient.checkPhone.mockResolvedValueOnce({ configured: true, found: true, count: 1, reports: [{ date: '2026-05-02', phone: NORMALIZED, description: 'x' }] });
    const r = await svc.check(CLEAN_PHONE);
    expect(nkClient.checkPhone).toHaveBeenCalledWith(NORMALIZED);
    expect(db._insertOnConflict).toHaveBeenCalled();
    expect(r.cached).toBe(false);
    expect(r.verdict).toBe('caution');
  });

  it('calls API and upserts DB on stale flagged row', async () => {
    const db = makeDb({ riskRow: staleRow(true), events: [] });
    await build(db);
    nkClient.checkPhone.mockResolvedValueOnce({ configured: true, found: false, count: 0, reports: [] });
    const r = await svc.check(CLEAN_PHONE);
    expect(nkClient.checkPhone).toHaveBeenCalledWith(NORMALIZED);
    expect(db._insertOnConflict).toHaveBeenCalled();
    expect(r.cached).toBe(false);
  });

  it('calls API when nk_checked_at is null (never checked)', async () => {
    const db = makeDb({ riskRow: { strikes: 0, nkFound: null, nkCount: null, nkReports: null, nkCheckedAt: null }, events: [] });
    await build(db);
    const r = await svc.check(CLEAN_PHONE);
    expect(nkClient.checkPhone).toHaveBeenCalledWith(NORMALIZED);
    expect(r.cached).toBe(false);
  });

  it('forceRefresh bypasses a fresh DB row', async () => {
    const db = makeDb({ riskRow: freshRow(false), events: [] });
    await build(db);
    nkClient.checkPhone.mockResolvedValueOnce({ configured: true, found: false, count: 0, reports: [] });
    const r = await svc.check(CLEAN_PHONE, { forceRefresh: true });
    expect(nkClient.checkPhone).toHaveBeenCalledWith(NORMALIZED);
    expect(r.cached).toBe(false);
  });

  it('does not upsert when nekorekten is unconfigured', async () => {
    const db = makeDb({ riskRow: null, events: [] });
    await build(db, { configured: false, checkPhone: jest.fn().mockResolvedValue({ configured: false, found: false, count: 0, reports: [] }) });
    const r = await svc.check(CLEAN_PHONE);
    expect(db._insertOnConflict).not.toHaveBeenCalled();
    expect(r.nekorektenConfigured).toBe(false);
  });

  it('no DB row at all → behaves like never-checked (calls API)', async () => {
    const db = makeDb({ riskRow: null, events: [] });
    await build(db);
    nkClient.checkPhone.mockResolvedValueOnce({ configured: true, found: false, count: 0, reports: [] });
    const r = await svc.check(CLEAN_PHONE);
    expect(nkClient.checkPhone).toHaveBeenCalledWith(NORMALIZED);
    expect(r.strikes).toBe(0);
  });

  it('skipApi with stale row — serves DB snapshot, makes no API call', async () => {
    const db = makeDb({ riskRow: staleRow(true), events: [] });
    await build(db);
    const r = await svc.check(CLEAN_PHONE, { skipApi: true });
    expect(nkClient.checkPhone).not.toHaveBeenCalled();
    expect(r.cached).toBe(true);
    // Should still serve the stale DB snapshot values
    expect(r.nekorektenCount).toBe(1);
  });

  it('skipApi with absent row — serves empty snapshot, makes no API call', async () => {
    const db = makeDb({ riskRow: null, events: [] });
    await build(db);
    const r = await svc.check(CLEAN_PHONE, { skipApi: true });
    expect(nkClient.checkPhone).not.toHaveBeenCalled();
    expect(r.cached).toBe(true);
    expect(r.nekorektenCount).toBe(0);
  });
});

// ---- Tests: checkBulk() -----------------------------------------------------

describe('CodRiskService.checkBulk', () => {
  let svc: CodRiskService;

  /** Build service and replace check() with a spy for bulk-level tests. */
  async function buildWithSpy(checkSpy: jest.Mock, cacheMock = makeCacheMock()) {
    const nkClient = { configured: true, checkPhone: jest.fn().mockResolvedValue({ configured: true, found: false, count: 0, reports: [] }) };
    const db = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockResolvedValue([]) }) }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CodRiskService,
        { provide: DB_TOKEN, useValue: db },
        { provide: NekorektenClient, useValue: nkClient },
        { provide: PublicCacheService, useValue: cacheMock },
      ],
    }).compile();
    svc = mod.get(CodRiskService);
    svc.check = checkSpy;
    return svc;
  }

  const okResult = { phone: NORMALIZED, verdict: 'ok', strikes: 0, nekorektenCount: 0, nekorektenConfigured: true, cached: true, reports: [] };

  it('dedupes duplicate phones — check() called once per unique normalized phone', async () => {
    const checkSpy = jest.fn().mockResolvedValue(okResult);
    await buildWithSpy(checkSpy);
    const r = await svc.checkBulk(TENANT_ID, ['0888111222', '0888 111 222', '+359888111222']);
    // All three normalize to the same phone → check() must be called exactly once.
    expect(checkSpy).toHaveBeenCalledTimes(1);
    // All three input phones get a result (duplicates mapped back).
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.verdict === 'ok')).toBe(true);
  });

  it('returns original phone + normalized phone in each result', async () => {
    const checkSpy = jest.fn().mockResolvedValue(okResult);
    await buildWithSpy(checkSpy);
    const [r] = await svc.checkBulk(TENANT_ID, [CLEAN_PHONE]);
    expect(r.phone).toBe(CLEAN_PHONE);
    expect(r.normalized).toBe(NORMALIZED);
  });

  it('caps at 500 unique phones (BULK_CAP)', async () => {
    const phones = Array.from({ length: 600 }, (_, i) => `088${String(i + 10000000).slice(1)}`);
    const checkSpy = jest.fn().mockResolvedValue(okResult);
    await buildWithSpy(checkSpy);
    await svc.checkBulk(TENANT_ID, phones);
    expect(checkSpy).toHaveBeenCalledTimes(500);
  });

  it('handles mixed valid/invalid phones without throwing', async () => {
    const checkSpy = jest.fn().mockResolvedValue(okResult);
    await buildWithSpy(checkSpy);
    const r = await svc.checkBulk(TENANT_ID, ['abc', CLEAN_PHONE, '']);
    expect(r).toHaveLength(3);
  });

  it('propagates cached=false + verdict from check() result', async () => {
    const cautiousResult = { ...okResult, verdict: 'caution', nekorektenCount: 1, cached: false };
    const checkSpy = jest.fn().mockResolvedValue(cautiousResult);
    await buildWithSpy(checkSpy);
    const [r] = await svc.checkBulk(TENANT_ID, [CLEAN_PHONE]);
    expect(r.cached).toBe(false);
    expect(r.verdict).toBe('caution');
    expect(r.nekorektenCount).toBe(1);
  });

  it('empty input returns empty array', async () => {
    const checkSpy = jest.fn().mockResolvedValue(okResult);
    await buildWithSpy(checkSpy);
    const r = await svc.checkBulk(TENANT_ID, []);
    expect(r).toHaveLength(0);
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it('duplicate phones in output use canonical r.phone (Fix 4: cosmetic consistency)', async () => {
    const checkSpy = jest.fn().mockResolvedValue(okResult);
    await buildWithSpy(checkSpy);
    // Two phones that normalize to the same value — the second is a duplicate.
    const r = await svc.checkBulk(TENANT_ID, [CLEAN_PHONE, '+359888111222']);
    // Both entries should use the canonical r.phone (NORMALIZED) as their normalized field.
    expect(r[0].normalized).toBe(NORMALIZED);
    expect(r[1].normalized).toBe(NORMALIZED);
  });

  it('skipApi path — stale row + skipApi returns DB snapshot with no checkPhone call', async () => {
    // Build service WITHOUT replacing check() so we can test the actual skipApi flow.
    const nkCheckPhone = jest.fn().mockResolvedValue({ configured: true, found: false, count: 0, reports: [] });
    const nkClient = { configured: true, checkPhone: nkCheckPhone };
    // DB returns a stale row for the risk check, empty events.
    const staleRowData = staleRow(true);
    // Each check() call in checkBulk triggers two .limit() calls (risk row + events).
    const db = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      // Alternating: riskRow, events, riskRow, events, ...
      limit: jest.fn()
        .mockResolvedValueOnce([staleRowData])
        .mockResolvedValueOnce([]),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockResolvedValue([]) }) }),
    };
    // Set liveCap to 0 by using budget=DAILY_NK_BUDGET (200) in cache
    const cacheMock = makeCacheMock(200); // used=200 → remaining=0 → liveCap=0
    const mod = await Test.createTestingModule({
      providers: [
        CodRiskService,
        { provide: DB_TOKEN, useValue: db },
        { provide: NekorektenClient, useValue: nkClient },
        { provide: PublicCacheService, useValue: cacheMock },
      ],
    }).compile();
    const service = mod.get(CodRiskService);
    const results = await service.checkBulk(TENANT_ID, [CLEAN_PHONE]);
    // Budget exhausted → skipApi=true → no API call
    expect(nkCheckPhone).not.toHaveBeenCalled();
    // DB snapshot should still be served
    expect(results[0].cached).toBe(true);
  });

  it('live-call cap — stops making API calls after MAX_LIVE_CALLS (=50)', async () => {
    // Build with real check() but mock checkPhone so we can count calls.
    const nkCheckPhone = jest.fn().mockResolvedValue({ configured: true, found: false, count: 0, reports: [] });
    const nkClient = { configured: true, checkPhone: nkCheckPhone };
    // DB always returns a never-checked row (nkCheckedAt=null) to force API path when not skipped.
    const neverChecked = { strikes: 0, nkFound: null, nkCount: null, nkReports: null, nkCheckedAt: null };
    // We need 60 unique phones → 60 pairs of (risk row + events) limit() calls.
    const limitMock = jest.fn();
    for (let i = 0; i < 60; i++) {
      limitMock.mockResolvedValueOnce([neverChecked]); // risk row
      limitMock.mockResolvedValueOnce([]);             // events
    }
    const db = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: limitMock,
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockResolvedValue([]) }) }),
    };
    // No prior budget usage → full liveCap = MIN(50, 200) = 50
    const cacheMock = makeCacheMock(0);
    const mod = await Test.createTestingModule({
      providers: [
        CodRiskService,
        { provide: DB_TOKEN, useValue: db },
        { provide: NekorektenClient, useValue: nkClient },
        { provide: PublicCacheService, useValue: cacheMock },
      ],
    }).compile();
    const service = mod.get(CodRiskService);
    // 60 unique phones, but cap is 50 (MAX_LIVE_CALLS); allow ≤ 50 + CONCURRENCY-1 = 54 due to in-flight
    const phones = Array.from({ length: 60 }, (_, i) => `088${String(i + 10000000).slice(1)}`);
    await service.checkBulk(TENANT_ID, phones);
    expect(nkCheckPhone.mock.calls.length).toBeLessThanOrEqual(50 + 5 - 1); // cap + CONCURRENCY-1
    expect(nkCheckPhone.mock.calls.length).toBeGreaterThan(0);
  });

  it('daily budget — when used >= DAILY_NK_BUDGET, checkBulk makes zero live calls', async () => {
    const nkCheckPhone = jest.fn().mockResolvedValue({ configured: true, found: false, count: 0, reports: [] });
    const nkClient = { configured: true, checkPhone: nkCheckPhone };
    const neverChecked = { strikes: 0, nkFound: null, nkCount: null, nkReports: null, nkCheckedAt: null };
    const db = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn()
        .mockResolvedValueOnce([neverChecked])
        .mockResolvedValueOnce([]),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockResolvedValue([]) }) }),
    };
    // Budget fully used up: used=200 → remaining=0 → liveCap=0
    const cacheMock = makeCacheMock(200);
    const mod = await Test.createTestingModule({
      providers: [
        CodRiskService,
        { provide: DB_TOKEN, useValue: db },
        { provide: NekorektenClient, useValue: nkClient },
        { provide: PublicCacheService, useValue: cacheMock },
      ],
    }).compile();
    const service = mod.get(CodRiskService);
    await service.checkBulk(TENANT_ID, [CLEAN_PHONE]);
    expect(nkCheckPhone).not.toHaveBeenCalled();
  });
});
