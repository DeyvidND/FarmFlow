import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EditSessionGuard } from './edit-session.guard';

const JWT = 'x'.repeat(40);
const config = { getOrThrow: () => JWT } as unknown as ConfigService;
const jwt = new JwtService({ secret: JWT, signOptions: { algorithm: 'HS256' } });
const guard = new EditSessionGuard(jwt, config);

function ctxWith(authHeader?: string) {
  const req: any = { headers: authHeader ? { authorization: authHeader } : {} };
  return { switchToHttp: () => ({ getRequest: () => req }), _req: req } as any;
}

describe('EditSessionGuard', () => {
  const sign = (claims: object, opts: object = {}) =>
    jwt.sign(claims, { secret: `${JWT}::siteedit`, ...opts });

  it('accepts a valid site-edit token and sets tenantId', async () => {
    const ctx = ctxWith(`Bearer ${sign({ sub: 't1', type: 'site-edit' })}`);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(ctx._req.tenantId).toBe('t1');
  });
  it('rejects a normal tenant JWT (wrong secret + type)', async () => {
    const normal = jwt.sign({ sub: 'u1', type: 'tenant' }); // main secret, not ::siteedit
    await expect(guard.canActivate(ctxWith(`Bearer ${normal}`))).rejects.toThrow(UnauthorizedException);
  });
  it('rejects wrong type even with the edit secret', async () => {
    await expect(guard.canActivate(ctxWith(`Bearer ${sign({ sub: 't1', type: 'reset' })}`))).rejects.toThrow();
  });
  it('rejects missing/expired token', async () => {
    await expect(guard.canActivate(ctxWith(undefined))).rejects.toThrow(UnauthorizedException);
    const expired = sign({ sub: 't1', type: 'site-edit' }, { expiresIn: '-1s' });
    await expect(guard.canActivate(ctxWith(`Bearer ${expired}`))).rejects.toThrow();
  });
});
