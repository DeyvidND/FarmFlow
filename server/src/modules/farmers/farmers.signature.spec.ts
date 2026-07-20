import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { FarmersService } from './farmers.service';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const TENANT = 'tenant-1';
const FARMER = 'farmer-1';

/** Minimal DB stub that tracks the last-written `signaturePng` value and serves it
 *  back on read — enough to prove the encrypt/decrypt round trip through the service
 *  without a real database. `existingRow: null` simulates a missing/cross-tenant
 *  farmer (empty result set on every query). NOTE: use `null`, not `undefined`, for
 *  that case — a default parameter also fires on an explicitly-passed `undefined`. */
function dbMock(existingRow: { id: string } | null = { id: FARMER }) {
  const state: { stored?: string | null } = {};
  return {
    state,
    update: jest.fn(() => ({
      set: (v: { signaturePng: string | null }) => ({
        where: () => ({
          returning: async () => {
            if (!existingRow) return [];
            state.stored = v.signaturePng;
            return [{ id: existingRow.id }];
          },
        }),
      }),
    })),
    select: jest.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => (existingRow ? [{ signaturePng: state.stored ?? null }] : []),
        }),
      }),
    })),
  };
}

describe('FarmersService signature', () => {
  const OLD_KEY = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'test-key';
  });

  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = OLD_KEY;
  });

  // storage/cache/publicCache/auth/imageQueue are unused by getSignature/setSignature
  // — stub them like the sibling farmers.access.spec.ts does.
  function make(db: ReturnType<typeof dbMock>) {
    return new FarmersService(db as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  }

  it('stores encrypted and reads back decrypted', async () => {
    const db = dbMock();
    const svc = make(db);

    await svc.setSignature(FARMER, TENANT, PNG);
    expect(db.state.stored).toBeDefined();
    expect(db.state.stored).not.toEqual(PNG); // encrypted at rest, not the plaintext data-URL

    const got = await svc.getSignature(FARMER, TENANT);
    expect(got.signaturePng).toEqual(PNG); // decrypted back on read
  });

  it('refuses to store a signature when ENCRYPTION_KEY is unset, and writes nothing', async () => {
    delete process.env.ENCRYPTION_KEY;
    const db = dbMock();
    const svc = make(db);

    let caught: unknown;
    try {
      await svc.setSignature(FARMER, TENANT, PNG);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect((caught as Error).message).toMatch(/ключ за криптиране/);
    expect(db.update).not.toHaveBeenCalled(); // nothing written in plaintext
    expect(db.state.stored).toBeUndefined();
  });

  it('allows clearing a signature with no key configured', async () => {
    delete process.env.ENCRYPTION_KEY;
    const db = dbMock();
    const svc = make(db);

    await expect(svc.setSignature(FARMER, TENANT, null)).resolves.toEqual({ signaturePng: null });
    expect(db.state.stored).toBeNull();
  });

  it('getSignature 404s for a missing / cross-tenant farmer', async () => {
    const db = dbMock(null);
    const svc = make(db);
    await expect(svc.getSignature(FARMER, TENANT)).rejects.toThrow(NotFoundException);
  });

  it('setSignature 404s for a missing / cross-tenant farmer', async () => {
    const db = dbMock(null);
    const svc = make(db);
    await expect(svc.setSignature(FARMER, TENANT, PNG)).rejects.toThrow(NotFoundException);
  });
});

// Regression: the encrypted blob must never ride along in the general CRUD
// payloads (GET /farmers, GET /farmers/:id) — only the dedicated
// GET /farmers/:id/signature endpoint may return it. This would fail if the
// `stripSignature` strip in FarmersService.findOne/findAll were ever removed.
describe('FarmersService general CRUD path never leaks the signature blob', () => {
  const ENCRYPTED = 'v1:9f2c-stand-in-ciphertext'; // content is irrelevant — presence is the point
  const ROW = {
    id: FARMER,
    tenantId: TENANT,
    name: 'Иван',
    position: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    signaturePng: ENCRYPTED,
  };

  /** Thenable chainable Drizzle mock (mirrors farmers.public-fields.spec.ts):
   *  builder methods return `this`; awaiting the chain resolves the next queued
   *  row set (FIFO). */
  function makeDb() {
    const queue: unknown[] = [];
    const db: any = { queue: (v: unknown) => queue.push(v) };
    const chain = () => db;
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) db[m] = jest.fn(chain);
    db.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      const v = queue.shift();
      if (v instanceof Error) reject(v);
      else resolve(v);
    };
    return db;
  }

  it('findOne strips signaturePng even though the stored row carries ciphertext', async () => {
    const db = makeDb();
    db.queue([ROW]);
    const svc = new FarmersService(db as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    const out = await svc.findOne(FARMER, TENANT);

    expect(out).not.toHaveProperty('signaturePng');
    expect(out).toEqual({ id: FARMER, tenantId: TENANT, name: 'Иван', position: 0, createdAt: ROW.createdAt });
  });

  it('findAll strips signaturePng from every row in the list', async () => {
    const db = makeDb();
    db.queue([ROW, { ...ROW, id: 'farmer-2', signaturePng: 'other-ciphertext' }]);
    const svc = new FarmersService(db as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    const out = await svc.findAll(TENANT);

    expect(out).toHaveLength(2);
    for (const f of out) expect(f).not.toHaveProperty('signaturePng');
  });
});
