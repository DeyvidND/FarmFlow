import { ServiceUnavailableException } from '@nestjs/common';
import { TenantsService } from './tenants.service';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const TENANT = 'tenant-1';

/** Minimal DB stub that tracks the last-written `signaturePng` value and serves it
 *  back on read — enough to prove the encrypt/decrypt round trip through the service
 *  without a real database. Mirrors farmers.signature.spec.ts's dbMock. */
function dbMock() {
  const state: { stored?: string | null } = {};
  return {
    state,
    update: jest.fn(() => ({
      set: (v: { operatorSignaturePng: string | null }) => ({
        where: async () => {
          state.stored = v.operatorSignaturePng;
        },
      }),
    })),
    select: jest.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ signaturePng: state.stored ?? null }],
        }),
      }),
    })),
  };
}

describe('TenantsService signature', () => {
  const OLD_KEY = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'test-key';
  });

  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = OLD_KEY;
  });

  // maps/publicCache/storage/stripe/jwt/config are unused by getSignature/setSignature.
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

  it('stores encrypted and reads back decrypted', async () => {
    const db = dbMock();
    const svc = make(db);

    await svc.setSignature(TENANT, PNG);
    expect(db.state.stored).toBeDefined();
    expect(db.state.stored).not.toEqual(PNG); // encrypted at rest, not the plaintext data-URL

    const got = await svc.getSignature(TENANT);
    expect(got.signaturePng).toEqual(PNG); // decrypted back on read
  });

  it('refuses to store a signature when ENCRYPTION_KEY is unset, and writes nothing', async () => {
    delete process.env.ENCRYPTION_KEY;
    const db = dbMock();
    const svc = make(db);

    let caught: unknown;
    try {
      await svc.setSignature(TENANT, PNG);
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

    await expect(svc.setSignature(TENANT, null)).resolves.toEqual({ signaturePng: null });
    expect(db.state.stored).toBeNull();
  });

  it('getSignature returns null when no signature has ever been stored', async () => {
    const db = dbMock();
    const svc = make(db);
    await expect(svc.getSignature(TENANT)).resolves.toEqual({ signaturePng: null });
  });
});
