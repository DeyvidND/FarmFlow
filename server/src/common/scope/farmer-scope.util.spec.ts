import { ForbiddenException } from '@nestjs/common';
import { effectiveFarmerId } from './farmer-scope.util';

describe('effectiveFarmerId', () => {
  it('forces a producer to their own token id, ignoring any query override', () => {
    expect(effectiveFarmerId('farmer', 'farmer-1', 'farmer-9')).toBe('farmer-1');
    expect(effectiveFarmerId('farmer', 'farmer-1', undefined)).toBe('farmer-1');
  });

  it('throws when a farmer token has no farmerId (malformed)', () => {
    expect(() => effectiveFarmerId('farmer', undefined, undefined)).toThrow(ForbiddenException);
  });

  it('lets an owner pick a producer or see the whole tenant', () => {
    expect(effectiveFarmerId('admin', undefined, 'farmer-3')).toBe('farmer-3');
    expect(effectiveFarmerId('admin', undefined, undefined)).toBeNull();
  });

  // Documents intent: this resolver only decides SCOPE for a role already authorized
  // to hit the endpoint — role gating is the @Roles/TenantRolesGuard's job. Non-farmer
  // roles fall through to the owner branch (query ?? null). Today only admin+farmer are
  // ever wired to scoped endpoints, but lock the behavior so it can't drift silently.
  it('treats other non-farmer roles like the owner (gating is the guard’s job)', () => {
    expect(effectiveFarmerId('driver', undefined, 'farmer-3')).toBe('farmer-3');
    expect(effectiveFarmerId('customer', undefined, undefined)).toBeNull();
  });
});
