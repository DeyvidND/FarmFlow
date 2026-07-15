import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PlatformAdminGuard } from './platform-admin.guard';

/**
 * Task B1 — the naming-collision regression test. TenantRole `'admin'` (a farm
 * owner, `type:'tenant', role:'admin'`) is NOT the same principal as the
 * platform session (`type:'platform'`) this guard is meant to require. A
 * session that merely LOOKS admin-ish (tenant owner) must never pass here —
 * only an actual platform login may. See the plan's Global Constraints: this
 * is "the sharpest edge" of the whole courier-assignment-board feature.
 */
describe('PlatformAdminGuard', () => {
  const guard = new PlatformAdminGuard();

  it('rejects a tenant admin (farm owner) session — NOT the same principal as a platform admin', () => {
    const tenantAdminUser = { type: 'tenant', role: 'admin', userId: 'owner-1', tenantId: 'tenant-1' };
    expect(() => guard.handleRequest(null, tenantAdminUser, null)).toThrow(ForbiddenException);
  });

  it('rejects a tenant driver session', () => {
    const driverUser = { type: 'tenant', role: 'driver', userId: 'driver-1', tenantId: 'tenant-1' };
    expect(() => guard.handleRequest(null, driverUser, null)).toThrow(ForbiddenException);
  });

  it('rejects when passport found no user at all (invalid/missing token) — 401, distinct from the 403 wrong-principal case', () => {
    expect(() => guard.handleRequest(null, false, null)).toThrow(UnauthorizedException);
  });

  it('accepts a real platform session', () => {
    const platformUser = { type: 'platform', adminId: 'admin-1' };
    expect(guard.handleRequest(null, platformUser, null)).toBe(platformUser);
  });
});
