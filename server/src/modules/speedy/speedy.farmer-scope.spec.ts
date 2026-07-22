import { PgDialect } from 'drizzle-orm/pg-core';
import { SpeedyService, speedySettingsPath } from './speedy.service';

describe('speedySettingsPath', () => {
  it('tenant level when no farmerId', () => {
    expect(speedySettingsPath(undefined)).toEqual(['delivery', 'speedy']);
  });
  it('farmer sub-namespace when farmerId present', () => {
    expect(speedySettingsPath('f1')).toEqual(['delivery', 'farmers', 'f1', 'speedy']);
  });
});

/**
 * saveCredentials / saveProfile now write the speedy blob with an ATOMIC jsonb
 * path-merge (jsonbDeepMerge) instead of a read-modify-write of the whole settings
 * column, so parallel connects by two farmers — or a farmer and the tenant-level
 * account — no longer clobber each other. These tests render the emitted SQL to
 * recover the written leaf blob, then simulate the SAME coalesce/|| merge Postgres
 * performs to prove sibling subtrees survive. (jsonb.spec.ts separately proves the
 * SQL renders to exactly that merge shape.)
 */
describe('SpeedyService.saveCredentials farmer scope', () => {
  const dialect = new PgDialect();

  /** Build a service whose db/cache/client are stubs, capturing the settings SQL. */
  function makeService(initialSettings: Record<string, unknown>) {
    const captured: { settings?: unknown } = {};
    const updateChain = {
      set: (vals: { settings: unknown }) => {
        captured.settings = vals.settings;
        return { where: async () => undefined };
      },
    };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              { id: 't1', slug: 'farm', name: 'Ферма', settings: initialSettings, isDemo: false },
            ],
          }),
        }),
      }),
      update: () => updateChain,
    };
    const cache = { del: async () => undefined, delByPrefix: async () => undefined, set: async () => undefined, get: async () => null };
    // Stub the live Speedy validation + contract-client lookup so the test is offline.
    const client = { call: jest.fn().mockResolvedValue({}) };
    const svc = new SpeedyService(
      db as never,
      { get: () => 'a'.repeat(32) } as never, // ENCRYPTION_KEY present
      cache as never,
      client as never,
      {} as never,
      { sendShipped: jest.fn() } as never,
    );
    return { svc, captured };
  }

  /** Walk a settings object along a key path, returning the value (or undefined). */
  const at = (settings: unknown, path: string[]): any =>
    path.reduce((o: any, k) => (o == null ? o : o[k]), settings);

  /** Reproduce the exact `coalesce(x,'{}') || jsonb_build_object(k, child)` deep-merge
   *  Postgres runs for jsonbDeepMerge. */
  function simulateMerge(initial: any, path: string[], value: unknown): any {
    const [head, ...rest] = path;
    const base = initial && typeof initial === 'object' ? initial : {};
    const child = rest.length === 0 ? value : simulateMerge(base[head], rest, value);
    return { ...base, [head]: child };
  }

  /** Render the captured SQL and recover the written leaf blob (the one JSON param). */
  function written(captured: { settings?: unknown }): { params: unknown[]; blob: any } {
    const { params } = dialect.sqlToQuery(captured.settings as never);
    const jsonParam = params.find(
      (p) => typeof p === 'string' && (p as string).trim().startsWith('{'),
    ) as string;
    return { params, blob: JSON.parse(jsonParam) };
  }

  it('tenant level: writes settings.delivery.speedy (farmerId omitted)', async () => {
    const initial = {};
    const { svc, captured } = makeService(initial);
    await svc.saveCredentials('t1', { userName: 'u', password: 'p' } as never);
    const { params, blob } = written(captured);
    expect(params).toEqual(expect.arrayContaining(['delivery', 'speedy']));
    expect(params).not.toContain('farmers');
    expect(blob.userName).toBe('u');
    expect(blob.configured).toBe(true);
    const result = simulateMerge(initial, speedySettingsPath(undefined), blob);
    expect((result.delivery as any).farmers).toBeUndefined();
  });

  it('farmer scope: deep-creates settings.delivery.farmers.<id>.speedy from empty settings', async () => {
    const initial = {};
    const { svc, captured } = makeService(initial);
    await svc.saveCredentials('t1', { userName: 'fu', password: 'fp' } as never, 'f1');
    const { params, blob } = written(captured);
    expect(params).toEqual(expect.arrayContaining(['delivery', 'farmers', 'f1', 'speedy']));
    expect(blob.userName).toBe('fu');
    expect(blob.configured).toBe(true);
    const result = simulateMerge(initial, speedySettingsPath('f1'), blob);
    expect(at(result, speedySettingsPath('f1')).userName).toBe('fu');
    expect((result.delivery as any).speedy).toBeUndefined();
  });

  it('farmer scope: preserves an existing tenant-level speedy blob + sibling farmers', async () => {
    const initial = {
      delivery: {
        speedy: { userName: 'tenantUser', passwordEnc: 'enc', configured: true },
        farmers: { f2: { speedy: { userName: 'other', configured: true } } },
      },
    };
    const { svc, captured } = makeService(initial);
    await svc.saveCredentials('t1', { userName: 'fu', password: 'fp' } as never, 'f1');
    const { params, blob } = written(captured);
    expect(params).toEqual(expect.arrayContaining(['delivery', 'farmers', 'f1', 'speedy']));
    const result = simulateMerge(initial, speedySettingsPath('f1'), blob);
    expect(at(result, speedySettingsPath('f1')).userName).toBe('fu');
    expect(at(result, speedySettingsPath(undefined)).userName).toBe('tenantUser');
    expect(at(result, speedySettingsPath('f2')).userName).toBe('other');
  });

  // saveProfile shares loadStored + the atomic path-merge with saveCredentials, so it
  // must land the profile at the same per-farmer leaf and preserve the tenant blob.
  it('saveProfile farmer scope: writes delivery.farmers.<id>.speedy, leaves tenant blob untouched', async () => {
    const initial = {
      delivery: { speedy: { userName: 'tenantUser', passwordEnc: 'enc', configured: true } },
    };
    const { svc, captured } = makeService(initial);
    await svc.saveProfile('t1', { defaultPackage: { weightKg: 2 } }, 'f1');
    const { blob } = written(captured);
    const result = simulateMerge(initial, speedySettingsPath('f1'), blob);
    expect(at(result, speedySettingsPath('f1')).defaultPackage).toEqual({ weightKg: 2 });
    expect(at(result, speedySettingsPath(undefined)).userName).toBe('tenantUser');
  });

  it('saveProfile tenant level: writes delivery.speedy (farmerId omitted)', async () => {
    const initial = {
      delivery: { speedy: { userName: 'tenantUser', configured: true } },
    };
    const { svc, captured } = makeService(initial);
    await svc.saveProfile('t1', { defaultPackage: { weightKg: 3 } });
    const { params, blob } = written(captured);
    const result = simulateMerge(initial, speedySettingsPath(undefined), blob);
    expect(at(result, speedySettingsPath(undefined)).defaultPackage).toEqual({ weightKg: 3 });
    expect(at(result, speedySettingsPath(undefined)).userName).toBe('tenantUser'); // merged over stored
    expect(params).not.toContain('farmers');
    expect((result.delivery as any).farmers).toBeUndefined();
  });
});
