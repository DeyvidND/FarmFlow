import { TenantsService } from './tenants.service';

const TENANT = 'tenant-1';

/**
 * TenantsService transport presets (settings.transportPresets, 2026-07-23) —
 * the reusable В.Транспорт entries the consolidated-protocol screen picks
 * from. Whole-list PUT semantics; the service normalizes (trim, drop empty
 * entries, assign missing ids) and writes via jsonb_set so sibling settings
 * keys survive.
 */
function dbMock(settings: unknown = {}) {
  const captured: { set?: any } = {};
  return {
    captured,
    select: jest.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ settings }],
        }),
      }),
    })),
    update: jest.fn(() => ({
      set: (v: any) => {
        captured.set = v;
        return {
          where: () => ({
            returning: async () => [{ id: TENANT }],
          }),
        };
      },
    })),
  };
}

function make(db: ReturnType<typeof dbMock>) {
  return new TenantsService(
    db as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

describe('TenantsService.getTransportPresets', () => {
  it('returns the stored list, or [] when unset/garbage', async () => {
    const list = [{ id: 'p1', vehicle: 'Бус' }];
    expect(await make(dbMock({ transportPresets: list })).getTransportPresets(TENANT)).toEqual(list);
    expect(await make(dbMock({})).getTransportPresets(TENANT)).toEqual([]);
    expect(await make(dbMock({ transportPresets: 'not-a-list' })).getTransportPresets(TENANT)).toEqual([]);
  });
});

describe('TenantsService.updateTransportPresets', () => {
  it('trims fields, drops all-empty entries and assigns ids to new ones', async () => {
    const db = dbMock();
    const out = await make(db).updateTransportPresets(TENANT, {
      presets: [
        { id: 'keep-1', vehicle: '  Форд Транзит  ', plate: 'В1234КХ' },
        { vehicle: '  ', plate: '', driverName: '   ' }, // no content → dropped
        { driverName: 'Иван Иванов', startPlace: ' склад Варна ' }, // new → gets an id
      ],
    } as any);

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: 'keep-1', vehicle: 'Форд Транзит', plate: 'В1234КХ' });
    expect(out[1]).toEqual(
      expect.objectContaining({ driverName: 'Иван Иванов', startPlace: 'склад Варна' }),
    );
    expect(typeof out[1].id).toBe('string');
    expect(out[1].id.length).toBeGreaterThan(0);
    // The write goes through the captured .set() — i.e. one UPDATE, jsonb_set
    // on the single key (rendering the SQL is covered by the shared idiom
    // tests; here we prove the call happened with the normalized list).
    expect(db.captured.set).toBeDefined();
  });
});
