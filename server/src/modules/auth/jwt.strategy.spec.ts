import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';

/** Chainable Drizzle stub: `.select().from().where().limit()` resolves to [row]
 *  (or [] when row is null), matching the tokenVersion lookup the strategy runs. */
function makeDb(row: { tokenVersion: number } | null = { tokenVersion: 0 }) {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => (row ? [row] : []),
  };
  return chain;
}

function makeStrategy(row: { tokenVersion: number } | null = { tokenVersion: 0 }): JwtStrategy {
  const config = {
    getOrThrow: jest.fn().mockReturnValue('test-secret'),
  } as unknown as ConfigService;
  return new JwtStrategy(config, makeDb(row));
}

describe('JwtStrategy.validate', () => {
  let strategy: JwtStrategy;

  beforeEach(() => {
    strategy = makeStrategy();
  });

  it('accepts a tenant token', async () => {
    await expect(
      strategy.validate({ sub: 'u1', type: 'tenant', tenantId: 't1', role: 'admin' } as any),
    ).resolves.toEqual({ type: 'tenant', userId: 'u1', tenantId: 't1', role: 'admin' });
  });

  it('defaults role to admin when a tenant token omits it', async () => {
    await expect(
      strategy.validate({ sub: 'u1', type: 'tenant', tenantId: 't1' } as any),
    ).resolves.toEqual({ type: 'tenant', userId: 'u1', tenantId: 't1', role: 'admin' });
  });

  it('accepts a platform token', async () => {
    await expect(
      strategy.validate({ sub: 'a1', type: 'platform' } as any),
    ).resolves.toEqual({ type: 'platform', adminId: 'a1' });
  });

  it('rejects a password-reset token', async () => {
    await expect(
      strategy.validate({ sub: 'u1', type: 'reset' } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  // Security regression guard: the newsletter unsubscribe token is signed with
  // the main JWT secret but carries `typ:'unsub'` (note: `typ`, not `type`).
  // It must NEVER be accepted as a session — it previously fell through to the
  // tenant branch and was granted role 'admin'.
  it('rejects a newsletter unsubscribe token (typ:unsub, no type)', async () => {
    await expect(
      strategy.validate({ sub: 'sub1', typ: 'unsub' } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a typeless / legacy token', async () => {
    await expect(
      strategy.validate({ sub: 'u1', tenantId: 't1', role: 'admin' } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a tenant token that is missing tenantId', async () => {
    await expect(
      strategy.validate({ sub: 'u1', type: 'tenant' } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token whose tv does not match the stored tokenVersion (revoked)', async () => {
    const revoked = makeStrategy({ tokenVersion: 3 });
    await expect(
      revoked.validate({ sub: 'u1', type: 'tenant', tenantId: 't1', role: 'admin', tv: 0 } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the principal no longer exists', async () => {
    const gone = makeStrategy(null);
    await expect(
      gone.validate({ sub: 'a1', type: 'platform', tv: 0 } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('returns farmerId in RequestUser for a producer sub-account token', async () => {
    const producerStrategy = makeStrategy({ tokenVersion: 0 });
    await expect(
      producerStrategy.validate({
        sub: 'u1', type: 'tenant', tenantId: 't1', role: 'farmer', tv: 0, farmerId: 'farmer-1',
      } as any),
    ).resolves.toEqual({
      type: 'tenant', userId: 'u1', tenantId: 't1', role: 'farmer', farmerId: 'farmer-1',
    });
  });

  it('omits farmerId from RequestUser when the payload has no farmerId', async () => {
    const ownerStrategy = makeStrategy({ tokenVersion: 0 });
    const result = await ownerStrategy.validate({
      sub: 'u1', type: 'tenant', tenantId: 't1', role: 'admin', tv: 0,
    } as any);
    expect((result as any).farmerId).toBeUndefined();
  });
});
