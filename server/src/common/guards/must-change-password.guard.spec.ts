import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MustChangePasswordGuard } from './must-change-password.guard';

function makeContext({
  method = 'POST',
  path = '/products',
  authHeader = '',
}: {
  method?: string;
  path?: string;
  authHeader?: string;
} = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        path,
        headers: { authorization: authHeader },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('MustChangePasswordGuard', () => {
  let jwtService: JwtService;
  let guard: MustChangePasswordGuard;

  beforeEach(() => {
    jwtService = { verify: jest.fn() } as unknown as JwtService;
    guard = new MustChangePasswordGuard(jwtService);
  });

  it('allows when no Authorization header is present', () => {
    expect(guard.canActivate(makeContext({ authHeader: '' }))).toBe(true);
  });

  it('allows when JWT verify throws (invalid token)', () => {
    (jwtService.verify as jest.Mock).mockImplementation(() => {
      throw new Error('invalid');
    });
    expect(guard.canActivate(makeContext({ authHeader: 'Bearer bad-token' }))).toBe(true);
  });

  it('allows platform tokens when mustChangePassword is false', () => {
    (jwtService.verify as jest.Mock).mockReturnValue({
      type: 'platform',
      sub: 'admin-1',
      mustChangePassword: false,
    });
    expect(guard.canActivate(makeContext({ authHeader: 'Bearer platform-token', path: '/tenants' }))).toBe(true);
  });

  it('locks platform out of everything except me/change-password while mustChangePassword', () => {
    (jwtService.verify as jest.Mock).mockReturnValue({
      type: 'platform',
      sub: 'admin-1',
      mustChangePassword: true,
    });
    expect(() =>
      guard.canActivate(makeContext({ authHeader: 'Bearer platform-token', method: 'GET', path: '/tenants' })),
    ).toThrow(ForbiddenException);
    expect(
      guard.canActivate(makeContext({ authHeader: 'Bearer platform-token', method: 'GET', path: '/platform/me' })),
    ).toBe(true);
    expect(
      guard.canActivate(
        makeContext({ authHeader: 'Bearer platform-token', method: 'POST', path: '/platform/change-password' }),
      ),
    ).toBe(true);
  });

  it('blocks tenant PII reads (GET /orders) while mustChangePassword', () => {
    (jwtService.verify as jest.Mock).mockReturnValue({
      type: 'tenant',
      sub: 'u1',
      mustChangePassword: true,
    });
    expect(() =>
      guard.canActivate(makeContext({ authHeader: 'Bearer tenant-token', method: 'GET', path: '/orders' })),
    ).toThrow(ForbiddenException);
  });

  it('allows the tenant shell reads (/tenants/me) while mustChangePassword', () => {
    (jwtService.verify as jest.Mock).mockReturnValue({
      type: 'tenant',
      sub: 'u1',
      mustChangePassword: true,
    });
    expect(
      guard.canActivate(makeContext({ authHeader: 'Bearer tenant-token', method: 'GET', path: '/tenants/me' })),
    ).toBe(true);
  });

  it('allows tenant POST when mustChangePassword is false', () => {
    (jwtService.verify as jest.Mock).mockReturnValue({
      type: 'tenant',
      sub: 'u1',
      mustChangePassword: false,
    });
    expect(guard.canActivate(makeContext({ method: 'POST', path: '/products' }))).toBe(true);
  });

  it('throws ForbiddenException for tenant POST when mustChangePassword is true', () => {
    (jwtService.verify as jest.Mock).mockReturnValue({
      type: 'tenant',
      sub: 'u1',
      mustChangePassword: true,
    });
    expect(() =>
      guard.canActivate(makeContext({ authHeader: 'Bearer tenant-token', method: 'POST', path: '/products' })),
    ).toThrow(ForbiddenException);
  });

  it('allows tenant GET even when mustChangePassword is true', () => {
    (jwtService.verify as jest.Mock).mockReturnValue({
      type: 'tenant',
      sub: 'u1',
      mustChangePassword: true,
    });
    expect(
      guard.canActivate(makeContext({ authHeader: 'Bearer tenant-token', method: 'GET', path: '/products' })),
    ).toBe(true);
  });

  it('allows POST /auth/change-password even when mustChangePassword is true', () => {
    (jwtService.verify as jest.Mock).mockReturnValue({
      type: 'tenant',
      sub: 'u1',
      mustChangePassword: true,
    });
    expect(
      guard.canActivate(
        makeContext({ authHeader: 'Bearer tenant-token', method: 'POST', path: '/auth/change-password' }),
      ),
    ).toBe(true);
  });
});
