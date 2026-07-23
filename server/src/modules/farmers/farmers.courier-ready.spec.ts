import { FarmersService } from './farmers.service';

/** Thenable chainable Drizzle mock (same pattern as farmers.service.spec.ts):
 *  builder methods return `this`; awaiting the chain resolves the next queued
 *  value (FIFO). findAll awaits two chains — the farmers rows, then the tenant
 *  settings row. */
function makeDb() {
  const queue: unknown[] = [];
  const db: any = {
    queue: (v: unknown) => queue.push(v),
  };
  const chain = () => db;
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) {
    db[m] = jest.fn(chain);
  }
  db.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    const v = queue.shift();
    if (v instanceof Error) reject(v);
    else resolve(v);
  };
  return db;
}

function makeSvc(db: any) {
  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const publicCache = {
    del: jest.fn().mockResolvedValue(undefined),
    resolveTenant: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
  };
  const maps = { enabled: false, geocodeApprox: jest.fn() };
  return new FarmersService(db, {} as any, cache as any, publicCache as any, {} as any, {} as any, maps as any);
}

const TENANT = 'tenant-1';
const row = (id: string) => ({ id, tenantId: TENANT, name: id, signaturePng: null });

describe('FarmersService.findAll — courierReady stamp', () => {
  it('true only for farmers with a configured carrier in their settings sub-namespace', async () => {
    const db = makeDb();
    db.queue([row('f-econt'), row('f-speedy'), row('f-none')]);
    db.queue([
      {
        settings: {
          delivery: {
            farmers: {
              'f-econt': { econt: { configured: true } },
              'f-speedy': { speedy: { configured: true } },
              // f-none: no namespace at all
            },
          },
        },
      },
    ]);

    const out = await makeSvc(db).findAll(TENANT);

    expect(out.map((f) => [f.id, f.courierReady])).toEqual([
      ['f-econt', true],
      ['f-speedy', true],
      ['f-none', false],
    ]);
    // stripSignature still applies on the augmented rows
    expect(out.every((f) => !('signaturePng' in f))).toBe(true);
  });

  it('missing tenant row / empty settings → everyone not ready (no throw)', async () => {
    const db = makeDb();
    db.queue([row('f1')]);
    db.queue([]); // tenant row not found
    const out = await makeSvc(db).findAll(TENANT);
    expect(out[0].courierReady).toBe(false);
  });

  it('configured:false does not count as ready', async () => {
    const db = makeDb();
    db.queue([row('f1')]);
    db.queue([
      { settings: { delivery: { farmers: { f1: { econt: { configured: false }, speedy: {} } } } } },
    ]);
    const out = await makeSvc(db).findAll(TENANT);
    expect(out[0].courierReady).toBe(false);
  });
});
