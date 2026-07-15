import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

function makeAuthService() {
  return {
    login: jest.fn().mockResolvedValue({ accessToken: 'tok' }),
    changePassword: jest.fn().mockResolvedValue({ accessToken: 'new-tok' }),
    getMe: jest.fn().mockResolvedValue({ email: 'u@farm.bg', role: 'admin', mustChangePassword: false, hiddenNav: [] }),
    updateHiddenNav: jest.fn().mockResolvedValue({ hiddenNav: ['/orders'] }),
  };
}

describe('AuthController — POST /auth/register no longer exists', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: makeAuthService() }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AuthController);
  });

  it('does not have a register method on the controller', () => {
    expect(typeof (controller as any).register).toBe('undefined');
  });

  it('has login, changePassword, getMe, and updateNav', () => {
    expect(typeof (controller as any).login).toBe('function');
    expect(typeof (controller as any).changePassword).toBe('function');
    expect(typeof (controller as any).getMe).toBe('function');
    expect(typeof (controller as any).updateNav).toBe('function');
  });

  it('updateNav forwards the hidden keys to the service', async () => {
    const svc = makeAuthService();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: svc }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const ctrl = module.get(AuthController);

    await (ctrl as any).updateNav('user-1', { hidden: ['/orders'] });

    expect(svc.updateHiddenNav).toHaveBeenCalledWith('user-1', ['/orders']);
  });
});

// Task C4 — GET /auth/me is the server-side auth gate every admin-panel page
// load hits (client/src/app/(admin)/layout.tsx); a driver login must not 403
// here or it gets bounced back to /login before any client-side route work runs.
describe('AuthController getMe role metadata', () => {
  it('allows admin, farmer, and driver', () => {
    expect(Reflect.getMetadata('roles', AuthController.prototype.getMe)).toEqual([
      'admin',
      'farmer',
      'driver',
    ]);
  });
});
