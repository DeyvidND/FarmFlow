import { PgDialect } from 'drizzle-orm/pg-core';
import { EcontService, econtSettingsPath } from './econt.service';

describe('econtSettingsPath', () => {
  it('tenant level when no farmerId', () => {
    expect(econtSettingsPath(undefined)).toEqual(['delivery', 'econt']);
  });
  it('farmer sub-namespace when farmerId present', () => {
    expect(econtSettingsPath('f1')).toEqual(['delivery', 'farmers', 'f1', 'econt']);
  });
});

/**
 * saveCredentials now writes the econt blob with an ATOMIC jsonb path-merge
 * (jsonbDeepMerge) instead of a read-modify-write of the whole settings column, so
 * two farmers — or a farmer and the tenant-level account — connecting in parallel
 * no longer clobber each other. These tests render the emitted SQL to recover the
 * written leaf blob, then simulate the SAME coalesce/|| merge Postgres performs to
 * prove sibling subtrees survive. (jsonb.spec.ts separately proves the SQL renders
 * to exactly that merge shape.)
 */
describe('EcontService.saveCredentials farmer scope', () => {
  const dialect = new PgDialect();

  /** Build a service whose db/cache are stubs, capturing the settings SQL written. */
  function makeService(initialSettings: Record<string, unknown>) {
    const captured: { settings?: unknown } = {};
    const updateChain = {
      set: (vals: { settings: unknown }) => {
        captured.settings = vals.settings;
        return { where: async () => undefined };
      },
    };
    const db = {
      // loadStored's SELECT … from(tenants).where(...).limit(1)
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
    const svc = new EcontService(
      db as never,
      { get: () => 'a'.repeat(32) } as never, // ENCRYPTION_KEY present
      cache as never,
      {} as never,
      {} as never,
    );
    // Avoid hitting the live Econt API for credential validation + profile seeding.
    (svc as unknown as { call: (...a: unknown[]) => Promise<unknown> }).call = jest
      .fn()
      .mockResolvedValue({ cities: [], profiles: [] });
    return { svc, captured };
  }

  /** Walk a settings object along a key path, returning the value (or undefined). */
  const at = (settings: unknown, path: string[]): any =>
    path.reduce((o: any, k) => (o == null ? o : o[k]), settings);

  /** Reproduce the exact `coalesce(x,'{}') || jsonb_build_object(k, child)` deep-merge
   *  Postgres runs for jsonbDeepMerge, so a captured write can be applied to the
   *  starting settings and its sibling-preservation asserted. */
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

  it('tenant level: writes settings.delivery.econt (farmerId omitted)', async () => {
    const initial = {};
    const { svc, captured } = makeService(initial);
    await svc.saveCredentials('t1', { username: 'u', password: 'p' });
    const { params, blob } = written(captured);
    expect(params).toEqual(expect.arrayContaining(['delivery', 'econt']));
    expect(params).not.toContain('farmers'); // no farmer sub-namespace leaked in
    expect(blob.username).toBe('u');
    expect(blob.configured).toBe(true);
    const result = simulateMerge(initial, econtSettingsPath(undefined), blob);
    expect((result.delivery as any).farmers).toBeUndefined();
  });

  it('farmer scope: deep-creates settings.delivery.farmers.<id>.econt from empty settings', async () => {
    const initial = {};
    const { svc, captured } = makeService(initial);
    await svc.saveCredentials('t1', { username: 'fu', password: 'fp' }, 'f1');
    const { params, blob } = written(captured);
    expect(params).toEqual(expect.arrayContaining(['delivery', 'farmers', 'f1', 'econt']));
    expect(blob.username).toBe('fu');
    expect(blob.configured).toBe(true);
    const result = simulateMerge(initial, econtSettingsPath('f1'), blob);
    expect(at(result, econtSettingsPath('f1')).username).toBe('fu');
    expect((result.delivery as any).econt).toBeUndefined(); // tenant-level still absent
  });

  it('farmer scope: preserves an existing tenant-level econt blob + sibling farmers', async () => {
    const initial = {
      delivery: {
        econt: { username: 'tenantUser', passwordEnc: 'enc', configured: true },
        farmers: { f2: { econt: { username: 'other', configured: true } } },
      },
    };
    const { svc, captured } = makeService(initial);
    await svc.saveCredentials('t1', { username: 'fu', password: 'fp' }, 'f1');
    const { params, blob } = written(captured);
    // atomic path-merge at the f1 econt path (NOT a whole-blob overwrite)…
    expect(params).toEqual(expect.arrayContaining(['delivery', 'farmers', 'f1', 'econt']));
    // …so applying the SAME merge Postgres runs preserves every sibling subtree.
    const result = simulateMerge(initial, econtSettingsPath('f1'), blob);
    expect(at(result, econtSettingsPath('f1')).username).toBe('fu');
    expect(at(result, econtSettingsPath(undefined)).username).toBe('tenantUser');
    expect(at(result, econtSettingsPath('f2')).username).toBe('other');
  });
});
