import { ImportService } from './import.service';
import { ImportAiService } from './import.ai';
import { ImportResolveService } from './import.resolve';
import { AddressGeoService } from './address-geo.service';
import { EcontService } from '../econt/econt.service';
import { SpeedyService } from '../speedy/speedy.service';

/**
 * commit() must ATOMICALLY claim each row (conditional UPDATE ... RETURNING) before
 * calling the carrier, so two concurrent / retried commits can't both create a real
 * (paid) waybill for the same row. These tests drive the claim outcome via the mock
 * DB's update().returning() and assert the carrier create is only invoked on a winning
 * claim.
 */
describe('ImportService.commit — atomic per-row claim', () => {
  // A chainable mock DB. select(...).from().where().limit()/orderBy() return preset
  // values; update().set().where().returning() returns a per-call queued claim result.
  function makeDb(opts: {
    batch: Record<string, unknown>;
    rows: Array<Record<string, unknown>>;
    claimResults: Array<Array<{ id: string }>>; // one entry per claim attempt, FIFO
  }) {
    let claimIdx = 0;
    const db: any = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn(), // getBatch rows query terminates on orderBy
      limit: jest.fn(), // getBatch batch query terminates on limit
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      returning: jest.fn(() => Promise.resolve(opts.claimResults[claimIdx++] ?? [])),
    };
    // getBatch: 1st select chain → .limit(1) → [batch]; 2nd select chain → .orderBy() → rows
    db.limit.mockResolvedValue([opts.batch]);
    db.orderBy.mockResolvedValue(opts.rows);
    // After getBatch, where() must be chainable again for the update/delete paths.
    // The success/failure stamping update ends on .where() (no returning) — make where()
    // resolve to undefined for those by returning the chainable object (awaited → object,
    // harmless). The final batch-status update also ends on .where().
    return db;
  }

  const baseRow = {
    id: 'row-1', carrier: 'econt', shipmentId: null,
    validationStatus: 'ok', resolvedRefs: { econtOfficeCode: '1234' },
    receiverName: 'Иван', receiverPhone: '0888', deliveryMode: 'office',
    city: 'Бургас', office: '1234', address: null, weightGrams: null,
    contents: null, codAmountStotinki: null, declaredValueStotinki: null,
  };

  function buildService(db: any) {
    const econt = { createManualShipment: jest.fn().mockResolvedValue({ id: 'ship-1' }) } as unknown as EcontService;
    const speedy = { createManualShipment: jest.fn().mockResolvedValue({ id: 'ship-s1' }) } as unknown as SpeedyService;
    const ai = {} as ImportAiService;
    const resolver = {} as ImportResolveService;
    const addressGeo = {
      checkMany: jest.fn().mockResolvedValue(new Map()),
      checkOne: jest.fn().mockResolvedValue({ status: 'ok' }),
    } as unknown as AddressGeoService;
    const svc = new ImportService(db, ai, resolver, addressGeo, econt, speedy);
    return { svc, econt, speedy };
  }

  it('does NOT call the carrier when the claim returns 0 rows (lost the race / already in-flight)', async () => {
    const db = makeDb({
      batch: { id: 'b1', settings: {} },
      rows: [{ ...baseRow }],
      claimResults: [[]], // claim UPDATE matched 0 rows → already claimed by a concurrent commit
    });
    const { svc, econt } = buildService(db);

    const res = await svc.commit('t1', 'b1');

    expect(econt.createManualShipment).not.toHaveBeenCalled();
    expect(res.created).toBe(0);
    expect(res.results[0]).toMatchObject({ rowId: 'row-1', status: 'skipped' });
  });

  it('calls the carrier and creates when the claim succeeds (won the race)', async () => {
    const db = makeDb({
      batch: { id: 'b1', settings: {} },
      rows: [{ ...baseRow }],
      claimResults: [[{ id: 'row-1' }]], // claim won
    });
    const { svc, econt } = buildService(db);

    const res = await svc.commit('t1', 'b1');

    expect(econt.createManualShipment).toHaveBeenCalledTimes(1);
    expect(res.created).toBe(1);
    expect(res.results[0]).toMatchObject({ rowId: 'row-1', status: 'created', shipmentId: 'ship-1' });
  });

  it('skips a row that already has a shipmentId without attempting a claim', async () => {
    const db = makeDb({
      batch: { id: 'b1', settings: {} },
      rows: [{ ...baseRow, shipmentId: 'existing' }],
      claimResults: [],
    });
    const { svc, econt } = buildService(db);

    const res = await svc.commit('t1', 'b1');

    expect(econt.createManualShipment).not.toHaveBeenCalled();
    // No claim was attempted for this row, so returning() (used only by the claim) is untouched.
    expect(db.returning).not.toHaveBeenCalled();
    expect(res.results[0]).toMatchObject({ status: 'skipped' });
  });
});
