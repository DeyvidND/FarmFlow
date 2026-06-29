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
 * saveCredentials round-trip: the stored settings blob must land the econt config
 * at the right JSONB path — tenant-level when no farmerId, under the per-farmer
 * sub-namespace otherwise — AND must deep-create the `delivery.farmers.<id>`
 * parents when they don't exist yet.
 */
describe('EcontService.saveCredentials farmer scope', () => {
  /** Build a service whose db/cache are stubs, capturing the settings written. */
  function makeService(initialSettings: Record<string, unknown>) {
    const captured: { settings?: Record<string, unknown> } = {};
    const updateChain = {
      set: (vals: { settings: Record<string, unknown> }) => {
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
    const cache = { del: async () => undefined, set: async () => undefined, get: async () => null };
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

  it('tenant level: writes settings.delivery.econt (farmerId omitted)', async () => {
    const { svc, captured } = makeService({});
    await svc.saveCredentials('t1', { username: 'u', password: 'p' });
    const blob = at(captured.settings, econtSettingsPath(undefined));
    expect(blob).toBeDefined();
    expect(blob.username).toBe('u');
    expect(blob.configured).toBe(true);
    // No farmer sub-namespace leaked into the tenant write.
    expect((captured.settings!.delivery as any).farmers).toBeUndefined();
  });

  it('farmer scope: deep-creates settings.delivery.farmers.<id>.econt from empty settings', async () => {
    const { svc, captured } = makeService({});
    await svc.saveCredentials('t1', { username: 'fu', password: 'fp' }, 'f1');
    const blob = at(captured.settings, econtSettingsPath('f1'));
    expect(blob).toBeDefined();
    expect(blob.username).toBe('fu');
    expect(blob.configured).toBe(true);
    // The tenant-level econt blob is untouched (still absent).
    expect((captured.settings!.delivery as any).econt).toBeUndefined();
  });

  it('farmer scope: preserves an existing tenant-level econt blob + sibling farmers', async () => {
    const { svc, captured } = makeService({
      delivery: {
        econt: { username: 'tenantUser', passwordEnc: 'enc', configured: true },
        farmers: { f2: { econt: { username: 'other', configured: true } } },
      },
    });
    await svc.saveCredentials('t1', { username: 'fu', password: 'fp' }, 'f1');
    // The new farmer blob is written…
    expect(at(captured.settings, econtSettingsPath('f1')).username).toBe('fu');
    // …without clobbering the tenant-level blob…
    expect(at(captured.settings, econtSettingsPath(undefined)).username).toBe('tenantUser');
    // …or the sibling farmer.
    expect(at(captured.settings, econtSettingsPath('f2')).username).toBe('other');
  });
});
