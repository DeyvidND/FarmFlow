import { FarmersService } from './farmers.service';

/**
 * Minimal chainable db stub that captures the `.set()` payload.
 *
 * Real update() chain (farmers.service.ts ~L182):
 *   this.db.update(farmers).set({...dto}).where(and(...)).returning()
 */
function fakeDb(captured: { set?: Record<string, unknown> }) {
  const upd = {
    set: (v: Record<string, unknown>) => {
      captured.set = v;
      return {
        where: () => ({
          returning: async () => [{ id: 'f1', tenantId: 't1', courierEnabled: v.courierEnabled }],
        }),
      };
    },
  };
  return { update: () => upd } as never;
}

describe('FarmersService.update — courierEnabled', () => {
  it('persists courierEnabled when provided', async () => {
    const captured: { set?: Record<string, unknown> } = {};
    const svc = new FarmersService(
      fakeDb(captured),
      {} as never, // storage
      { invalidate: async () => {} } as never, // cache (CatalogCacheService)
      { del: async () => {} } as never,        // publicCache (PublicCacheService)
      {} as never, // auth
      {} as never, // imageQueue
    );
    await svc.update('f1', 't1', { courierEnabled: true } as never);
    expect(captured.set?.courierEnabled).toBe(true);
  });
});
