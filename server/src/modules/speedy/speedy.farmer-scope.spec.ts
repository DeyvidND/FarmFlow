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
 * saveCredentials round-trip: the stored settings blob must land the speedy config
 * at the right JSONB path — tenant-level when no farmerId, under the per-farmer
 * sub-namespace otherwise — AND must deep-create the `delivery.farmers.<id>`
 * parents when they don't exist yet.
 */
describe('SpeedyService.saveCredentials farmer scope', () => {
  /** Build a service whose db/cache/client are stubs, capturing the settings written. */
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
    // Stub the live Speedy validation + contract-client lookup so the test is offline.
    const client = { call: jest.fn().mockResolvedValue({}) };
    const svc = new SpeedyService(
      db as never,
      { get: () => 'a'.repeat(32) } as never, // ENCRYPTION_KEY present
      cache as never,
      client as never,
      {} as never,
    );
    return { svc, captured };
  }

  /** Walk a settings object along a key path, returning the value (or undefined). */
  const at = (settings: unknown, path: string[]): any =>
    path.reduce((o: any, k) => (o == null ? o : o[k]), settings);

  it('tenant level: writes settings.delivery.speedy (farmerId omitted)', async () => {
    const { svc, captured } = makeService({});
    await svc.saveCredentials('t1', { userName: 'u', password: 'p' } as never);
    const blob = at(captured.settings, speedySettingsPath(undefined));
    expect(blob).toBeDefined();
    expect(blob.userName).toBe('u');
    expect(blob.configured).toBe(true);
    // No farmer sub-namespace leaked into the tenant write.
    expect((captured.settings!.delivery as any).farmers).toBeUndefined();
  });

  it('farmer scope: deep-creates settings.delivery.farmers.<id>.speedy from empty settings', async () => {
    const { svc, captured } = makeService({});
    await svc.saveCredentials('t1', { userName: 'fu', password: 'fp' } as never, 'f1');
    const blob = at(captured.settings, speedySettingsPath('f1'));
    expect(blob).toBeDefined();
    expect(blob.userName).toBe('fu');
    expect(blob.configured).toBe(true);
    // The tenant-level speedy blob is untouched (still absent).
    expect((captured.settings!.delivery as any).speedy).toBeUndefined();
  });

  it('farmer scope: preserves an existing tenant-level speedy blob + sibling farmers', async () => {
    const { svc, captured } = makeService({
      delivery: {
        speedy: { userName: 'tenantUser', passwordEnc: 'enc', configured: true },
        farmers: { f2: { speedy: { userName: 'other', configured: true } } },
      },
    });
    await svc.saveCredentials('t1', { userName: 'fu', password: 'fp' } as never, 'f1');
    // The new farmer blob is written…
    expect(at(captured.settings, speedySettingsPath('f1')).userName).toBe('fu');
    // …without clobbering the tenant-level blob…
    expect(at(captured.settings, speedySettingsPath(undefined)).userName).toBe('tenantUser');
    // …or the sibling farmer.
    expect(at(captured.settings, speedySettingsPath('f2')).userName).toBe('other');
  });

  // saveProfile shares loadStored + writeAtPath with saveCredentials, so it must land
  // the profile at the same per-farmer leaf and preserve the tenant-level blob.
  it('saveProfile farmer scope: writes delivery.farmers.<id>.speedy, leaves tenant blob untouched', async () => {
    const { svc, captured } = makeService({
      delivery: { speedy: { userName: 'tenantUser', passwordEnc: 'enc', configured: true } },
    });
    await svc.saveProfile('t1', { defaultPackage: { weightKg: 2 } }, 'f1');
    expect(at(captured.settings, speedySettingsPath('f1')).defaultPackage).toEqual({ weightKg: 2 });
    // Tenant-level creds blob is left intact.
    expect(at(captured.settings, speedySettingsPath(undefined)).userName).toBe('tenantUser');
  });

  it('saveProfile tenant level: writes delivery.speedy (farmerId omitted)', async () => {
    const { svc, captured } = makeService({
      delivery: { speedy: { userName: 'tenantUser', configured: true } },
    });
    await svc.saveProfile('t1', { defaultPackage: { weightKg: 3 } });
    expect(at(captured.settings, speedySettingsPath(undefined)).defaultPackage).toEqual({ weightKg: 3 });
    // Existing creds preserved (merge over the stored blob).
    expect(at(captured.settings, speedySettingsPath(undefined)).userName).toBe('tenantUser');
    expect((captured.settings!.delivery as any).farmers).toBeUndefined();
  });
});
